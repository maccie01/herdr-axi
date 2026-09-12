#!/bin/bash

test_close_tombstone_followup_and_rearm() (
  setup_case close-followup
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] || fail "close did not report success"
  assert_eq closed "$(receipt_read_field 9)" "close tombstone"
  assert_eq 1 "$(receipt_read_field 2)" "close tombstone cycle"
  assert_eq settled "$(receipt_read_field 6)" "close delivered event"
  assert_eq generation:generation-one "$(receipt_read_field 8)" \
    "close settled fingerprint"
  assert_eq generation-one "$(receipt_read_field 10)" \
    "close generation"
  assert_eq close "$(receipt_read_field 11)" "close reason"

  run_hook input '{"title":"Approval","message":"Late input"}'
  assert_eq closed "$(receipt_read_field 9)" "tombstone after input"
  assert_eq closed-tombstone "$(receipt_read_field 11)" "late input suppressed"
  run_hook settled "$(payload)"
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "all post-close notifications suppressed"

  prompt_file="$FAKE_HERDR_CASE/followup.txt"
  printf '%s\n' "next turn" > "$prompt_file"
  export FAKE_HERDR_APPEND_USER=1
  bash "$orchestrator_script" followup worker --prompt-file "$prompt_file" >/dev/null
  assert_eq armed "$(receipt_read_field 4)" "followup armed state"
  assert_eq open "$(receipt_read_field 9)" "followup opens tombstone"
  append_task_complete
  write_current_completion_proof
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  run_hook settled "$(payload)"
  assert_eq 2 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "completion after followup"
)

test_workspace_fallback_shared_by_all_callers() (
  setup_case workspace-fallback
  write_complete_transcript
  unset HERDR_WORKSPACE_ID
  unset HERDR_MONITOR_RECEIPT
  fallback_receipt="$HERDR_RECEIPT_ROOT/ws/worker.event"
  run_hook settled "$(payload)"
  assert_file_present "$fallback_receipt" "hook fallback receipt"

  prompt_file="$FAKE_HERDR_CASE/followup.txt"
  printf '%s\n' "next turn" > "$prompt_file"
  export FAKE_HERDR_APPEND_USER=1
  bash "$orchestrator_script" followup worker --prompt-file "$prompt_file" >/dev/null
  assert_eq armed "$(cut -f 4 "$fallback_receipt")" \
    "orchestrator shared fallback"

  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "new worker" > "$worker_prompt"
  worker_output=$(bash "$worker_script" \
    --name worker-two \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --orchestrator-agent orch)
  assert_eq "$HERDR_RECEIPT_ROOT/ws/worker-two.event" \
    "$(printf '%s\n' "$worker_output" | jq -r '.receipt_file')" \
    "worker shared fallback"
  assert_eq "$(cut -f 10 "$HERDR_RECEIPT_ROOT/ws/worker-two.event")" \
    "$(printf '%s\n' "$worker_output" | jq -r '.generation')" \
    "worker registry generation"
  assert_file_absent "$HERDR_RECEIPT_ROOT/default" "default workspace"
)

test_workspace_resolution_hard_failure() (
  setup_case workspace-failure
  unset HERDR_WORKSPACE_ID
  unset HERDR_MONITOR_RECEIPT
  printf '%s\n' __empty__ > "$FAKE_HERDR_CASE/workspace"
  result_file="$TMPDIR/workspace.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" run_hook lost '{}'
  assert_eq error "$(cut -f 1 "$result_file")" "hook workspace failure"
  assert_eq workspace-unresolved "$(cut -f 2 "$result_file")" \
    "hook workspace reason"

  prompt_file="$FAKE_HERDR_CASE/followup.txt"
  printf '%s\n' "next" > "$prompt_file"
  if bash "$orchestrator_script" followup worker --prompt-file "$prompt_file" \
    >/dev/null 2>&1; then
    fail "orchestrator accepted an unresolved workspace"
  fi
  if bash "$worker_script" \
    --name worker-two \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$prompt_file" \
    --orchestrator-agent orch >/dev/null 2>&1; then
    fail "worker accepted an unresolved workspace"
  fi
  assert_file_absent "$HERDR_RECEIPT_ROOT/default" "hard-failure default"
)

