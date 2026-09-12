#!/bin/bash

test_lock_parallelism_and_subshell_identity() (
  setup_case lock-parallel
  receipt="$HERDR_MONITOR_RECEIPT"
  critical="$FAKE_HERDR_CASE/critical"
  violation="$FAKE_HERDR_CASE/violation"
  for _ in $(seq 1 32); do
    (
      # shellcheck source=herdr-receipt.sh
      source "$receipt_script"
      herdr_receipt_lock_acquire "$receipt" || exit 1
      if ! mkdir "$critical" 2>/dev/null; then
        : > "$violation"
      else
        sleep 0.02
        rmdir "$critical"
      fi
      herdr_receipt_lock_release
    ) &
  done
  wait
  assert_file_absent "$violation" "subshell mutual exclusion"
  assert_file_absent "${receipt}.lock" "parallel lock"
  if find "$(dirname -- "$receipt")" -name 'worker.event.lock.claim.*' \
    -print -quit | grep -q .; then
    fail "parallel claims remained"
  fi
)

test_lock_reaping_and_exact_identity() (
  setup_case lock-reaping
  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  receipt="$HERDR_MONITOR_RECEIPT"
  mkdir -p "$(dirname -- "$receipt")"
  live_pid=$$
  live_start=$(herdr_process_start "$live_pid")

  lock_forms=(
    "malformed"
    ""
    $'999999\tThu Jan  1 00:00:00 1970\tdead'
    "${live_pid}"$'\t'"wrong start"$'\t'"reused"
  )
  for lock_content in "${lock_forms[@]}"; do
    printf '%s\n' "$lock_content" > "${receipt}.lock"
    HERDR_RECEIPT_LOCK_ATTEMPTS=80 \
      herdr_receipt_lock_acquire "$receipt" ||
      fail "stale lock was not reaped: ${lock_content:-empty}"
    herdr_receipt_lock_release
  done

  printf '%s\n' malformed > "${receipt}.lock"
  chmod 000 "${receipt}.lock"
  HERDR_RECEIPT_LOCK_ATTEMPTS=80 \
    herdr_receipt_lock_acquire "$receipt" ||
    fail "unreadable lock was not reaped"
  herdr_receipt_lock_release

  printf '%s\t%s\t%s\n' "$live_pid" "$live_start" live > "${receipt}.lock"
  live_inode=$(herdr_path_inode "${receipt}.lock")
  if HERDR_RECEIPT_LOCK_ATTEMPTS=20 \
    herdr_receipt_lock_acquire "$receipt"; then
    fail "live lock was reaped"
  fi
  assert_eq "$live_inode" "$(herdr_path_inode "${receipt}.lock")" \
    "live lock identity"
  rm -f "${receipt}.lock"

  printf '%s\n' old > "${receipt}.lock"
  old_inode=$(herdr_path_inode "${receipt}.lock")
  rm -f "${receipt}.lock"
  printf '%s\n' new > "${receipt}.lock"
  new_inode=$(herdr_path_inode "${receipt}.lock")
  herdr_remove_exact_file "${receipt}.lock" "$old_inode"
  assert_eq "$new_inode" "$(herdr_path_inode "${receipt}.lock")" \
    "replacement lock survived stale reap"
  rm -f "${receipt}.lock"
)

