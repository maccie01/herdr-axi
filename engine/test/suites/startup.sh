#!/bin/bash

test_prompt_delivery_for_all_agent_kinds() (
  for kind in copilot claude codex cursor opencode; do
    setup_case "prompt-$kind"
    model_args=()
    if [[ "$kind" == cursor ]]; then model_args=(--model composer-2.5 --effort model)
    elif [[ "$kind" != opencode ]]; then model_args=(--effort high)
    fi
    printf '%s\n' success > "$FAKE_HERDR_CASE/worker-prompt-mode"
    worker_prompt="$FAKE_HERDR_CASE/worker.txt"
    printf '%s\n' "prompt for $kind" > "$worker_prompt"
    worker_output=$(bash "$worker_script" \
      --name worker \
      --kind "$kind" \
      ${model_args[@]+"${model_args[@]}"} \
      --cwd "$FAKE_HERDR_CASE" \
      --prompt-file "$worker_prompt" \
      --workspace ws \
      --orchestrator-agent orch)
    expected_mode=auto
    expected_verified=false
    case "$kind" in copilot) expected_mode=autopilot ;; codex) expected_mode=approve-for-me ;; claude) expected_verified=true ;; cursor) expected_mode=auto-review ;; *) expected_mode=native ;; esac
    assert_eq "$expected_mode" "$(jq -r '.permission_mode' <<< "$worker_output")" "$kind reported launch mode"
    assert_eq "$expected_verified" "$(jq -r '.permission_mode_verified' <<< "$worker_output")" "$kind honest runtime verification"
    assert_eq 0 "$(call_count 'agent send-keys worker enter')" \
      "$kind no explicit Enter after native delivery"
    assert_eq 0 "$(call_count 'pane wait-output pane-1')" \
      "$kind has no prompt-glyph dependency"
    assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
      "$kind successful worker tab"
    assert_file_present "$FAKE_HERDR_CASE/monitor-command" \
      "$kind successful monitor"
  done

  for failure_mode in slow-start stalled-visible stalled-hidden blocked; do
    setup_case "prompt-failure-$failure_mode"
    printf '%s\n' "$failure_mode" > "$FAKE_HERDR_CASE/worker-prompt-mode"
    worker_prompt="$FAKE_HERDR_CASE/worker.txt"
    printf '%s\n' "must roll back" > "$worker_prompt"
    if bash "$worker_script" \
      --name worker \
      --kind claude \
      --cwd "$FAKE_HERDR_CASE" \
      --prompt-file "$worker_prompt" \
      --workspace ws \
      --orchestrator-agent orch >/dev/null 2>&1; then
      fail "$failure_mode prompt unexpectedly succeeded"
    fi
    assert_eq 0 "$(call_count 'agent send-keys worker enter')" \
      "$failure_mode fail-closed delivery sends no keys"
    case "$failure_mode" in blocked) expected_stage=rejected ;; *) expected_stage=stalled ;; esac
    assert_eq "$expected_stage" "$(jq -r '.stage' "$HERDR_RECEIPT_ROOT/ws/worker.json")" \
      "$failure_mode durable delivery stage"
    if [[ "$failure_mode" == slow-start ]]; then
      assert_file_present "$FAKE_HERDR_CASE/start-on-read" \
        "stalled delivery is not inferred from later screen state"
    fi
    assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
      "$failure_mode uncertain prompt preserves work"
    assert_eq 0 "$(call_count 'tab close tab-1')" \
      "$failure_mode tab close count"
    assert_file_present "$FAKE_HERDR_CASE/monitor-command" \
      "$failure_mode retained monitor"
    assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" \
      "$failure_mode retained ownership"
  done
)

