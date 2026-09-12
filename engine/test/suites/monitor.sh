#!/bin/bash

test_delivery_failure_waits_for_transition() (
  setup_case delivery-transition
  write_complete_transcript
  printf '%s\n' 3 > "$FAKE_HERDR_CASE/prompt-failures"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  for _ in $(seq 1 500); do
    (( $(call_count 'agent wait orch') >= 1 )) && break
    sleep 0.02
  done
  (( $(call_count 'agent wait orch') >= 1 )) ||
    fail "orchestrator transition wait did not start"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "delivery before state transition"
  printf '%s\n' working > "$FAKE_HERDR_CASE/orchestrator-status"
  for _ in $(seq 1 500); do
    [[ "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" == "1" ]] && break
    sleep 0.02
  done
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "delivery after orchestrator transition"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "delivery transition cleanup"
)

test_hot_loop_negative_probe() (
  setup_case hot-loop
  write_complete_transcript
  printf '%s\n' 999 > "$FAKE_HERDR_CASE/prompt-failures"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 4
  total_calls=$(wc -l < "$FAKE_HERDR_CASE/calls" | awk '{$1=$1; print}')
  (( total_calls <= 25 )) ||
    fail "hot-loop upper bound exceeded: $total_calls calls in 4 seconds"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "hot-loop cleanup"
  if find "$TMPDIR" -name 'herdr-monitor-*' -print -quit | grep -q .; then
    fail "monitor temporary file remained after signal"
  fi

  setup_case suppressed-loop
  write_complete_transcript
  append_user_message
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 4
  total_calls=$(wc -l < "$FAKE_HERDR_CASE/calls" | awk '{$1=$1; print}')
  (( total_calls <= 12 )) ||
    fail "suppression hot-loop bound exceeded: $total_calls calls in 4 seconds"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "suppression cleanup"

  setup_case lock-timeout-loop
  write_complete_transcript
  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  lock_pid=$$
  lock_start=$(herdr_process_start "$lock_pid")
  printf '%s\t%s\t%s\n' "$lock_pid" "$lock_start" live \
    > "${HERDR_MONITOR_RECEIPT}.lock"
  HERDR_RECEIPT_LOCK_ATTEMPTS=20 HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 4
  total_calls=$(wc -l < "$FAKE_HERDR_CASE/calls" | awk '{$1=$1; print}')
  (( total_calls <= 12 )) ||
    fail "lock-timeout hot-loop bound exceeded: $total_calls calls in 4 seconds"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  rm -f "${HERDR_MONITOR_RECEIPT}.lock"
  assert_no_fake_waiters "lock-timeout cleanup"

  setup_case missing-receipt-loop
  empty_hook="$FAKE_HERDR_CASE/empty-hook.sh"
  cat > "$empty_hook" <<'EOF'
#!/bin/bash
exit 0
EOF
  chmod +x "$empty_hook"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$empty_hook" &
  monitor_pid=$!
  sleep 4
  total_calls=$(wc -l < "$FAKE_HERDR_CASE/calls" | awk '{$1=$1; print}')
  (( total_calls <= 8 )) ||
    fail "missing-receipt hot-loop bound exceeded: $total_calls calls in 4 seconds"
  assert_file_absent "$HERDR_MONITOR_RECEIPT" "missing receipt probe"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "missing-receipt cleanup"
)