test_sigkill_lock_and_claim_cleanup() (
  setup_case sigkill-lock
  receipt="$HERDR_MONITOR_RECEIPT"
  acquired="$FAKE_HERDR_CASE/acquired"
  bash -c '
    set -euo pipefail
    source "$1"
    herdr_receipt_lock_acquire "$2"
    : > "$3"
    sleep 30
  ' bash "$receipt_script" "$receipt" "$acquired" &
  holder_pid=$!
  wait_for_file "$acquired" || fail "SIGKILL holder did not acquire"
  kill -9 "$holder_pid"
  wait "$holder_pid" 2>/dev/null || true

  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  HERDR_RECEIPT_LOCK_ATTEMPTS=100 \
    herdr_receipt_lock_acquire "$receipt" ||
    fail "SIGKILL lock was not reaped"
  herdr_receipt_lock_release
  assert_file_absent "${receipt}.lock" "SIGKILL lock cleanup"
  if find "$(dirname -- "$receipt")" -name 'worker.event.lock.claim.*' \
    -print -quit | grep -q .; then
    fail "SIGKILL claim remained"
  fi

  block_bin="$FAKE_HERDR_CASE/block-bin"
  claim_ready="$FAKE_HERDR_CASE/claim-ready"
  mkdir -p "$block_bin"
  cat > "$block_bin/ln" <<EOF
#!/bin/bash
printf '%s\n' "\$\$" > "$claim_ready"
sleep 30
exec /bin/ln "\$@"
EOF
  chmod +x "$block_bin/ln"
  PATH="$block_bin:$PATH" bash -c '
    set -euo pipefail
    source "$1"
    herdr_receipt_lock_acquire "$2"
  ' bash "$receipt_script" "$receipt" &
  claimant_pid=$!
  wait_for_file "$claim_ready" || fail "claim SIGKILL fixture did not start"
  claimant_ln_pid=$(< "$claim_ready")
  kill -9 "$claimant_pid"
  kill -9 "$claimant_ln_pid" 2>/dev/null || true
  wait "$claimant_pid" 2>/dev/null || true
  sleep 0.2
  if ! find "$(dirname -- "$receipt")" -name 'worker.event.lock.claim.*' \
    -print -quit | grep -q .; then
    fail "claim SIGKILL did not leave the intended orphan"
  fi
  HERDR_RECEIPT_LOCK_ATTEMPTS=100 \
    herdr_receipt_lock_acquire "$receipt" ||
    fail "orphan claim blocked the next acquisition"
  herdr_receipt_lock_release
  if find "$(dirname -- "$receipt")" -name 'worker.event.lock.claim.*' \
    -print -quit | grep -q .; then
    fail "orphan claim was not cleaned"
  fi
)

test_lock_timeout_machine_result() (
  setup_case lock-timeout
  write_complete_transcript
  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  lock_pid=$$
  lock_start=$(herdr_process_start "$lock_pid")
  printf '%s\t%s\t%s\n' "$lock_pid" "$lock_start" live \
    > "${HERDR_MONITOR_RECEIPT}.lock"
  result_file="$TMPDIR/lock.result"
  HERDR_RECEIPT_LOCK_ATTEMPTS=20 HERDR_MONITOR_RESULT_FILE="$result_file" \
    run_hook settled "$(payload)"
  assert_eq error "$(cut -f 1 "$result_file")" "lock timeout outcome"
  assert_eq lock-timeout "$(cut -f 2 "$result_file")" "lock timeout reason"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "lock timeout delivery"
  rm -f "${HERDR_MONITOR_RECEIPT}.lock"
)

test_lock_lease_parent_identity_is_fail_closed() (
  setup_case transient-lease-parent
  receipt="$HERDR_MONITOR_RECEIPT"
  start_holder="$FAKE_HERDR_CASE/start-holder"
  holder_acquired="$FAKE_HERDR_CASE/holder-acquired"
  holder_release="$FAKE_HERDR_CASE/release-holder"
  bash -c '
    set -euo pipefail
    source "$1"
    while [[ ! -e "$3" ]]; do sleep 0.01; done
    herdr_receipt_lock_acquire "$2"
    : > "$4"
    while [[ ! -e "$5" ]]; do sleep 0.01; done
    herdr_receipt_lock_release
  ' bash "$receipt_script" "$receipt" "$start_holder" "$holder_acquired" \
    "$holder_release" &
  holder_pid=$!
  printf '%s\n' "$holder_pid" > "$FAKE_HERDR_CASE/ps-fail-pid"
  printf '%s\n' 100 > "$FAKE_HERDR_CASE/ps-fail-count"
  : > "$start_holder"
  wait_for_file "$holder_acquired" ||
    fail "holder did not acquire with transient parent ps failure"

  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  if HERDR_RECEIPT_LOCK_ATTEMPTS=20 \
    herdr_receipt_lock_acquire "$receipt"; then
    fail "contender acquired while fail-closed lease holder was active"
  fi
  : > "$holder_release"
  wait "$holder_pid"
  HERDR_RECEIPT_LOCK_ATTEMPTS=100 \
    herdr_receipt_lock_acquire "$receipt" ||
    fail "lock was not available after holder release"
  herdr_receipt_lock_release
  assert_file_absent "${receipt}.lock" "transient lease lock cleanup"
)

test_receipt_override_is_agent_bound() (
  setup_case receipt-agent-binding
  worker_receipt="$HERDR_MONITOR_RECEIPT"
  mkdir -p "$(dirname -- "$worker_receipt")"
  printf '%s\n' worker-sentinel > "$worker_receipt"
  other_receipt="$HERDR_RECEIPT_ROOT/ws/other.event"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    herdr-receipt/3 1 settled delivered generation:other \
    settled generation:other generation:other open other delivered \
    > "$other_receipt"
  write_worker_registry other ws other
  printf '%s\n' other > "$FAKE_HERDR_CASE/started-name"
  output=$(bash "$orchestrator_script" close other)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "close other did not report success"
  assert_eq worker-sentinel "$(< "$worker_receipt")" \
    "worker receipt after close other"
  assert_eq closed "$(cut -f 9 "$other_receipt")" \
    "other receipt tombstone"
  assert_eq other "$(cut -f 10 "$other_receipt")" \
    "other receipt generation"
  assert_eq close "$(cut -f 11 "$other_receipt")" \
    "other receipt close reason"
)