test_event_bounded_pane_readiness() (
  setup_case pane-readiness
  printf '%s\n' 0.20 > "$FAKE_HERDR_CASE/pane-ready-delay"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "wait for shell" > "$worker_prompt"
  bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null
  assert_eq 0 "$(call_count 'pane wait-output pane-1')" \
    "native readiness without prompt-glyph guessing"
  assert_eq 1 "$(call_count 'agent start worker')" \
    "start after delayed readiness"

  setup_case pane-retries
  printf '%s\n' 2 > "$FAKE_HERDR_CASE/start-busy-count"
  printf '%s\n' 0.05 > "$FAKE_HERDR_CASE/pane-ready-delay"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "retry after event" > "$worker_prompt"
  bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null
  assert_eq 0 "$(call_count 'pane wait-output pane-1')" \
    "native readiness owns retries"
  assert_eq 3 "$(call_count 'agent start worker')" \
    "preserved start attempt count"

  setup_case pane-failure
  export HERDR_START_READY_TIMEOUT_SECONDS=1
  : > "$FAKE_HERDR_CASE/pane-wait-fail"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "never start" > "$worker_prompt"
  if bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null 2>&1; then
    fail "worker started without pane readiness"
  fi
  (( $(call_count 'agent start worker') > 0 )) || fail "missing native availability probe"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "pane readiness rollback"

  setup_case start-retry-failure
  printf '%s\n' 100 > "$FAKE_HERDR_CASE/start-busy-count"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "never registers" > "$worker_prompt"
  if bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null 2>&1; then
    fail "worker succeeded with a permanently busy pane"
  fi
  (( $(call_count 'agent start worker') <= 8 )) || fail "unbounded startup retries"
  assert_eq 0 "$(call_count 'pane wait-output pane-1')" \
    "failed native start has no glyph wait"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "failed start rollback"
  assert_file_absent "$FAKE_HERDR_CASE/monitor-command" \
    "failed start unregistered monitor"
)

test_rejected_prompt_reuses_monitor_and_cannot_replay_ambiguous_delivery() (
  setup_case rejected-prompt
  export HERDR_AXI_MANAGED_TASK=1
  prompt_file="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded task" > "$prompt_file"
  printf '%s\n' blocked > "$FAKE_HERDR_CASE/worker-prompt-mode"
  if bash "$orchestrator_script" start --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$prompt_file" --workspace ws --orchestrator-agent orch >/dev/null 2>&1; then fail "blocked prompt claimed submission"; fi
  registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
  assert_eq rejected "$(jq -r '.stage' "$registry")" "definite rejection durable"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "blocked rejects before input"
  generation=$(jq -r '.generation' "$registry")
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  printf '%s\n' stalled-hidden > "$FAKE_HERDR_CASE/worker-prompt-mode"
  if bash "$orchestrator_script" retry worker --prompt-file "$prompt_file" >/dev/null 2>&1; then fail "ambiguous retry claimed success"; fi
  assert_eq stalled "$(jq -r '.stage' "$registry")" "ambiguous retry fails closed as stalled"
  assert_eq "$generation" "$(jq -r '.previous_generation' "$registry")" "retry linked generation"
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "one actual delivery"
  if bash "$orchestrator_script" retry worker --prompt-file "$prompt_file" >/dev/null 2>&1; then fail "ambiguous delivery was replayable"; fi
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "second retry sends nothing"
  assert_eq 1 "$(call_count '^pane split ')" "existing monitor retained"
  assert_eq 1 "$(call_count '^tab create ')" "existing tab retained"
)

test_worker_prompt_failure_is_not_success() (
  setup_case worker-prompt-failure
  write_complete_transcript
  : > "$FAKE_HERDR_CASE/worker-prompt-fail"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "must fail" > "$worker_prompt"
  if bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null 2>&1; then
    fail "worker reported success after prompt failure"
  fi
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" \
    "failed worker prompt count"
)

test_managed_inbox_never_prompts_owner() (
  setup_case managed-inbox
  write_complete_transcript
  HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "inbox owner interruptions"
  assert_file_present "${HERDR_MONITOR_RECEIPT}.inbox" "durable inbox"
  assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "inbox event"
  assert_eq "$(receipt_read_field 10)" "$(jq -r '.generation' "${HERDR_MONITOR_RECEIPT}.inbox")" "inbox generation"
  [[ "$(jq '.summary | length' "${HERDR_MONITOR_RECEIPT}.inbox")" -le 600 ]] || fail "unbounded inbox"
  assert_eq delivered "$(receipt_read_field 4)" "inbox receipt completion"
)