test_monitor_identity_fences_new_assignments() (
  for action in followup retry; do
    for fault in missing unreadable directory malformed unknown dead live; do
      setup_case "supervision-$action-$fault"
      export HERDR_AXI_MANAGED_TASK=1 HERDR_MONITOR_INBOX=1
      write_complete_transcript
      if [[ "$action" == followup ]]; then run_hook settled "$(payload)"; fi
      write_worker_registry
      registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
      if [[ "$action" == retry ]]; then
        jq '.stage="rejected" | .delivery_error="agent_blocked"' "$registry" > "$TMPDIR/registry"
        mv "$TMPDIR/registry" "$registry"
      fi
      owner="${HERDR_MONITOR_RECEIPT}.monitor-owner"
      case "$fault" in
        missing) rm "$owner" ;;
        unreadable) chmod 000 "$owner" ;;
        directory) rm "$owner"; mkdir "$owner" ;;
        malformed) printf '%s\n' incomplete > "$owner" ;;
        unknown)
          printf '%s\n' "$FAKE_MONITOR_PID" > "$FAKE_HERDR_CASE/ps-fail-pid"
          printf '%s\n' 100 > "$FAKE_HERDR_CASE/ps-fail-count"
          ;;
        dead)
          # The actual lifecycle process exits; its pane deliberately survives.
          HERDR_MONITOR_READY=testready bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$TMPDIR/monitor" &
          monitor_pid=$!
          trap 'kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true' EXIT
          for _ in $(seq 1 150); do
            if rg -q '^herdr-monitor-ready:testready$' "$TMPDIR/monitor"; then break; fi
            sleep 0.02
          done
          rg -q '^herdr-monitor-ready:testready$' "$TMPDIR/monitor" || fail "monitor never became ready"
          assert_eq "$monitor_pid" "$(cut -f 1 "$owner")" "real process owns identity"
          kill "$monitor_pid"
          wait "$monitor_pid" 2>/dev/null || true
          trap - EXIT
          assert_file_present "$FAKE_HERDR_CASE/monitor-1-alive" "pane survives monitor exit"
          ;;
      esac
      before=$(< "$HERDR_MONITOR_RECEIPT")
      generation=$(jq -r '.generation' "$registry")
      printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
      printf '%s\n' 'new bounded task' > "$TMPDIR/prompt"
      if bash "$orchestrator_script" "$action" worker --prompt-file "$TMPDIR/prompt" > "$TMPDIR/result" 2>&1; then
        [[ "$fault" == live ]] || fail "$action accepted $fault supervision"
        assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "$action live monitor permits one input"
      else
        [[ "$fault" != live ]] || fail "$action rejected live supervision: $(< "$TMPDIR/result")"
        rg -q MONITOR_SUPERVISION_LOST "$TMPDIR/result" || fail "missing actionable supervision error: $(< "$TMPDIR/result")"
        assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "$action $fault sends no input"
        assert_eq "$generation" "$(jq -r '.generation' "$registry")" "$action $fault preserves generation"
        assert_eq "$before" "$(< "$HERDR_MONITOR_RECEIPT")" "$action $fault preserves receipt"
      fi
      if [[ "$fault" == unreadable ]]; then chmod 600 "$owner"; fi
    done
  done
)

test_monitor_ready_requires_published_identity() (
  for fault in process-start publication; do
    setup_case "monitor-identity-$fault"
    write_complete_transcript
    if [[ "$fault" == process-start ]]; then
      : > "$FAKE_HERDR_CASE/ps-fail-all"
    else
      mkdir "${HERDR_MONITOR_RECEIPT}.monitor-owner"
    fi
    if HERDR_MONITOR_READY=unsafe bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$TMPDIR/result" 2>&1; then
      fail "monitor acknowledged $fault failure"
    fi
    if rg -q '^herdr-monitor-ready:' "$TMPDIR/result"; then fail "ready emitted without durable identity"; fi
    rg -q MONITOR_START_UNVERIFIED "$TMPDIR/result" || fail "missing startup repair guidance"
    assert_file_absent "${HERDR_MONITOR_RECEIPT}.monitor-ready" \
      "$fault monitor publishes no ready marker"
    assert_eq 0 "$(call_count '^agent get')" "unidentified monitor cannot acknowledge backend readiness"
  done
)

test_registry_native_identity_survives_start_and_fences_capture() (
  setup_case registry-native-identity
  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  prompt_file="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded task" > "$prompt_file"
  bash "$orchestrator_script" start --name worker --kind copilot \
    --cwd "$FAKE_HERDR_CASE" --prompt-file "$prompt_file" --workspace ws --orchestrator-agent orch >/dev/null
  registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
  assert_eq terminal-1 "$(jq -r '.native_identity.terminal' "$registry")" "durable terminal"
  assert_eq session-1 "$(jq -r '.native_identity.session' "$registry")" "durable session"
  before=$(< "$registry")
  printf '%s\n' replacement-terminal > "$FAKE_HERDR_CASE/terminal"
  if herdr_registry_capture_identity "$registry" true 2>/dev/null; then fail "capture adopted replacement terminal"; fi
  assert_eq "$before" "$(< "$registry")" "failed capture preserves registry"
  printf '%s\n' terminal-1 > "$FAKE_HERDR_CASE/terminal"
  printf '%s\n' replacement-session > "$FAKE_HERDR_CASE/session"
  if herdr_registry_capture_identity "$registry" 2>/dev/null; then fail "observation adopted replacement session"; fi
  assert_eq "$before" "$(< "$registry")" "failed observation preserves registry"
  herdr_registry_capture_identity "$registry" true
  assert_eq replacement-session "$(jq -r '.native_identity.session' "$registry")" "own prompt can rotate native session"
)