test_blocked_working_cycle_preserves_assignment_and_proof() (
  setup_case blocked-working-generation
  arm_completion_generation assignment-one
  write_worker_registry worker ws assignment-one
  printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
  HERDR_MONITOR_INBOX=1 HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$TMPDIR/monitor-output" &
  monitor_pid=$!
  wait_for_file "${HERDR_MONITOR_RECEIPT}.inbox" || fail "blocked input was not collected"
  # Wait until the monitor has remembered the boundary, then resume this task.
  for _ in $(seq 1 250); do
    (( $(call_count '^agent wait worker') >= 1 )) && break
    sleep 0.02
  done
  (( $(call_count '^agent wait worker') >= 1 )) || fail "blocked wait never armed"
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 250); do
    [[ "$(receipt_read_field 2)" == 2 ]] && break
    sleep 0.02
  done
  assert_eq 2 "$(receipt_read_field 2)" "native resume starts status cycle"
  assert_eq assignment-one "$(receipt_read_field 10)" "native resume preserves assignment generation"
  assert_eq assignment-one "$(jq -r '.generation' "$HERDR_RECEIPT_ROOT/ws/worker.json")" "registry still agrees"
  assert_file_present "${HERDR_MONITOR_RECEIPT}.proof.assignment-one" "native resume retains concurrent completion proof"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "blocked-working cleanup"
  run_file="$FAKE_HERDR_CASE/run.json"
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" \
    '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"cancelling",cancellation:{from:{name:"worker",pane:"pane-1",tab:"tab-1",generation:"assignment-one",session:"session-1",receipt:$receipt},evidence:"User authorizes interruption; partial state preserved",output:"Saved assignment checkpoint"}}]}' > "$run_file"
  HERDR_AXI_MANAGED_TASK=1 bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "resumed assignment remains cancellable"
)

test_blocked_startup_resumes_owned_pane() (
  setup_case resume-startup
  : > "$FAKE_HERDR_CASE/start-blocked"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "resume this assignment" > "$worker_prompt"
  if bash "$worker_script" --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch >/dev/null 2>&1; then
    fail "blocked startup claimed success"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" "retained startup dialog"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "no prompt before startup approval"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  bash "$worker_script" --resume --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch >/dev/null
  assert_eq 1 "$(call_count 'tab create')" "resume reused tab"
  assert_eq 1 "$(call_count 'agent start worker')" "resume reused agent"
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "resume delivered once"
)

test_blocked_startup_hook_keeps_cancellable_generation() (
  setup_case startup-hook-cancel
  : > "$FAKE_HERDR_CASE/start-blocked"
  printf '%s\n' "$hook_script" > "$FAKE_HERDR_CASE/start-hook"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded work" > "$worker_prompt"
  if bash "$worker_script" --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch >/dev/null 2>&1; then
    fail "blocked startup claimed success"
  fi
  generation=$(jq -r '.generation' "$HERDR_RECEIPT_ROOT/ws/worker.json")
  assert_eq "$generation" "$(receipt_read_field 10)" "native input retains startup generation"
  assert_eq "$generation" "$(jq -r '.generation' "${HERDR_MONITOR_RECEIPT}.inbox")" "input report bound to startup"
  assert_eq input "$(receipt_read_field 3)" "real startup hook ran"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "no task sent at trust dialog"
  run_file="$FAKE_HERDR_CASE/run.json"
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" --arg generation "$generation" \
    '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"cancelling",cancellation:{from:{name:"worker",pane:"pane-1",tab:"tab-1",generation:$generation,session:"session-1",receipt:$receipt},evidence:"Stop blocked startup; no task submitted",output:"Folder approval pending"}}]}' > "$run_file"
  HERDR_AXI_MANAGED_TASK=1 bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "whole blocked startup tab closed"
  assert_eq 1 "$(call_count '^tab close')" "one owned tab close"
  assert_eq cancelled "$(receipt_read_field 11)" "cancellation tombstone"
)