test_monitor_start_ack_required_before_prompt() (
  setup_case monitor-start-ack
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' 'bounded task' > "$worker_prompt"
  : > "$FAKE_HERDR_CASE/monitor-no-start"
  if HERDR_MONITOR_READY_TIMEOUT_SECONDS=1 bash "$worker_script" --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/output" 2>&1; then
    fail "missing monitor acknowledgement reported successful startup"
  fi
  rg -q MONITOR_START_UNVERIFIED "$TMPDIR/output" || fail "missing startup diagnostic"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.monitor-ready" \
    "timed-out startup does not leave the marker behind"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "unmonitored worker receives no task"
  assert_eq 0 "$(call_count '^tab close')" "uncertain monitor startup retains owned topology"
  registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
  assert_eq created "$(jq -r '.stage' "$registry")" "not-submitted startup stage"
  assert_eq monitor-1 "$(jq -r '.monitor_pane' "$registry")" "monitor registered before acknowledgement"
  rg -q '^pane split .*--env DISABLE_AUTO_UPDATE=true' "$FAKE_HERDR_CASE/calls" || fail "split can consume command in update prompt"
  if bash "$worker_script" --resume --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/retry" 2>&1; then
    fail "uncertain monitor startup allowed duplicate resume"
  fi
  assert_eq 1 "$(call_count '^pane split')" "resume cannot create duplicate monitor"
  assert_eq 1 "$(call_count '^pane run')" "resume cannot resend command into unknown foreground UI"
)

test_prompt_ack_and_no_nested_agents() (
  setup_case prompt-ack
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded task" > "$worker_prompt"
  bash "$worker_script" --name worker --kind codex --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch --label 'Byte review · codex' >/dev/null
  assert_eq 'Byte review · codex' "$(< "$FAKE_HERDR_CASE/tab-label")" "readable tab label"
  rg -q -- '--env DISABLE_AUTO_UPDATE=true' "$FAKE_HERDR_CASE/calls" || fail "worker shell may consume startup command in update prompt"
  rg -q -- '--wait --until working --until blocked --timeout 15000' "$FAKE_HERDR_CASE/calls" || fail "startup waits for observed delivery activity"
  rg -q 'Do not start subagents' "$FAKE_HERDR_CASE/visible" || fail "nested workers not prohibited"
  rg -q -- '--ratio 0.75' "$FAKE_HERDR_CASE/calls" || fail "worker layout not 75/25"
  rg -q 'concise TOON' "$FAKE_HERDR_CASE/visible" || fail "TOON contract missing"
  rg -q -- '--approve-for-me' "$FAKE_HERDR_CASE/calls" || fail "Codex review policy missing"
  if rg -q -- '--sandbox' "$FAKE_HERDR_CASE/calls"; then fail "incompatible Codex flags"; fi
  assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" "startup ownership registry"
)