test_signal_cleanup_fixture() (
  setup_case signal-cleanup
  signals=(HUP TERM HUP TERM TERM HUP TERM)
  delays=(0.05 0.10 0.15 0.20 0.25 0.30 0.35)
  for index in $(seq 0 6); do
    ready="$FAKE_HERDR_CASE/fixture-$index.ready"
    TMPDIR="$TMPDIR" bash "$test_script" --signal-fixture "$ready" &
    fixture_pid=$!
    wait_for_file "$ready" || fail "signal fixture $index did not start"
    fixture_root=$(< "$ready")
    assert_file_present "$fixture_root" "signal fixture $index root"
    sleep "${delays[$index]}"
    kill -"${signals[$index]}" "$fixture_pid"
    wait "$fixture_pid" 2>/dev/null || true
    assert_file_absent "$fixture_root" "signal fixture $index cleanup"
  done
)

test_monitor_survives_quiet_intervals() (
  for status in working idle unknown; do
    setup_case "quiet-$status"
    printf '%s\n' "$status" > "$FAKE_HERDR_CASE/status"
    HERDR_MONITOR_CHANGE_WAIT_TICKS=2 \
      bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
    monitor_pid=$!
    sleep 1.5
    kill -0 "$monitor_pid" 2>/dev/null || fail "$status monitor exited on a quiet interval"
    kill "$monitor_pid" 2>/dev/null || true
    wait "$monitor_pid" 2>/dev/null || true
    assert_no_fake_waiters "quiet $status cleanup"
  done
)

test_failed_native_waits_back_off_and_lost_terminates() (
  setup_case failed-native-waits
  write_complete_transcript
  printf '%s\n' 999 > "$FAKE_HERDR_CASE/prompt-failures"
  : > "$FAKE_HERDR_CASE/release-waits"
  bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 5
  kill -0 "$monitor_pid" 2>/dev/null || fail "failed wait ended supervision"
  attempts=$(file_value "$FAKE_HERDR_CASE/prompt-attempts")
  (( attempts > 0 && attempts <= 9 )) || fail "failed waits caused a hot loop: $attempts prompt attempts"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "failed wait cleanup"

  setup_case lost-with-hook-failure
  : > "$FAKE_HERDR_CASE/agent-get-fail"
  empty_hook="$FAKE_HERDR_CASE/empty-hook.sh"
  printf '%s\n' '#!/bin/bash' 'echo attempt >> "$FAKE_HERDR_CASE/lost-attempts"' 'exit 0' > "$empty_hook"
  bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$empty_hook" &
  monitor_pid=$!
  for _ in $(seq 1 400); do
    kill -0 "$monitor_pid" 2>/dev/null || break
    sleep 0.02
  done
  if kill -0 "$monitor_pid" 2>/dev/null; then
    kill "$monitor_pid" 2>/dev/null || true
    wait "$monitor_pid" 2>/dev/null || true
    fail "lost notification retried forever"
  fi
  if wait "$monitor_pid"; then fail "permanent lost notification failure must not exit successfully"; fi
  assert_eq 3 "$(wc -l < "$FAKE_HERDR_CASE/lost-attempts" | tr -d ' ')" "lost delivery retry count"
  [[ -s "${HERDR_MONITOR_RECEIPT}.monitor-error" ]] || fail "lost failure must leave durable diagnostics"
  assert_eq 0 "$(call_count 'agent wait')" "lost worker must not wait for a transition"

  setup_case lost-transient-hook
  : > "$FAKE_HERDR_CASE/agent-get-fail"
  retry_hook="$FAKE_HERDR_CASE/retry-hook.sh"
  printf '%s\n' '#!/bin/bash' \
    'echo attempt >> "$FAKE_HERDR_CASE/lost-attempts"' \
    'if [[ $(wc -l < "$FAKE_HERDR_CASE/lost-attempts") -ge 3 ]]; then printf "delivered\tok\n" > "$HERDR_MONITOR_RESULT_FILE"; else printf "error\tlock-timeout\n" > "$HERDR_MONITOR_RESULT_FILE"; fi' > "$retry_hook"
  bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$retry_hook"
  assert_eq 3 "$(wc -l < "$FAKE_HERDR_CASE/lost-attempts" | tr -d ' ')" "transient lost delivery retried"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.monitor-error" "successful lost delivery"
)