test_close_priority_and_close_failure() (
  setup_case close-priority
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close interrupted a working Herdr turn"
  fi
  assert_eq open "$(receipt_read_field 9)" "working close tombstone"

  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  : > "$FAKE_HERDR_CASE/tab-close-fail"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close succeeded despite tab close failure"
  fi
  assert_eq open "$(receipt_read_field 9)" "failed tab close tombstone"
  rm -f "$FAKE_HERDR_CASE/tab-close-fail"
  bash "$orchestrator_script" close worker >/dev/null
  assert_eq closed "$(receipt_read_field 9)" "successful tab close tombstone"

  setup_case unregistered-close
  write_complete_transcript
  run_hook settled "$(payload)"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close succeeded without a registered lifecycle"
  fi
  assert_eq open "$(receipt_read_field 9)" "unregistered close tombstone"
  assert_eq 0 "$(call_count 'pane close')" \
    "unregistered close pane fallback count"
)

test_registered_tab_close_and_idempotency() (
  setup_case close-two-pane
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  : > "$FAKE_HERDR_CASE/tab-close-deferred"
  registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "registered two-pane close did not report success"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "registered tab after close"
  assert_file_absent "$FAKE_HERDR_CASE/pane-1-alive" \
    "registered agent pane after close"
  assert_file_absent "$FAKE_HERDR_CASE/monitor-1-alive" \
    "registered monitor pane after close"
  assert_file_absent "$registry" "registry after verified close"
  assert_eq 1 "$(call_count 'tab close tab-1')" \
    "registered tab close count"
  assert_eq 1 "$(call_count 'agent wait worker --until unknown')" \
    "registered close event wait count"
  assert_eq 0 "$(call_count 'pane close')" \
    "registered close pane fallback count"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "repeated close was not harmless"
  assert_eq 1 "$(call_count 'tab close tab-1')" \
    "repeated close tab count"
  assert_eq 0 "$(call_count 'pane close')" \
    "repeated close pane count"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "repeated close recreated tab"
)

test_monitor_only_legacy_tab_close() (
  setup_case close-monitor-only
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  jq 'del(.generation)' "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    > "$HERDR_RECEIPT_ROOT/ws/worker.json.tmp"
  mv "$HERDR_RECEIPT_ROOT/ws/worker.json.tmp" \
    "$HERDR_RECEIPT_ROOT/ws/worker.json"
  rm -f "$FAKE_HERDR_CASE/pane-1-alive"
  printf '%s\n' unknown > "$FAKE_HERDR_CASE/status"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "monitor-only registered tab close did not report success"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "monitor-only registered tab after close"
  assert_file_absent "$FAKE_HERDR_CASE/monitor-1-alive" \
    "monitor-only registered pane after close"
  assert_file_absent "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "monitor-only registry after close"
)

