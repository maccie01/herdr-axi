#!/bin/bash

test_quota_handoff_requires_checkpoint_identity_and_paused_worker() (
  setup_case quota-handoff
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  herdr_receipt_lock_acquire "$HERDR_MONITOR_RECEIPT"
  herdr_receipt_rearm_locked "$HERDR_MONITOR_RECEIPT" handoff testgen
  herdr_receipt_lock_release
  write_worker_registry worker ws testgen
  export HERDR_AXI_MANAGED_TASK=1
  run_file="$FAKE_HERDR_CASE/run.json"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed without durable checkpoint"
  fi
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"switching",handoffs:[{from:{name:"worker",kind:"copilot",pane:"pane-1",tab:"tab-1",generation:"testgen",session:"session-1",receipt:$receipt},to:{kind:"codex"},quota:{code:"QUOTA_EXHAUSTED"},output:"saved partial work"}]}]}' > "$run_file"
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed an active worker"
  fi
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  printf '%s\n' changed-session > "$FAKE_HERDR_CASE/session"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed a changed session"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" "failed checks preserve tab"
  printf '%s\n' session-1 > "$FAKE_HERDR_CASE/session"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed without a current quota error"
  fi
  printf '%s\n' "You've hit your usage limit" > "$FAKE_HERDR_CASE/visible"
  node() { cat >/dev/null; printf '%s' "${FAKE_QUOTA_OUTPUT:-}"; }
  export -f node
  for invalid in '' 'null' '{}' '[]' '{"code":"OTHER"}' 'partial'; do
    if HERDR_AXI_NODE=node FAKE_QUOTA_OUTPUT="$invalid" bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
      fail "handoff accepted invalid quota protocol: $invalid"
    fi
    assert_eq 0 "$(call_count '^tab close')" "invalid quota preserves tab"
  done
  unset -f node
  printf '%s\n' "You've hit your usage limit" 'Do you want to proceed?' '❯ 1. Yes' '  2. No' > "$FAKE_HERDR_CASE/visible"
  printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed a permission dialog with retained quota text"
  fi
  assert_eq 0 "$(call_count '^tab close')" "dialog preserves tab"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "You've hit your usage limit" > "$FAKE_HERDR_CASE/visible"
  write_current_completion_proof
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed while current completion proof awaited collection"
  fi
  assert_eq 0 "$(call_count '^tab close')" "pending proof preserves tab"
  remove_current_completion_proof
  : > "$FAKE_HERDR_CASE/start-on-read"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed worker that resumed during quota read"
  fi
  printf '%s\n' unknown > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "normal close bypassed missing completion"
  fi
  bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "handoff closes recorded tab"
  assert_eq "" "$(receipt_read_field 8)" "handoff never fabricates completion"
  assert_eq closed "$(receipt_read_field 9)" "handoff tombstone"
  assert_eq handoff "$(receipt_read_field 11)" "handoff reason"
  bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null
  assert_eq 1 "$(call_count '^tab close')" "retry never closes twice"
)

test_quota_hook_records_error_without_completion_or_owner_input() (
  setup_case quota-hook
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  herdr_receipt_lock_acquire "$HERDR_MONITOR_RECEIPT"
  herdr_receipt_rearm_locked "$HERDR_MONITOR_RECEIPT" quota testgen
  herdr_receipt_lock_release
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "You've hit your limit · resets later" > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook settled '{}'
  assert_eq error "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "quota is error, never settled"
  assert_eq QUOTA_EXHAUSTED "$(jq -r '.quota.code' "${HERDR_MONITOR_RECEIPT}.inbox")" "quota diagnostic"
  assert_eq testgen "$(jq -r '.generation' "${HERDR_MONITOR_RECEIPT}.inbox")" "generation bound"
  assert_eq "" "$(receipt_read_field 8)" "no fabricated completion proof"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "never inject owner input"
  printf '%s\n' unknown > "$FAKE_HERDR_CASE/status"
  HERDR_MONITOR_INBOX=1 run_hook quota '{}'
  assert_eq suppressed "$(receipt_read_field 4)" "duplicate quota suppressed"
  printf '%s\n' 'ordinary output, not quota' > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook quota '{}'
  assert_eq QUOTA_EXHAUSTED "$(jq -r '.quota.code' "${HERDR_MONITOR_RECEIPT}.inbox")" "no-quota probe cannot overwrite evidence"

  setup_case quota-after-completion
  write_complete_transcript
  HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
  saved_inbox=$(< "${HERDR_MONITOR_RECEIPT}.inbox")
  printf '%s\n' "You've hit your limit" > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook error '{}'
  assert_eq "$saved_inbox" "$(< "${HERDR_MONITOR_RECEIPT}.inbox")" "completed result survives later quota"
  assert_eq completed-task-quota "$(receipt_read_field 11)" "completed quota suppression reason"
)

