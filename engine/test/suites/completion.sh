#!/bin/bash

test_concurrent_settled_once() (
  setup_case concurrent
  concurrency_gate=""
  if [[ -n "${HERDR_MONITOR_CONCURRENCY_GATE_ROOT:-}" ]]; then
    mkdir -p "$HERDR_MONITOR_CONCURRENCY_GATE_ROOT"
    concurrency_gate="$HERDR_MONITOR_CONCURRENCY_GATE_ROOT/active"
    while ! mkdir "$concurrency_gate" 2>/dev/null; do
      sleep 0.05
    done
    trap 'rmdir "$concurrency_gate" 2>/dev/null || true' EXIT
  fi
  write_complete_transcript
  event_payload=$(payload)
  concurrent_count="${HERDR_CONCURRENT_COUNT:-32}"
  for index in $(seq 1 "$concurrent_count"); do
    HERDR_MONITOR_RESULT_FILE="$TMPDIR/concurrent-$index.result" \
      run_hook settled "$event_payload" &
  done
  wait
  first_result=$(find "$TMPDIR" -name 'concurrent-*.result' -type f \
    -exec head -n 1 {} \; 2>/dev/null | head -n 1)
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "$concurrent_count concurrent settled hooks (${first_result:-no result})"
  assert_eq settled "$(receipt_read_field 6)" "delivered terminal event"
  [[ -n "$(receipt_read_field 8)" ]] || fail "settled fingerprint is empty"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.lock" "concurrent lock cleanup"
)

test_missing_transcripts_and_stale_copilot() (
  setup_case missing-claude
  printf '%s\n' claude > "$FAKE_HERDR_CASE/kind"
  arm_completion_generation
  claude_path="$HOME/.claude/projects/session-1.jsonl"
  result_file="$TMPDIR/claude.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" \
    run_hook settled "$(payload_with_path "$claude_path")"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "Claude payload without transcript"
  assert_eq suppressed "$(cut -f 1 "$result_file")" "Claude result"
  assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
    "Claude missing transcript reason"

  setup_case missing-codex
  printf '%s\n' codex > "$FAKE_HERDR_CASE/kind"
  arm_completion_generation
  codex_path="$HOME/.codex/sessions/rollout-session-1.jsonl"
  result_file="$TMPDIR/codex.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" \
    run_hook settled "$(payload_with_path "$codex_path")"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "Codex payload without transcript"
  assert_eq suppressed "$(cut -f 1 "$result_file")" "Codex result"
  assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
    "Codex missing transcript reason"

  setup_case stale-copilot
  write_complete_transcript
  stale_path="$HOME/.copilot/session-state/other-session/events.jsonl"
  result_file="$TMPDIR/stale.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" \
    run_hook settled "$(payload_with_path "$stale_path")"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "stale Copilot transcript"
  assert_eq suppressed "$(cut -f 1 "$result_file")" "stale outcome"
  assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
    "stale reason"
)

test_terminal_dedup_across_nested_events() (
  setup_case nested-events
  write_complete_transcript
  event_payload=$(payload)
  run_hook settled "$event_payload"
  original_settled=$(receipt_read_field 8)
  run_hook input '{"title":"Approval","message":"Input needed"}'
  run_hook error '{"message":"Worker failed"}'
  run_hook lost '{}'
  assert_eq 4 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "nested nonterminal delivery"
  assert_eq "$original_settled" "$(receipt_read_field 8)" \
    "settled fingerprint preservation"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  result_output=$(bash "$orchestrator_script" result worker)
  [[ "$result_output" == *'ist fertig'* ]] ||
    fail "nonterminal event downgraded the completed cycle"
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  run_hook settled "$event_payload"
  assert_eq 4 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "identical settled after nested events"
  assert_eq duplicate-settled "$(receipt_read_field 11)" \
    "terminal duplicate reason"
)