test_claude_startup_requires_verified_auto_mode() (
  setup_case claude-unsupported-model
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded implementation" > "$worker_prompt"
  if bash "$worker_script" --name worker --kind claude --model haiku --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/result" 2>&1; then
    fail "unsupported manual-fallback model accepted"
  fi
  assert_eq 0 "$(call_count '^tab create')" "invalid model rejected before allocation"
  rg -q AUTO_MODE_UNSUPPORTED "$TMPDIR/result" || fail "missing model policy error"
  for mode in auto slow-auto manual unknown delayed-auto delayed-manual slow-manual; do
    setup_case "claude-mode-$mode"
    printf '%s\n' claude > "$FAKE_HERDR_CASE/kind"
    case "$mode" in
      manual|delayed-manual|slow-manual) printf '%s\n' '❯' '⏵⏵ accept edits on (shift+tab to cycle)' > "$FAKE_HERDR_CASE/startup-screen" ;;
      unknown) printf '%s\n' 'Starting Claude...' > "$FAKE_HERDR_CASE/startup-screen" ;;
    esac
    [[ "$mode" != delayed-* ]] || : > "$FAKE_HERDR_CASE/delayed-footer"
    [[ "$mode" != slow-* ]] || printf '%s\n' 4 > "$FAKE_HERDR_CASE/delayed-footer"
    worker_prompt="$FAKE_HERDR_CASE/worker.txt"
    printf '%s\n' "bounded implementation" > "$worker_prompt"
    if bash "$worker_script" --name worker --kind claude --cwd "$FAKE_HERDR_CASE" \
      --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/result" 2>&1; then
      [[ "$mode" == auto || "$mode" == delayed-auto || "$mode" == slow-auto ]] || fail "work submitted in $mode mode"
      assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "verified auto gets one prompt"
      [[ "$mode" != auto ]] || assert_eq 1 "$(call_count '^agent read')" "ready auto has no retry"
      [[ "$mode" != slow-auto ]] || assert_eq 5 "$(call_count '^agent read')" "slow footer accepted without resubmission"
    else
      [[ "$mode" != auto && "$mode" != delayed-auto && "$mode" != slow-auto ]] || fail "auto startup refused: $(< "$TMPDIR/result")"
      case "$mode" in
        manual) assert_eq 1 "$(call_count '^agent read')" "manual fails immediately" ;;
        delayed-manual) assert_eq 2 "$(call_count '^agent read')" "manual after rendering fails immediately" ;;
        slow-manual) assert_eq 5 "$(call_count '^agent read')" "slow manual never receives assignment" ;;
        unknown) assert_eq 6 "$(call_count '^agent read')" "missing footer retry budget" ;;
      esac
      assert_file_present "$FAKE_HERDR_CASE/tab-alive" "$mode startup retained for inspection"
      assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "$mode gets no assignment"
      assert_eq 0 "$(call_count '^pane split')" "$mode creates no unnecessary monitor"
      rg -q 'MODE_UNSUPPORTED|MODE_UNVERIFIED' "$TMPDIR/result" || fail "missing actionable mode error"
      # Recover/resume must check the observed mode too; merely idle is not enough.
      if bash "$worker_script" --resume --name worker --kind claude --cwd "$FAKE_HERDR_CASE" \
        --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/resume" 2>&1; then
        fail "$mode bypassed mode check on resume"
      fi
      assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "$mode resume still sends no work"
      assert_eq 1 "$(call_count '^tab create')" "$mode resume reuses owned tab"
    fi
  done
)

test_missing_integration_fails_before_worker_allocation() (
  setup_case missing-integration
  printf '%s\n' opencode > "$FAKE_HERDR_CASE/missing-integration"
  printf '%s\n' 'must not start' > "$FAKE_HERDR_CASE/prompt"
  if bash "$worker_script" --name worker --kind opencode --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$FAKE_HERDR_CASE/prompt" --workspace ws --orchestrator-agent orch \
    > "$TMPDIR/output" 2>&1; then
    fail 'missing integration started a worker'
  fi
  rg -q INTEGRATION_NOT_INSTALLED "$TMPDIR/output" || fail 'missing integration diagnostic absent'
  assert_eq 0 "$(call_count '^tab create')" 'missing integration allocates no tab'
  assert_file_absent "$FAKE_HERDR_CASE/monitor-command" 'missing integration allocates no monitor'
)

test_native_hooks_switch_controls_provider_hook_flags() (
  local kind setting expected
  for kind in claude copilot codex; do
    for setting in 1 0; do
      setup_case "native-hooks-$kind-$setting"
      printf '%s\n' success > "$FAKE_HERDR_CASE/worker-prompt-mode"
      printf '%s\n' "prompt for $kind" > "$FAKE_HERDR_CASE/worker.txt"
      HERDR_AXI_NATIVE_HOOKS=$setting bash "$worker_script" --name worker --kind "$kind" --effort high \
        --cwd "$FAKE_HERDR_CASE" --prompt-file "$FAKE_HERDR_CASE/worker.txt" --workspace ws --orchestrator-agent orch >/dev/null
      expected=$(( setting == 1 ? 1 : 0 ))
      assert_eq "$expected" "$(call_count '^agent start .*\(--plugin-dir\|notify=\)')" "$kind native hooks=$setting"
    done
  done
)