test_close_ignores_inherited_paths() (
  setup_case close-wrong-inherited-path
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  foreign_receipt="$HERDR_RECEIPT_ROOT/foreign/worker.event"
  mkdir -p "$(dirname -- "$foreign_receipt")"
  printf '%s\n' foreign-sentinel > "$foreign_receipt"
  output=$(HERDR_WORKSPACE_ID=foreign \
    HERDR_MONITOR_RECEIPT="$foreign_receipt" \
    bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "agent-bound close rejected valid registry"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "wrong inherited path diverted registered tab close"
  assert_file_absent "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "wrong inherited path retained valid registry"
  assert_eq foreign-sentinel "$(< "$foreign_receipt")" \
    "wrong inherited receipt was modified"
  output=$(HERDR_WORKSPACE_ID=foreign \
    HERDR_MONITOR_RECEIPT="$foreign_receipt" \
    bash "$orchestrator_script" close worker)
  [[ "$output" == *'"already_closed":true'* ]] ||
    fail "wrong inherited receipt diverted repeated close"
  assert_eq 1 "$(call_count 'tab close tab-1')" \
    "wrong inherited receipt repeated tab close count"
)

test_close_verifies_resource_disappearance() (
  setup_case close-sticky-tab
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  : > "$FAKE_HERDR_CASE/tab-close-sticky"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close trusted tab-close success without disappearance"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
    "sticky tab unexpectedly disappeared"
  assert_file_present "$FAKE_HERDR_CASE/monitor-1-alive" \
    "sticky monitor pane unexpectedly disappeared"
  assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "sticky close removed registry"
  assert_eq open "$(receipt_read_field 9)" \
    "sticky close wrote tombstone"
)

test_close_transient_probe_is_fail_closed() (
  setup_case close-transient-tab-probe
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  printf '%s\n' 2 > "$FAKE_HERDR_CASE/tab-get-fail-at"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close treated an unreadable tab state as absence"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
    "transient tab probe closed tab"
  assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "transient tab probe removed registry"
  assert_eq open "$(receipt_read_field 9)" \
    "transient tab probe wrote tombstone"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "close did not recover after transient tab probe"
)

test_close_generation_binding() (
  setup_case close-followup-generation
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  original_generation=$(receipt_read_field 10)
  write_current_completion_proof
  followup_prompt="$FAKE_HERDR_CASE/followup.txt"
  printf '%s\n' "followup before close" > "$followup_prompt"
  export FAKE_HERDR_APPEND_USER=1
  bash "$orchestrator_script" followup worker \
    --prompt-file "$followup_prompt" >/dev/null
  followup_generation=$(receipt_read_field 10)
  [[ "$followup_generation" != "$original_generation" ]] ||
    fail "followup did not create a new lifecycle generation"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.proof.${original_generation}" "explicit followup invalidates old proof"
  assert_eq "$followup_generation" \
    "$(jq -r '.generation' "$HERDR_RECEIPT_ROOT/ws/worker.json")" \
    "followup registry generation"
  append_task_complete
  write_current_completion_proof
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  run_hook settled "$(payload)"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "proven followup lifecycle could not close"

  setup_case close-generation-mismatch
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry worker ws different-generation
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close accepted a mismatched lifecycle generation"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
    "generation mismatch closed tab"
  assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "generation mismatch removed registry"
  assert_eq 0 "$(call_count 'tab close tab-1')" \
    "generation mismatch tab close count"
  assert_eq open "$(receipt_read_field 9)" \
    "generation mismatch wrote tombstone"
)

test_transient_process_identity_is_fail_closed() (
  setup_case transient-identity
  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  receipt="$HERDR_MONITOR_RECEIPT"
  mkdir -p "$(dirname -- "$receipt")"
  sleep 30 &
  live_pid=$!
  live_start=$(herdr_process_start "$live_pid")
  printf '%s\t%s\t%s\n' "$live_pid" "$live_start" live > "${receipt}.lock"
  live_inode=$(herdr_path_inode "${receipt}.lock")
  printf '%s\n' "$live_pid" > "$FAKE_HERDR_CASE/ps-fail-pid"
  printf '%s\n' 100 > "$FAKE_HERDR_CASE/ps-fail-count"
  if HERDR_RECEIPT_LOCK_ATTEMPTS=12 \
    herdr_receipt_lock_acquire "$receipt"; then
    fail "transient ps failure reaped a live lock"
  fi
  assert_eq "$live_inode" "$(herdr_path_inode "${receipt}.lock")" \
    "live lock after transient ps failure"

  claim="${receipt}.lock.claim.live"
  printf '%s\t%s\t%s\n' "$live_pid" "$live_start" live > "$claim"
  printf '%s\n' 10 > "$FAKE_HERDR_CASE/ps-fail-count"
  herdr_cleanup_orphan_claims "${receipt}.lock"
  assert_file_present "$claim" "live claim after transient ps failure"

  rm -f "${receipt}.lock" "$claim"
  kill "$live_pid"
  wait "$live_pid" 2>/dev/null || true
)

test_legacy_startup_cancel_repair_is_narrow() (
  for variant in blank drift settled monitor proof foreign; do
    setup_case "legacy-startup-$variant"
    mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      herdr-receipt/3 1 input delivered input input input "" open "" delivered > "$HERDR_MONITOR_RECEIPT"
    write_worker_registry worker ws testgen
    registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
    jq '.stage="created" | .monitor_pane=null' "$registry" > "$TMPDIR/registry"
    mv "$TMPDIR/registry" "$registry"
    rm -f "$FAKE_HERDR_CASE/monitor-1-alive"
    case "$variant" in
      drift) arm_completion_generation other; remove_current_completion_proof ;;
      settled) printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        herdr-receipt/3 1 settled delivered settled settled settled settled open "" delivered > "$HERDR_MONITOR_RECEIPT" ;;
      monitor) jq '.monitor_pane="monitor-1"' "$registry" > "$TMPDIR/registry"; mv "$TMPDIR/registry" "$registry"; : > "$FAKE_HERDR_CASE/monitor-1-alive" ;;
      proof) printf '%s\n' testgen > "${HERDR_MONITOR_RECEIPT}.proof.testgen" ;;
      foreign) : > "$FAKE_HERDR_CASE/extra-pane" ;;
    esac
    run_file="$FAKE_HERDR_CASE/run.json"
    jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" \
      '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"cancelling",cancellation:{from:{name:"worker",pane:"pane-1",tab:"tab-1",generation:"testgen",session:"session-1",receipt:$receipt},evidence:"User authorized stop at startup",output:"Startup dialog"}}]}' > "$run_file"
    if HERDR_AXI_MANAGED_TASK=1 bash "$orchestrator_script" close worker --cancel "$run_file" > "$TMPDIR/result" 2>&1; then
      [[ "$variant" == blank ]] || fail "legacy repair accepted $variant"
      assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "legacy startup retired"
      assert_eq testgen "$(receipt_read_field 10)" "legacy cancellation bound generation"
    else
      [[ "$variant" != blank ]] || fail "legacy startup refused: $(< "$TMPDIR/result")"
      assert_eq 0 "$(call_count '^tab close')" "$variant never closes"
      assert_file_present "$FAKE_HERDR_CASE/tab-alive" "$variant remains inspectable"
    fi
  done
)