test_structural_completion_proof_for_all_agents() (
  for kind in claude codex; do
    setup_case "completion-$kind"
    printf '%s\n' "$kind" > "$FAKE_HERDR_CASE/kind"
    if [[ "$kind" == "claude" ]]; then
      transcript=$(write_claude_transcript)
    else
      transcript=$(write_codex_transcript)
    fi
    arm_completion_generation
    remove_current_completion_proof
    result_file="$TMPDIR/no-proof.result"
    HERDR_MONITOR_RESULT_FILE="$result_file" \
      run_hook settled "$(payload_with_path "$transcript")"
    assert_eq suppressed "$(cut -f 1 "$result_file")" \
      "$kind intermediate outcome"
    assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
      "$kind intermediate reason"
    assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
      "$kind intermediate delivery"
    if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
      fail "$kind close accepted an unproven completion"
    fi

    write_current_completion_proof
    HERDR_MONITOR_RESULT_FILE="$result_file" \
      run_hook settled "$(payload_with_path "$transcript")"
    assert_eq delivered "$(cut -f 1 "$result_file")" \
      "$kind proven outcome"
    assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
      "$kind proven delivery"
    HERDR_MONITOR_RESULT_FILE="$result_file" \
      run_hook settled "$(payload_with_path "$transcript")"
    assert_eq suppressed "$(cut -f 1 "$result_file")" \
      "$kind duplicate outcome"
    assert_eq duplicate-settled "$(cut -f 2 "$result_file")" \
      "$kind duplicate reason"
    assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
      "$kind duplicate delivery"
  done

  setup_case missing-session
  write_complete_transcript
  printf '%s\n' __empty__ > "$FAKE_HERDR_CASE/session"
  result_file="$TMPDIR/missing-session.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" run_hook settled "$(payload)"
  assert_eq suppressed "$(cut -f 1 "$result_file")" \
    "missing session outcome"
  assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
    "missing session reason"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "missing session delivery"
)

test_no_completion_proof_preserves_generation() (
  setup_case proof-monitor
  printf '%s\n' claude > "$FAKE_HERDR_CASE/kind"
  write_claude_transcript >/dev/null
  arm_completion_generation stable-generation
  remove_current_completion_proof
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  for _ in $(seq 1 200); do
    [[ "$(receipt_read_field 11 2>/dev/null || true)" == "no-completion-proof" ]] &&
      break
    sleep 0.02
  done
  assert_eq no-completion-proof "$(receipt_read_field 11)" \
    "monitor intermediate suppression"
  assert_eq stable-generation "$(receipt_read_field 10)" \
    "suppressed generation"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 500); do
    (( $(call_count 'agent wait worker') >= 2 )) && break
    sleep 0.02
  done
  (( $(call_count 'agent wait worker') >= 2 )) ||
    fail "monitor did not establish the post-idle event wait"
  write_current_completion_proof
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 500); do
    [[ "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" == "1" ]] && break
    sleep 0.02
  done
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "proven completion after intermediate stop"
  assert_eq stable-generation "$(receipt_read_field 10)" \
    "completion generation after intermediate stop"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "proof monitor cleanup"
)

test_monitor_rearm_across_idle_and_fast_completion() (
  setup_case monitor-rearm-idle
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.proof.generation-one" "settlement consumed proof file"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 0.5
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  sleep 0.5
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 100); do
    [[ "$(receipt_read_field 2)" == "2" ]] && break
    sleep 0.02
  done
  assert_eq 2 "$(receipt_read_field 2)" "done-idle-working rearm"
  assert_eq generation:generation-one "$(receipt_read_field 8)" "same task retains delivered completion"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 250); do
    (( $(call_count '^agent wait worker') >= 4 )) && break
    sleep 0.02
  done
  assert_eq generation:generation-one "$(receipt_read_field 8)" "working-idle retains consumed proof evidence"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "idle rearm cleanup"
  bash "$orchestrator_script" close worker >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "completion remains usable for normal close"

  setup_case monitor-fast-completion
  write_complete_transcript
  run_hook settled "$(payload)"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 0.5
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 100); do
    [[ "$(receipt_read_field 2)" == "2" ]] && break
    sleep 0.02
  done
  assert_eq 2 "$(receipt_read_field 2)" "fast completion rearm"
  # Only an explicit assignment change, never native readiness, resets proof.
  source "$receipt_script"
  herdr_receipt_rearm "$HERDR_MONITOR_RECEIPT" followup generation-two
  assert_eq "" "$(receipt_read_field 8)" "explicit assignment clears prior completion"
  write_current_completion_proof
  append_user_message
  append_task_complete
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  run_hook settled "$(payload)"
  for _ in $(seq 1 100); do
    [[ "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" == "2" ]] && break
    sleep 0.02
  done
  assert_eq 2 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "fast completion across rearm"
  sleep 0.5
  assert_eq 2 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "fast completion duplicate guard"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "fast completion cleanup"
)