test_repair_and_experimental_integrations_fail_before_allocation() (
  local kind record
  for kind in opencode letta; do
    setup_case "unavailable-$kind"
    if [[ "$kind" == opencode ]]; then record='opencode: needs repair (v12) (/fixture)'
    else record='letta (experimental): current (v1) (/fixture)'; fi
    printf '%s\n' "$record" > "$FAKE_HERDR_CASE/integration-status"
    printf '%s\n' 'must not start' > "$FAKE_HERDR_CASE/prompt"
    if HERDR_AXI_ENGINE_PROTOCOL=1 bash "$worker_script" --name worker --kind "$kind" --cwd "$FAKE_HERDR_CASE" \
      --prompt-file "$FAKE_HERDR_CASE/prompt" --workspace ws --orchestrator-agent orch \
      3> "$TMPDIR/frame" > "$TMPDIR/output" 2>&1; then
      fail 'unavailable integration started a worker'
    fi
    jq -e '.code == "INTEGRATION_NOT_INSTALLED" and .submitted == false' "$TMPDIR/frame" >/dev/null || fail 'unsubmitted failure frame absent'
    rg -q 'needs repair|experimental' "$TMPDIR/output" || fail 'inventory reason absent'
    assert_eq 0 "$(call_count '^tab create')" 'unavailable integration allocates no tab'
    assert_file_absent "$FAKE_HERDR_CASE/monitor-command" 'unavailable integration allocates no monitor'
  done
)

test_codex_initialization_turn_precedes_exactly_one_assignment() (
  setup_case codex-bootstrap-success
  printf '%s\n' codex > "$FAKE_HERDR_CASE/kind"
  printf '%s\n' __empty__ > "$FAKE_HERDR_CASE/session"
  printf '%s\n' success > "$FAKE_HERDR_CASE/codex-bootstrap-mode"
  printf '%s\n' 'ACTUAL_ASSIGNMENT_SENTINEL' > "$TMPDIR/prompt"
  if ! HERDR_SESSION_READY_TIMEOUT_SECONDS=1 HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS=2 \
    bash "$orchestrator_script" start --name worker --kind codex --cwd "$FAKE_HERDR_CASE" \
      --prompt-file "$TMPDIR/prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/output" 2>&1; then
    fail "native first-turn session deadlocked: $(< "$TMPDIR/output")"
  fi
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/bootstrap-prompts")" 'one initialization turn'
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" 'one actual assignment'
  if rg -q 'ACTUAL_ASSIGNMENT_SENTINEL|\.proof\.' "$FAKE_HERDR_CASE/bootstrap-input"; then fail 'initialization included assignment or proof'; fi
  assert_eq settled "$(jq -r '.bootstrap.state' "$HERDR_RECEIPT_ROOT/ws/worker.json")" 'initialization journal settled'
)

test_recovered_mode_check_cannot_label_later_failure_unsubmitted() (
  setup_case recovered-mode-protocol
  printf '%s\n' claude > "$FAKE_HERDR_CASE/kind"
  : > "$FAKE_HERDR_CASE/delayed-footer"
  : > "$FAKE_HERDR_CASE/fail-identity-after-prompt"
  printf '%s\n' 'bounded task' > "$TMPDIR/prompt"
  if HERDR_AXI_ENGINE_PROTOCOL=1 bash "$worker_script" --name worker --kind claude \
    --cwd "$FAKE_HERDR_CASE" --prompt-file "$TMPDIR/prompt" --workspace ws --orchestrator-agent orch \
    3> "$TMPDIR/protocol" > "$TMPDIR/output" 2>&1; then fail 'post-prompt identity failure accepted'; fi
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" 'task actually submitted after recovered footer'
  jq -se 'all(.[]; .submitted != false)' "$TMPDIR/protocol" >/dev/null ||
    fail 'recovered pre-submit error mislabels post-submit failure'
)