test_close_owner_tab_is_refused() (
  setup_case close-owner-tab
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry worker ws
  if HERDR_AXI_OWNER_TAB=tab-1 bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "closed owner tab"
  fi
  assert_eq 0 "$(call_count 'tab close tab-1')" "self close calls"
  : > "$FAKE_HERDR_CASE/extra-pane"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "closed a tab containing an unregistered pane"
  fi
  assert_eq 0 "$(call_count 'tab close tab-1')" "foreign pane close calls"
)

test_cancel_monitor_orphan_requires_checkpoint_and_preserves_foreign_panes() (
  setup_case cancel-monitor-orphan
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  herdr_receipt_lock_acquire "$HERDR_MONITOR_RECEIPT"
  herdr_receipt_rearm_locked "$HERDR_MONITOR_RECEIPT" cancel testgen
  herdr_receipt_lock_release
  write_worker_registry worker ws testgen
  export HERDR_AXI_MANAGED_TASK=1
  run_file="$FAKE_HERDR_CASE/run.json"
  if bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel closed without checkpoint"
  fi
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"cancelling",cancellation:{from:{name:"worker",pane:"pane-1",tab:"tab-1",generation:"testgen",session:"session-1",receipt:$receipt},evidence:"User authorized stop; saved partial state",output:"partial result"}}]}' > "$run_file"
  printf '%s\n' changed-session > "$FAKE_HERDR_CASE/session"
  if bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel closed changed session"
  fi
  printf '%s\n' session-1 > "$FAKE_HERDR_CASE/session"
  : > "$FAKE_HERDR_CASE/agent-get-fail"
  if bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel treated unreadable live pane as absent"
  fi
  rm -f "$FAKE_HERDR_CASE/pane-1-alive"
  : > "$FAKE_HERDR_CASE/extra-pane"
  if bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel closed foreign pane in monitor-only tab"
  fi
  rm -f "$FAKE_HERDR_CASE/extra-pane"
  if HERDR_AXI_OWNER_TAB=tab-1 bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel closed owner tab"
  fi
  assert_eq 0 "$(call_count '^tab close')" "failed validations never close"
  bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "cancel closes orphan tab"
  assert_file_absent "$FAKE_HERDR_CASE/monitor-1-alive" "cancel closes monitor"
  assert_file_absent "$HERDR_RECEIPT_ROOT/ws/worker.json" "cancel removes registry"
  assert_eq "" "$(receipt_read_field 8)" "cancel never fabricates proof"
  assert_eq cancelled "$(receipt_read_field 11)" "cancel tombstone reason"
  bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null
  assert_eq 1 "$(call_count '^tab close')" "cancel retry idempotent"
  run_hook lost '{}'
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "intentional closure suppresses lost notification"
)

test_close_rejects_replacement_identity() (
  for change in session terminal unknown unreadable; do
    setup_case "close-identity-$change"
    write_complete_transcript
    run_hook settled "$(payload)"
    write_worker_registry
    registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
    jq '.native_identity={terminal:"terminal-1",session:"session-1"}' "$registry" > "$TMPDIR/registry"
    mv "$TMPDIR/registry" "$registry"
    case "$change" in
      session|terminal) printf '%s\n' replacement > "$FAKE_HERDR_CASE/$change" ;;
      unknown) printf '%s\n' unknown > "$FAKE_HERDR_CASE/status" ;;
      unreadable) : > "$FAKE_HERDR_CASE/agent-get-fail" ;;
    esac
    if bash "$orchestrator_script" close worker > "$TMPDIR/output" 2>&1; then
      fail "ordinary close accepted $change occupant"
    fi
    assert_eq 0 "$(call_count '^tab close')" "$change occupant never closed"
  done
)