test_monitor_separates_readiness_completion_and_acceptance() (
  setup_case monitor-display
  write_complete_transcript
  HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
  run_file="$FAKE_HERDR_CASE/run.json"
  printf '%s\n' 'unreadable coordinator JSON must not erase local proof' > "$run_file"
  task_file="${HERDR_MONITOR_RECEIPT%.event}.task"
  generation=$(receipt_read_field 10)
  printf 'herdr-task/1\trunning\t%s\n' "$generation" > "$task_file"
  display_log="$FAKE_HERDR_CASE/display"
  HERDR_MONITOR_INBOX=1 HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$display_log" &
  monitor_pid=$!
  trap 'kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true' EXIT
  expect_display() {
    local expected attempt lines=4
    expected=$(printf 'agent: %s\ntask: %s\nproof: %s' "$1" "$2" "$3")
    if [[ -n "${4:-}" ]]; then expected+=$'\ncoordinator: unavailable'; lines=5; fi
    for attempt in $(seq 1 500); do
      [[ "$(tail -n "$lines" "$display_log")" != "$expected" ]] || return 0
      sleep 0.02
    done
    fail "missing monitor display: $expected; got $(tail -n 4 "$display_log")"
  }
  expect_display done review complete
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  expect_display idle review complete
  printf '%s\n' 'partial hint' > "$task_file"
  expect_display idle review complete unavailable
  # Coordinator-only changes must refresh without another agent transition.
  printf 'herdr-task/1\taccepted\t%s\n' "$generation" > "$task_file"
  expect_display idle accepted complete
  printf 'herdr-task/1\tswitching\t%s\n' "$generation" > "$task_file"
  expect_display idle switching pending
  # Reusing a pane must not label the old generation's receipt as new proof.
  printf 'herdr-task/1\tstarting\t%s\n' "$generation" > "$task_file"
  expect_display idle starting pending
  printf 'herdr-task/1\trunning\tnext-generation\n' > "$task_file"
  expect_display idle awaiting-proof pending
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  expect_display working running pending
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  trap - EXIT
  assert_no_fake_waiters "monitor display cleanup"
)

test_completion_report_survives_later_lifecycle_events() (
  for format in current legacy; do
    setup_case "completion-report-$format"
    write_complete_transcript
    HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
    if [[ "$format" == legacy ]]; then
      jq 'del(.completion)' "${HERDR_MONITOR_RECEIPT}.inbox" > "$TMPDIR/legacy-inbox"
      mv "$TMPDIR/legacy-inbox" "${HERDR_MONITOR_RECEIPT}.inbox"
    fi
    printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
    HERDR_MONITOR_INBOX=1 run_hook input '{"message":"UNRELATED_PERMISSION_QUESTION"}'
    assert_eq input "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "input remains actionable"
    for event in error lost; do
      HERDR_MONITOR_INBOX=1 run_hook "$event" '{"message":"Later event"}'
      assert_eq "$event" "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "$event remains actionable"
      assert_eq 'complete' "$(jq -r '.completion.detail' "${HERDR_MONITOR_RECEIPT}.inbox")" "$format result survives $event"
      assert_eq generation-one "$(jq -r '.completion.generation' "${HERDR_MONITOR_RECEIPT}.inbox")" "$format report bound to generation"
    done
    printf '%s\n' done > "$FAKE_HERDR_CASE/status"
    HERDR_MONITOR_INBOX=1 run_hook settled '{"last_assistant_message":"Later screen, not original report"}'
    assert_eq 'complete' "$(jq -r '.completion.detail' "${HERDR_MONITOR_RECEIPT}.inbox")" "duplicate settled cannot overwrite report"
    arm_completion_generation generation-two
    HERDR_MONITOR_INBOX=1 run_hook input '{"message":"New task approval"}'
    assert_eq null "$(jq -r '.completion' "${HERDR_MONITOR_RECEIPT}.inbox")" "new generation excludes old result"
    jq '.generation="generation-two"' "${HERDR_MONITOR_RECEIPT%.event}.json" > "$TMPDIR/registry"
    mv "$TMPDIR/registry" "${HERDR_MONITOR_RECEIPT%.event}.json"
    append_user_message
    jq -nc '{type:"session.task_complete",data:{summary:"NEW_COMPLETION"}}' >> "$(transcript_path)"
    HERDR_MONITOR_INBOX=1 run_hook settled '{"session_id":"session-1","last_assistant_message":"NEW_COMPLETION"}'
    assert_eq NEW_COMPLETION "$(jq -r '.completion.detail' "${HERDR_MONITOR_RECEIPT}.inbox")" "new generation owns new report"
  done
)