test_backoff_grows_not_just_below_a_loose_attempt_ceiling() (
  setup_case exponential-backoff
  # Exercise the exact production function; accelerated sleep records requested
  # delays. A constant 1-second mutant fails even when attempts <= 9 still passes.
  eval "$(sed -n '/^backoff() {/,/^}/p' "$monitor_script")"
  sleep() { printf '%s\n' "$1" >> "$FAKE_HERDR_CASE/delays"; /bin/sleep 0.01; }
  retry_delay=1
  for _ in 1 2 3 4 5 6 7; do backoff; done
  assert_eq $'1\n2\n4\n8\n16\n30\n30' "$(< "$FAKE_HERDR_CASE/delays")" "exponential bounded backoff"
)

test_split_monitor_preserves_selected_backend() (
  setup_case split-monitor-backend
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' 'bounded task' > "$worker_prompt"
  HERDR_MONITOR_INBOX=1 bash "$worker_script" --name worker --kind copilot \
    --cwd "$FAKE_HERDR_CASE" --prompt-file "$worker_prompt" \
    --workspace ws --orchestrator-agent orch >/dev/null
  monitor_command=$(< "$FAKE_HERDR_CASE/monitor-command")
  selected_backend="$(cd -- "$fake_bin" && pwd)/herdr"
  rg -Fq -- "--env HERDR_BIN=$selected_backend" "$FAKE_HERDR_CASE/calls" || fail "native hooks lost backend selection"
  mkdir "$FAKE_HERDR_CASE/server-bin"
  ln -s /usr/bin/false "$FAKE_HERDR_CASE/server-bin/herdr"
  env -u HERDR_BIN PATH="$FAKE_HERDR_CASE/server-bin:$PATH" \
    bash -c "exec ${monitor_command#* }" > "$TMPDIR/monitor-output" &
  monitor_pid=$!
  trap 'kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true' EXIT
  for attempt in $(seq 1 100); do
    if rg -q '^agent: working' "$TMPDIR/monitor-output"; then break; fi
    sleep 0.02
  done
  rg -q '^agent: working' "$TMPDIR/monitor-output" || fail "selected backend healthy worker not observed"
  expected_ready="herdr-monitor-ready:$(jq -r '.generation' "$HERDR_RECEIPT_ROOT/ws/worker.json")"
  rg -Fxq "$expected_ready" "$TMPDIR/monitor-output" || fail "real monitor did not emit generation-bound startup acknowledgement"
  assert_eq "$(jq -r '.generation' "$HERDR_RECEIPT_ROOT/ws/worker.json")" \
    "$(< "${HERDR_MONITOR_RECEIPT}.monitor-ready")" "ready marker is generation bound"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.inbox" "wrong backend must not create false lost event"
  : > "$FAKE_HERDR_CASE/agent-get-fail"
  : > "$FAKE_HERDR_CASE/release-waits"
  wait_for_file "${HERDR_MONITOR_RECEIPT}.inbox" 300 || fail "selected backend loss not observed"
  wait "$monitor_pid"
  trap - EXIT
  assert_eq lost "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "selected backend real loss delivered"
)