test_session_readiness_retries_observation_but_not_drift() (
  for mode in transient drift resumed-session; do
    setup_case "session-readiness-$mode"
    arm_completion_generation
    write_worker_registry
    registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
    if [[ "$mode" != resumed-session ]]; then
      jq 'del(.native_identity)' "$registry" > "$TMPDIR/registry"
      mv "$TMPDIR/registry" "$registry"
    fi
    source "$receipt_script"
    herdr() {
      local count terminal=terminal-1 session=""
      count=$(file_value "$TMPDIR/identity-count")
      count=$((count + 1))
      printf '%s\n' "$count" > "$TMPDIR/identity-count"
      if [[ "$mode" == transient && "$count" == 1 ]]; then return 1; fi
      if [[ "$mode" == drift && "$count" == 2 ]]; then terminal=replacement; fi
      if [[ "$mode" == resumed-session ]]; then session=replacement-session; fi
      if (( count >= 3 )); then session=session-1; fi
      jq -nc --arg terminal "$terminal" --arg session "$session" \
        '{result:{agent:{name:"worker",pane_id:"pane-1",tab_id:"tab-1",workspace_id:"ws",terminal_id:$terminal,agent_session:{value:$session}}}}'
    }
    if [[ "$mode" == transient ]]; then
      herdr_registry_wait_session "$registry" 3 || fail 'transient identity read did not recover'
      assert_eq 3 "$(file_value "$TMPDIR/identity-count")" 'bounded observation attempts'
      assert_eq session-1 "$(jq -r '.native_identity.session' "$registry")" 'fresh identity persisted'
    else
      if HERDR_AXI_ENGINE_PROTOCOL=1 herdr_registry_wait_session "$registry" 3 \
        3> "$TMPDIR/protocol" 2> "$TMPDIR/output"; then fail 'replacement terminal accepted'; fi
      expected_attempts=2
      if [[ "$mode" == resumed-session ]]; then expected_attempts=1; fi
      assert_eq "$expected_attempts" "$(file_value "$TMPDIR/identity-count")" 'identity drift not retried'
      jq -e '.code == "SESSION_IDENTITY_CHANGED" and .submitted == false' "$TMPDIR/protocol" >/dev/null || fail 'drift protocol missing'
    fi
  done
)

test_missing_native_session_fails_before_submission() (
  setup_case missing-native-session
  printf '%s\n' opencode > "$FAKE_HERDR_CASE/kind"
  printf '%s\n' __empty__ > "$FAKE_HERDR_CASE/session"
  printf '%s\n' 'must not submit' > "$FAKE_HERDR_CASE/prompt"
  if HERDR_SESSION_READY_TIMEOUT_SECONDS=1 bash "$worker_script" --name worker --kind opencode \
    --cwd "$FAKE_HERDR_CASE" --prompt-file "$FAKE_HERDR_CASE/prompt" \
    --workspace ws --orchestrator-agent orch > "$TMPDIR/output" 2>&1; then
    fail 'worker without native session submitted a task'
  fi
  rg -q SESSION_START_UNVERIFIED "$TMPDIR/output" || fail 'missing native session diagnostic absent'
  assert_eq 0 "$(call_count '^agent prompt')" 'missing native session sends no prompt'
  assert_eq 0 "$(call_count '^pane split')" 'missing native session creates no monitor'
  assert_eq created "$(jq -r '.stage' "$HERDR_RECEIPT_ROOT/ws/worker.json")" 'missing native session stays inspectable'
)