test_completion_truncation_distinguishes_summary_from_result() (
  for source in payload native; do
    for size in 1000 3500 3501; do
      setup_case "completion-truncation-$source-$size"
      write_complete_transcript
      report=$(jq -nr --argjson size "$size" '"x" * $size')
      jq -nc --arg text "$report" '{type:"session.task_complete",data:{summary:$text}}' >> "$(transcript_path)"
      if [[ "$source" == native ]]; then
        report_payload='{}'
      else
        report_payload='{"session_id":"session-1","last_assistant_message":"STALE_PAYLOAD"}'
      fi
      HERDR_MONITOR_INBOX=1 run_hook settled "$report_payload"
      expected=false
      if (( size > 3500 )); then expected=true; fi
      assert_eq true "$(jq -r '.truncated' "${HERDR_MONITOR_RECEIPT}.inbox")" "$source summary shortened"
      assert_eq "$expected" "$(jq -r '.completion.truncated' "${HERDR_MONITOR_RECEIPT}.inbox")" "$source saved result truncation at $size"
      assert_eq "$((size > 3500 ? 3500 : size))" "$(jq '.completion.detail | length' "${HERDR_MONITOR_RECEIPT}.inbox")" "$source retained detail length"
    done
  done
)

test_idle_completion_is_collected() (
  setup_case idle-completion
  write_complete_transcript
  write_worker_registry
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  HERDR_MONITOR_INBOX=1 HERDR_MONITOR_CHANGE_WAIT_TICKS=2 \
    bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  wait_for_file "${HERDR_MONITOR_RECEIPT}.inbox" || fail "idle completion was never collected"
  # Inbox publication precedes receipt acknowledgement. Wait for the actual
  # condition, not a sibling file (especially under concurrent test load).
  for _ in $(seq 1 250); do
    [[ "$(receipt_read_field 4)" == "delivered" ]] && break
    sleep 0.02
  done
  assert_eq delivered "$(receipt_read_field 4)" "idle completion receipt"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "idle completion cleanup"
)

test_claude_report_survives_receipt_ack_but_not_new_task() (
  setup_case claude-report
  printf '%s\n' claude > "$FAKE_HERDR_CASE/kind"
  transcript="$HOME/.claude/projects/session-1.jsonl"
  printf '%s\n' \
    '{"type":"user","message":{"content":"current task"}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"task: current\nchecks: PASS"}]}}' \
    '{"type":"user","message":{"content":[{"type":"tool_result","content":"receipt written"}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Receipt written; see above."}]}}' > "$transcript"
  result=$(HERDR_MONITOR_RENDER_ONLY=1 bash "$hook_script" settled '{}')
  [[ "$result" == *"checks: PASS"* ]] || fail "structured result lost behind receipt acknowledgement"
  printf '%s\n' \
    '{"type":"user","message":{"content":[{"type":"text","text":"new task"}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"New task result"}]}}' >> "$transcript"
  result=$(HERDR_MONITOR_RENDER_ONLY=1 bash "$hook_script" settled '{}')
  [[ "$result" == *"New task result"* && "$result" != *"checks: PASS"* ]] || fail "old task report leaked into new task"
)

test_compact_completion_command_handles_quoted_paths() (
  setup_case compact-proof
  source "$receipt_script"
  proof_receipt="$TMPDIR/space and 'quote.event"
  command=$(herdr_append_completion_instruction task "$proof_receipt" testgen | tail -n 1)
  bash -c "$command"
  assert_eq testgen "$(< "$proof_receipt.proof.testgen")" "compact proof content"
  assert_file_absent "$proof_receipt.proof.testgen.tmp" "atomic temporary proof"
)

test_unknown_readiness_preserves_generation_bound_completion() (
  for status in unknown __empty__ working blocked; do
    setup_case "completion-state-$status"
    write_complete_transcript
    printf '%s\n' "$status" > "$FAKE_HERDR_CASE/status"
    HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
    if [[ "$status" == working || "$status" == blocked ]]; then
      assert_file_absent "${HERDR_MONITOR_RECEIPT}.inbox" "active/UI state cannot settle"
    else
      assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "unknown readiness does not discard proof"
    fi
  done
  setup_case input-wins-over-quota
  printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "You've hit your limit" > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook input '{"message":"Permission required"}'
  assert_eq input "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "native input event wins"
  assert_eq null "$(jq -r '.quota' "${HERDR_MONITOR_RECEIPT}.inbox")" "input is not quota"
)