test_split_monitor_preserves_delivery_mode() (
  for mode in 1 0; do
    setup_case "split-monitor-mode-$mode"
    worker_prompt="$FAKE_HERDR_CASE/worker.txt"
    printf '%s\n' 'bounded read-only task' > "$worker_prompt"
    HERDR_MONITOR_INBOX="$mode" bash "$worker_script" --name worker --kind copilot \
      --cwd "$FAKE_HERDR_CASE" --prompt-file "$worker_prompt" \
      --workspace ws --orchestrator-agent orch >/dev/null
    monitor_command=$(< "$FAKE_HERDR_CASE/monitor-command")
    # Execute the actual generated command as a fresh split pane whose server
    # environment did not inherit the worker tab's custom variables.
    : > "$FAKE_HERDR_CASE/agent-get-fail"
    env -u HERDR_MONITOR_INBOX -u HERDR_RECEIPT_ROOT HERDR_WORKSPACE_ID=foreign \
      bash -c "${monitor_command#* }"
    if [[ "$mode" == 1 ]]; then
      assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "managed split owner interruptions"
      assert_file_present "${HERDR_MONITOR_RECEIPT}.inbox" "split durable inbox"
      assert_eq lost "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "split lost event"
    else
      assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "legacy split notification"
    fi
  done
)

test_monitor_signal_during_waiter_registration() (
  setup_case signal-during-registration
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  # Scheduling fault injection, not a source-text assertion: interrupt the real
  # monitor's helper after spawning its backend but before recording its PID.
  cat > "$FAKE_HERDR_CASE/schedule.bash" <<'EOF'
set -T
trap '
  if [[ "$BASH_COMMAND" == "wait_command_pid=\$!" && ! -e "$FAKE_HERDR_CASE/registration-pid" ]]; then
    trap - DEBUG
    backend_pid=$!
    helper_pid=$(ps -o ppid= -p "$backend_pid" | tr -d " ")
    printf "%s\n" "$backend_pid" > "$FAKE_HERDR_CASE/registration-pid"
    kill -TERM "$helper_pid"
  fi
' DEBUG
EOF
  BASH_ENV="$FAKE_HERDR_CASE/schedule.bash" bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$FAKE_HERDR_CASE/output" 2>&1 &
  monitor_pid=$!
  trap 'kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true; if [[ -s "$FAKE_HERDR_CASE/registration-pid" ]]; then kill "$(< "$FAKE_HERDR_CASE/registration-pid")" 2>/dev/null || true; fi' EXIT
  wait_for_file "$FAKE_HERDR_CASE/registration-pid" || fail "registration signal never injected"
  sleep 0.2
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "signal during PID registration"
  trap - EXIT
)

test_monitor_ready_marker_handshake() (
  setup_case marker-handshake
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded task" > "$worker_prompt"
  bash "$worker_script" --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch >/dev/null
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" \
    "published marker submits the task"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.monitor-ready" \
    "acked marker is removed after startup"
  assert_file_present "${HERDR_MONITOR_RECEIPT}.monitor-owner" \
    "identity precedes the consumed ready marker"
  assert_eq 0 "$(call_count 'pane wait-output')" \
    "startup ack does not use output matching"

  setup_case marker-delayed
  printf '%s\n' 0.30 > "$FAKE_HERDR_CASE/monitor-ready-delay"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded task" > "$worker_prompt"
  bash "$worker_script" --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch >/dev/null
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" \
    "worker waits for a delayed marker within the timeout"

  setup_case marker-stale
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  printf '%s\n' stale-generation > "${HERDR_MONITOR_RECEIPT}.monitor-ready"
  : > "$FAKE_HERDR_CASE/monitor-no-start"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "must fail closed" > "$worker_prompt"
  if HERDR_MONITOR_READY_TIMEOUT_SECONDS=1 bash "$worker_script" \
    --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/output" 2>&1; then
    fail "a stale marker with a wrong generation passed startup"
  fi
  rg -q MONITOR_START_UNVERIFIED "$TMPDIR/output" || fail "missing stale marker diagnostic"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" \
    "stale marker submits no task"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.monitor-ready" \
    "failed startup does not leave the marker behind"
)