test_hook_renders_backend_output_without_holding_receipt_lock() (
  jq() {
    if [[ "$*" == *events.jsonl* ]]; then
      : > "$FAKE_HERDR_CASE/transcript-scanned"
      if [[ -e "${HERDR_MONITOR_RECEIPT}.lock" ]]; then : > "$FAKE_HERDR_CASE/locked-transcript-scan"; fi
    fi
    command jq "$@"
  }
  export -f jq
  setup_case locked-scan-negative-control
  write_complete_transcript
  (
    # shellcheck source=herdr-receipt.sh
    source "$receipt_script"
    herdr_receipt_lock_acquire "$HERDR_MONITOR_RECEIPT"
    jq -s . "$(transcript_path)" >/dev/null
    assert_file_present "$FAKE_HERDR_CASE/locked-transcript-scan" "negative control detects a real locked scan"
    herdr_receipt_lock_release
  )
  for event in settled input error lost quota; do
    setup_case "unlocked-render-$event"
    write_complete_transcript
    : > "$FAKE_HERDR_CASE/check-unlocked-reads"
    if [[ "$event" == quota ]]; then printf '%s\n' 'You have exceeded your monthly quota' > "$FAKE_HERDR_CASE/visible"; event=error; fi
    HERDR_MONITOR_INBOX=1 run_hook "$event" '{}'
    assert_file_present "${HERDR_MONITOR_RECEIPT}.inbox" "$event delivered"
    assert_file_absent "$FAKE_HERDR_CASE/locked-backend-reads" "$event backend reads outside critical section"
    assert_file_present "$FAKE_HERDR_CASE/transcript-scanned" "$event transcript scan exercised"
    assert_file_absent "$FAKE_HERDR_CASE/locked-transcript-scan" "$event transcript scans outside critical section"
  done
)

test_herdr_blocks_cursor_trust_before_submission() (
  setup_case cursor-trust-idle
  printf '%s\n' cursor > "$FAKE_HERDR_CASE/kind"
  : > "$FAKE_HERDR_CASE/start-blocked"
  printf '%s\n' '│ ⚠ Workspace Trust Required │' '│ ▶ [a] Trust this workspace │' > "$FAKE_HERDR_CASE/startup-screen"
  printf '%s\n' 'Tiny read-only check' > "$FAKE_HERDR_CASE/prompt"
  if output=$(bash "$worker_script" --name worker --kind cursor --model composer-2.5 \
    --cwd "$FAKE_HERDR_CASE" --prompt-file "$FAKE_HERDR_CASE/prompt" --workspace ws --orchestrator-agent orch 2>&1); then
    fail 'Cursor trust dialog treated as ready'
  fi
  [[ "$output" == *agent_not_ready* ]] || fail 'Herdr startup block missing'
  assert_eq 0 "$(call_count '^agent prompt')" 'Cursor trust never receives task text'
  assert_eq 0 "$(call_count '^agent send-keys')" 'Cursor trust never auto-approved'
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" 'Cursor startup remains inspectable'
  assert_file_absent "$FAKE_HERDR_CASE/monitor-command" 'Herdr block runs before monitor allocation'
)

test_receipt_composition_preserves_active_lock() (
  setup_case repeated-receipt-source
  library="${HERDR_RECEIPT_TEST_SOURCE:-$receipt_script}"
  source "$library"
  herdr_receipt_lock_acquire "$HERDR_MONITOR_RECEIPT" || fail 'fixture lock acquire'
  saved_path="$herdr_receipt_lock_path"
  saved_inode="$herdr_receipt_lock_inode"
  saved_claim="$herdr_receipt_lock_claim"
  saved_lease="$herdr_receipt_lock_lease_pid"
  release_saved_lock() {
    herdr_receipt_lock_path="$saved_path"
    herdr_receipt_lock_inode="$saved_inode"
    herdr_receipt_lock_claim="$saved_claim"
    herdr_receipt_lock_lease_pid="$saved_lease"
    herdr_receipt_lock_release
  }
  trap release_saved_lock EXIT
  source "$library"
  assert_eq "$saved_path" "$herdr_receipt_lock_path" 'second source retains lock path'
  assert_eq "$saved_inode" "$herdr_receipt_lock_inode" 'second source retains lock inode'
  assert_eq "$saved_claim" "$herdr_receipt_lock_claim" 'second source retains lock claim'
  assert_eq "$saved_lease" "$herdr_receipt_lock_lease_pid" 'second source retains lock lease'
  herdr_receipt_lock_release
  assert_file_absent "$saved_path" 'second source lock can release'
  assert_file_absent "$saved_claim" 'second source claim can release'
  ! kill -0 "$saved_lease" 2>/dev/null || fail 'second source strands lease child'
  trap - EXIT
)