test_quota_with_pending_proof_preserves_completed_report() (
  for kind in copilot claude codex; do
    setup_case "quota-pending-proof-$kind"
    printf '%s\n' "$kind" > "$FAKE_HERDR_CASE/kind"
    case "$kind" in
      copilot) write_complete_transcript ;;
      claude) write_claude_transcript >/dev/null; arm_completion_generation ;;
      codex) write_codex_transcript >/dev/null; arm_completion_generation ;;
    esac
    printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
    printf '%s\n' "You've hit your usage limit" > "$FAKE_HERDR_CASE/visible"
    HERDR_MONITOR_INBOX=1 run_hook error '{}'
    assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "$kind proof wins before first settlement"
    assert_eq generation:generation-one "$(receipt_read_field 8)" "$kind proof committed"
    assert_eq QUOTA_EXHAUSTED "$(jq -r '.quota.code' "${HERDR_MONITOR_RECEIPT}.inbox")" "$kind quota retained separately"
    saved=$(< "${HERDR_MONITOR_RECEIPT}.inbox")
    [[ "$saved" == *'"summary":"complete"'* || "$saved" == *'"summary":"intermediate"'* ]] || fail "$kind report replaced by quota"
    HERDR_MONITOR_INBOX=1 run_hook settled '{}'
    assert_eq "$saved" "$(< "${HERDR_MONITOR_RECEIPT}.inbox")" "$kind retry preserves result"
  done
  setup_case quota-proof-empty-native-report
  printf '%s\n' '{"type":"session.task_complete","data":{"summary":""}}' > "$(transcript_path)"
  arm_completion_generation
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  printf '%s\n' 'VISIBLE_RESULT: checks passed' 'You have exceeded your monthly quota' > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook error '{}'
  assert_eq error "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "unbound empty native report cannot borrow proof"
  assert_eq null "$(jq -r '.completion' "${HERDR_MONITOR_RECEIPT}.inbox")" "unbound visible text is not a current report"
  for invalid in absent stale malformed unfinished; do
    setup_case "quota-invalid-proof-$invalid"
    write_complete_transcript
    case "$invalid" in
      absent) remove_current_completion_proof ;;
      stale) printf '%s\n' old-generation > "${HERDR_MONITOR_RECEIPT}.proof.generation-one" ;;
      malformed) printf '%s' generation-one > "${HERDR_MONITOR_RECEIPT}.proof.generation-one" ;;
      unfinished) append_user_message ;;
    esac
    printf '%s\n' "You have exceeded your monthly quota" > "$FAKE_HERDR_CASE/visible"
    HERDR_MONITOR_INBOX=1 run_hook settled '{}'
    assert_eq error "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "$invalid proof cannot defeat quota"
    assert_eq "" "$(receipt_read_field 8)" "$invalid proof cannot complete"
  done
)

test_quota_protocol_failures_preserve_reports_and_diagnose_node() (
  node() { cat >/dev/null; printf '%s' "${FAKE_QUOTA_OUTPUT:-}"; }
  export -f node
  for invalid in '' 'null' '{}' '[]' 'partial'; do
    setup_case "quota-protocol-${#invalid}-$RANDOM"
    write_complete_transcript
    HERDR_AXI_NODE=node FAKE_QUOTA_OUTPUT="$invalid" HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
    assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "invalid optional quota cannot lose report"
    assert_eq 'complete' "$(jq -r '.summary' "${HERDR_MONITOR_RECEIPT}.inbox")" "report preserved"
  done
  unset -f node
  setup_case missing-node-diagnostic
  export HERDR_MONITOR_RESULT_FILE="$TMPDIR/result"
  if HERDR_AXI_NODE=/missing-herdr-node bash "$hook_script" quota '{}' 2> "$TMPDIR/error"; then fail "missing node silently succeeded"; fi
  assert_eq $'error\tmissing-node' "$(< "$HERDR_MONITOR_RESULT_FILE")" "machine-readable missing node"
  [[ "$(< "$TMPDIR/error")" == *'missing dependency: node'* ]] || fail "node diagnosis absent"
  write_complete_transcript
  HERDR_AXI_NODE="$(command -v node)" HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
  assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "pinned node restores collection"
)

test_created_stage_handoff_without_monitor_or_receipt() (
  setup_case created-handoff
  source "$receipt_script"
  write_worker_registry worker ws testgen
  registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
  jq '.stage="created" | .monitor_pane=null' "$registry" > "$TMPDIR/registry"
  mv "$TMPDIR/registry" "$registry"
  rm "$FAKE_HERDR_CASE/monitor-1-alive"
  export HERDR_AXI_MANAGED_TASK=1
  run_file="$FAKE_HERDR_CASE/run.json"
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"switching",handoffs:[{from:{name:"worker",kind:"copilot",pane:"pane-1",tab:"tab-1",generation:"testgen",session:"session-1",receipt:$receipt},to:{kind:"codex"},quota:{code:"QUOTA_EXHAUSTED"},output:"startup checkpoint"}]}]}' > "$run_file"
  printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "You've hit your session limit" > "$FAKE_HERDR_CASE/visible"
  bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "created tab retired"
  assert_eq 1 "$(call_count '^tab close')" "whole startup tab closed once"
)