test_managed_reports_bind_to_current_user_assignment() (
  for kind in claude codex copilot; do
    setup_case "current-assignment-$kind"
    printf '%s\n' "$kind" > "$FAKE_HERDR_CASE/kind"
    case "$kind" in
      claude) transcript=$(write_claude_transcript); arm_completion_generation ;;
      codex) transcript=$(write_codex_transcript); arm_completion_generation ;;
      copilot) write_complete_transcript; transcript=$(transcript_path) ;;
    esac
    write_worker_registry
    arm_completion_generation generation-two
    registry="${HERDR_MONITOR_RECEIPT%.event}.json"
    jq '.generation="generation-two"' "$registry" > "$TMPDIR/registry"
    mv "$TMPDIR/registry" "$registry"
    delayed_payload=$(jq -nc --arg path "$transcript" \
      '{transcriptPath:$path,session_id:"session-1",last_assistant_message:"OLD_REPORT"}')
    HERDR_MONITOR_INBOX=1 run_hook settled "$delayed_payload"
    assert_file_absent "${HERDR_MONITOR_RECEIPT}.inbox" "$kind old turn cannot borrow new proof"
    case "$kind" in
      claude) jq -nc '{type:"user",message:{content:"new task .proof.generation-two"}}' >> "$transcript" ;;
      codex) jq -nc '{type:"event_msg",payload:{type:"user_message",message:"new task .proof.generation-two"}}' >> "$transcript" ;;
      copilot) jq -nc '{type:"user.message",data:{content:"new task .proof.generation-two"}}' >> "$transcript" ;;
    esac
    HERDR_MONITOR_INBOX=1 run_hook settled "$delayed_payload"
    assert_file_absent "${HERDR_MONITOR_RECEIPT}.inbox" "$kind current turn with no report cannot reuse old assistant"
    # Long turns must work without loading the complete transcript into memory.
    for _ in $(seq 1 550); do printf '%s\n' '{"type":"tool_event"}' >> "$transcript"; done
    case "$kind" in
      codex) jq -nc '{type:"response_item",payload:{type:"message",role:"assistant",content:[{text:"Task: preliminary, checks pending"}]}}' >> "$transcript" ;;
      copilot) jq -nc '{type:"assistant.message",data:{content:"Task: preliminary, checks pending"}}' >> "$transcript" ;;
    esac
    case "$kind" in
      claude) jq -nc '{type:"assistant",message:{role:"assistant",content:[{type:"text",text:"CURRENT_REPORT"}]}}' >> "$transcript" ;;
      codex) jq -nc '{type:"response_item",payload:{type:"message",role:"assistant",content:[{text:"CURRENT_REPORT"}]}}' >> "$transcript" ;;
      copilot) jq -nc '{type:"session.task_complete",data:{summary:"CURRENT_REPORT"}}' >> "$transcript" ;;
    esac
    HERDR_MONITOR_INBOX=1 run_hook settled "$delayed_payload"
    assert_eq CURRENT_REPORT "$(jq -r '.completion.detail' "${HERDR_MONITOR_RECEIPT}.inbox")" "$kind delayed payload cannot replace current transcript"
  done
)

test_engine_error_protocol_and_backend_override() (
  setup_case engine-protocol
  source "$receipt_script"
  HERDR_AXI_ENGINE_PROTOCOL=1 herdr_engine_error PROMPT_REJECTED $'quoted "message"\nsecond line' false \
    3> "$TMPDIR/protocol" 2> "$TMPDIR/diagnostic"
  jq -e '.schema == 1 and .code == "PROMPT_REJECTED" and .submitted == false and (.message | contains("\n"))' \
    "$TMPDIR/protocol" >/dev/null || fail 'engine error frame invalid'
  herdr_engine_error ENGINE_ERROR standalone 2> "$TMPDIR/standalone"
  assert_eq 'ENGINE_ERROR: standalone' "$(< "$TMPDIR/standalone")" 'standalone needs no protocol descriptor'
  custom_bin="$TMPDIR/custom-bin"
  mkdir -p "$custom_bin"
  cp "$fake_bin/herdr" "$custom_bin/backend"
  for dependency in jq rg node; do
    ln -s "$(command -v "$dependency")" "$custom_bin/$dependency"
  done
  PATH="$custom_bin:/usr/bin:/bin" HERDR_BIN="$custom_bin/backend" \
    bash "$orchestrator_script" inspect worker > "$TMPDIR/output"
  rg -q 'worker' "$TMPDIR/output" || fail 'custom backend not inspected'
)