test_startup_budgets_reject_invalid_before_allocation() (
  index=0
  for variable in HERDR_START_READY_TIMEOUT_SECONDS HERDR_SESSION_READY_TIMEOUT_SECONDS HERDR_MONITOR_READY_TIMEOUT_SECONDS HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS; do
    values=(0 -1 +1 01 ' 1' 1.5 '1+1' 1000000000 999999999999999999999)
    [[ "$variable" != HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS ]] || values+=(301)
    for value in "${values[@]}"; do
      index=$((index + 1))
      setup_case "invalid-budget-$index"
      printf '%s\n' task > "$TMPDIR/prompt"
      status=0
      env "$variable=$value" HERDR_AXI_ENGINE_PROTOCOL=1 bash "$worker_script" --name worker --kind copilot \
        --cwd "$FAKE_HERDR_CASE" --prompt-file "$TMPDIR/prompt" --workspace ws \
        > "$TMPDIR/output" 2> "$TMPDIR/error" 3> "$TMPDIR/protocol" || status=$?
      assert_eq 2 "$status" "$variable=$value configuration exit"
      jq -e -s 'length == 1 and (.[0] | .schema == 1 and .code == "INVALID_CONFIG" and .submitted == false)' \
        "$TMPDIR/protocol" >/dev/null || fail "$variable=$value missing typed preflight rejection"
      jq -e --arg variable "$variable" '.message | contains($variable)' "$TMPDIR/protocol" >/dev/null || fail 'diagnostic must name invalid setting'
      assert_file_absent "$FAKE_HERDR_CASE/calls" 'invalid budget does not resolve workspace or call backend'
      for mutation in 'tab create' 'agent start' 'agent prompt' 'pane split' 'tab close'; do
        assert_eq 0 "$(call_count "^$mutation")" "$variable=$value no $mutation"
      done
      assert_file_absent "$HERDR_RECEIPT_ROOT/ws/worker.json" 'invalid budget no registry'
      assert_file_absent "$HERDR_RECEIPT_ROOT/ws/worker.event" 'invalid budget no receipt'
    done
  done
)

test_startup_budgets_preserve_defaults_and_valid_bounds() (
  for mode in omitted empty upper; do
    setup_case "valid-budgets-$mode"
    unset HERDR_START_READY_TIMEOUT_SECONDS HERDR_SESSION_READY_TIMEOUT_SECONDS HERDR_MONITOR_READY_TIMEOUT_SECONDS HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS
    budget_args=()
    if [[ "$mode" != omitted ]]; then
      value=""; bootstrap_value=""
      if [[ "$mode" == upper ]]; then value=999999999; bootstrap_value=300; fi
      budget_args=("HERDR_START_READY_TIMEOUT_SECONDS=$value" "HERDR_SESSION_READY_TIMEOUT_SECONDS=$value" "HERDR_MONITOR_READY_TIMEOUT_SECONDS=$value" "HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS=$bootstrap_value")
    fi
    printf '%s\n' task > "$TMPDIR/prompt"
    env ${budget_args[@]+"${budget_args[@]}"} bash "$worker_script" --name worker --kind copilot \
      --cwd "$FAKE_HERDR_CASE" --prompt-file "$TMPDIR/prompt" --workspace ws > "$TMPDIR/output"
    assert_eq 1 "$(call_count '^agent prompt')" "$mode budgets submit once"
    assert_eq submitted "$(jq -r '.stage' "$TMPDIR/output")" "$mode budgets retain workflow"
  done
)

test_worker_provider_defaults_and_explicit_overrides() (
  for choice in copilot claude codex override native cursor-missing; do
    setup_case "provider-default-$choice"
    options=(); kind="$choice"; expected_model=gpt-5.6-sol
    case "$choice" in
      claude) expected_model=opus ;;
      override) kind=codex; expected_model=gpt-5.6-custom; options=(--model "$expected_model" --effort medium) ;;
      native) kind=opencode; expected_model="" ;;
      cursor-missing) kind=cursor ;;
    esac
    printf '%s\n' task > "$TMPDIR/prompt"
    status=0
    bash "$worker_script" --name worker --kind "$kind" ${options[@]+"${options[@]}"} \
      --cwd "$FAKE_HERDR_CASE" --prompt-file "$TMPDIR/prompt" --workspace ws \
      > "$TMPDIR/output" 2> "$TMPDIR/error" || status=$?
    if [[ "$choice" == cursor-missing ]]; then
      [[ "$status" != 0 ]] || fail 'Cursor requires explicit model'
      assert_eq 0 "$(call_count '^tab create')" 'Cursor no invented model allocation'
      continue
    fi
    assert_eq 0 "$status" "$choice launch status"
    assert_eq "$expected_model" "$(jq -r '.model' "$TMPDIR/output")" "$choice model selection"
    if [[ "$choice" == override ]]; then
      rg -q 'model_reasoning_effort=medium' "$FAKE_HERDR_CASE/calls" || fail 'explicit effort lost'
    fi
  done
)