test_cursor_completion_requires_registered_identity_and_proof() (
  for scenario in complete missing-proof wrong-proof changed-session changed-terminal changed-generation missing-registry working blocked unknown; do
    setup_case "cursor-$scenario"
    printf '%s\n' cursor > "$FAKE_HERDR_CASE/kind"
    arm_completion_generation
    write_worker_registry
    registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
    jq '.native_identity={terminal:"terminal-1",session:"session-1"}' "$registry" > "$TMPDIR/registry"
    mv "$TMPDIR/registry" "$registry"
    printf '%s\n' 'task: cursor-check' 'checks: passed' > "$FAKE_HERDR_CASE/visible"
    case "$scenario" in
      missing-proof) remove_current_completion_proof ;;
      wrong-proof) printf '%s\n' old-generation > "${HERDR_MONITOR_RECEIPT}.proof.generation-one" ;;
      changed-session) printf '%s\n' session-2 > "$FAKE_HERDR_CASE/session" ;;
      changed-terminal) printf '%s\n' terminal-2 > "$FAKE_HERDR_CASE/terminal" ;;
      changed-generation) jq '.generation="other"' "$registry" > "$TMPDIR/registry"; mv "$TMPDIR/registry" "$registry" ;;
      missing-registry) rm "$registry" ;;
      working|blocked|unknown) printf '%s\n' "$scenario" > "$FAKE_HERDR_CASE/status" ;;
    esac
    HERDR_TEST_NO_REGISTRY=1 HERDR_MONITOR_INBOX=1 run_hook settled '{}'
    if [[ "$scenario" == complete ]]; then
      assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "Cursor completion without private transcript"
      assert_eq true "$(jq -r '.completion.truncated' "${HERDR_MONITOR_RECEIPT}.inbox")" "Cursor excerpt never claims full transcript"
      [[ "$(jq -r '.detail' "${HERDR_MONITOR_RECEIPT}.inbox")" == *'checks: passed'* ]] || fail 'Cursor visible report missing'
      HERDR_MONITOR_INBOX=1 run_hook settled '{}'
      assert_eq generation:generation-one "$(receipt_read_field 8)" "Cursor proof survives duplicate settlement"
    else
      assert_file_absent "${HERDR_MONITOR_RECEIPT}.inbox" "Cursor $scenario cannot settle"
    fi
  done
)

test_generic_integration_completion_requires_identity_and_proof() (
  for scenario in complete missing-proof missing-session changed-session changed-terminal changed-generation working; do
    setup_case "integration-$scenario"
    printf '%s\n' opencode > "$FAKE_HERDR_CASE/kind"
    arm_completion_generation
    write_worker_registry
    registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
    jq '.native_identity={terminal:"terminal-1",session:"session-1"}' "$registry" > "$TMPDIR/registry"
    mv "$TMPDIR/registry" "$registry"
    printf '%s\n' 'task: native-check' 'checks: passed' > "$FAKE_HERDR_CASE/visible"
    case "$scenario" in
      missing-proof) remove_current_completion_proof ;;
      missing-session) jq '.native_identity.session=null' "$registry" > "$TMPDIR/registry"; mv "$TMPDIR/registry" "$registry" ;;
      changed-session) printf '%s\n' session-2 > "$FAKE_HERDR_CASE/session" ;;
      changed-terminal) printf '%s\n' terminal-2 > "$FAKE_HERDR_CASE/terminal" ;;
      changed-generation) jq '.generation="other"' "$registry" > "$TMPDIR/registry"; mv "$TMPDIR/registry" "$registry" ;;
      working) printf '%s\n' working > "$FAKE_HERDR_CASE/status" ;;
    esac
    HERDR_MONITOR_INBOX=1 run_hook settled '{}'
    if [[ "$scenario" == complete ]]; then
      assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "generic integration completion"
      assert_eq true "$(jq -r '.completion.truncated' "${HERDR_MONITOR_RECEIPT}.inbox")" "generic visible report is bounded"
      [[ "$(jq -r '.detail' "${HERDR_MONITOR_RECEIPT}.inbox")" == *'checks: passed'* ]] || fail 'generic integration visible report missing'
    else
      assert_file_absent "${HERDR_MONITOR_RECEIPT}.inbox" "generic integration $scenario cannot settle"
    fi
  done
)

test_codex_custom_home_completion_survives_split_monitor_environment() (
  setup_case codex-custom-home-completion
  export CODEX_HOME="$FAKE_HERDR_CASE/configured-codex-home"
  mkdir -p "$CODEX_HOME/sessions"
  printf '%s\n' 'bounded custom-home task' > "$TMPDIR/prompt"
  HERDR_MONITOR_INBOX=1 bash "$worker_script" --name worker --kind codex --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$TMPDIR/prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/startup"
  generation=$(jq -r '.generation' "$HERDR_RECEIPT_ROOT/ws/worker.json")
  jq -nc --arg generation "$generation" \
    '{type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:("bounded task .proof." + $generation)}]}},
     {type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"CUSTOM_HOME_REPORT"}]}}' \
    > "$CODEX_HOME/sessions/rollout-session-1.jsonl"
  write_current_completion_proof
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  HERDR_MONITOR_INBOX=1 run_hook settled '{}'
  assert_file_present "${HERDR_MONITOR_RECEIPT}.inbox" 'native hook finds configured Codex home'
  assert_eq CUSTOM_HOME_REPORT "$(jq -r '.completion.detail' "${HERDR_MONITOR_RECEIPT}.inbox")" 'native hook current report'
  # Re-arm the same fixture generation to exercise collection by a split
  # monitor launched with the server environment instead of the worker home.
  arm_completion_generation "$generation"
  rm "${HERDR_MONITOR_RECEIPT}.inbox"
  monitor_command=$(< "$FAKE_HERDR_CASE/monitor-command")
  CODEX_HOME="$FAKE_HERDR_CASE/server-codex-home" HERDR_MONITOR_CHANGE_WAIT_TICKS=2 \
    bash -c "exec ${monitor_command#* }" > "$TMPDIR/monitor-output" &
  monitor_pid=$!
  trap 'kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true' EXIT
  wait_for_file "${HERDR_MONITOR_RECEIPT}.inbox" || fail 'split monitor lost configured Codex home'
  assert_eq CUSTOM_HOME_REPORT "$(jq -r '.completion.detail' "${HERDR_MONITOR_RECEIPT}.inbox")" 'split monitor current report'
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  trap - EXIT
)

test_transcript_completion_rejects_stale_provenance() (
  for kind in claude codex copilot; do
    for change in path session terminal generation missing-registry missing-identity payload stale-payload; do
      setup_case "stale-$kind-$change"
      printf '%s\n' "$kind" > "$FAKE_HERDR_CASE/kind"
      case "$kind" in
        claude) transcript=$(write_claude_transcript); arm_completion_generation ;;
        codex) transcript=$(write_codex_transcript); arm_completion_generation ;;
        copilot) write_complete_transcript; transcript=$(transcript_path) ;;
      esac
      write_worker_registry
      registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
      jq '.native_identity={terminal:"terminal-1",session:"session-1"}' "$registry" > "$TMPDIR/registry"
      mv "$TMPDIR/registry" "$registry"
      case "$change" in
        path)
          printf '%s\n' session-2 > "$FAKE_HERDR_CASE/session"
          jq '.native_identity.session="session-2"' "$registry" > "$TMPDIR/registry"
          mv "$TMPDIR/registry" "$registry" ;;
        session|terminal) printf '%s\n' replacement > "$FAKE_HERDR_CASE/$change" ;;
        generation) jq '.generation="other"' "$registry" > "$TMPDIR/registry"; mv "$TMPDIR/registry" "$registry" ;;
        missing-registry) rm "$registry" ;;
        missing-identity) jq 'del(.native_identity)' "$registry" > "$TMPDIR/registry"; mv "$TMPDIR/registry" "$registry" ;;
      esac
      report_payload=$(payload_with_path "$transcript")
      if [[ "$change" == stale-payload ]]; then report_payload=$(jq '.session_id="old-session"' <<<"$report_payload"); fi
      HERDR_TEST_NO_REGISTRY=1 HERDR_MONITOR_INBOX=1 run_hook settled "$report_payload"
      if [[ "$change" == payload || "$change" == stale-payload ]]; then
        assert_file_present "${HERDR_MONITOR_RECEIPT}.inbox" "$kind current transcript accepted"
        if rg -q 'native completion without transcript' "${HERDR_MONITOR_RECEIPT}.inbox"; then
          fail "$kind trusted unbound payload report"
        fi
      else
        assert_file_absent "${HERDR_MONITOR_RECEIPT}.inbox" "$kind $change cannot publish completion"
      fi
    done
  done
)
