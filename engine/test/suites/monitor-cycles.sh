#!/bin/bash

test_same_name_restart_and_new_cycle() (
  setup_case same-name
  write_complete_transcript
  remove_current_completion_proof
  rm -f "$HERDR_MONITOR_RECEIPT"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "first" > "$worker_prompt"
  bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null
  assert_eq 1 "$(receipt_read_field 2)" "first worker cycle"

  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "second" > "$worker_prompt"
  bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null
  assert_eq 2 "$(receipt_read_field 2)" "same-name restart cycle"
  assert_eq armed "$(receipt_read_field 4)" "same-name restart armed"
)

test_monitor_rearm_unknown_and_failure_are_not_new_assignments() (
  for variant in blank corrupt; do
    setup_case "monitor-rearm-$variant"
    arm_completion_generation assignment-one
    remove_current_completion_proof
    if [[ "$variant" == blank ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        herdr-receipt/3 1 input delivered input input input "" open "" legacy > "$HERDR_MONITOR_RECEIPT"
    fi
    printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
    HERDR_MONITOR_INBOX=1 HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
      bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$TMPDIR/monitor-output" 2> "$TMPDIR/monitor-error" &
    monitor_pid=$!
    for _ in $(seq 1 250); do
      (( $(call_count '^agent wait worker') >= 1 )) && break
      sleep 0.02
    done
    (( $(call_count '^agent wait worker') >= 1 )) || fail "$variant blocked boundary not captured"
    [[ "$variant" != corrupt ]] || printf '%s\n' corrupt > "$HERDR_MONITOR_RECEIPT"
    printf '%s\n' working > "$FAKE_HERDR_CASE/status"
    if [[ "$variant" == corrupt ]]; then
      wait_for_file "${HERDR_MONITOR_RECEIPT}.monitor-error" || fail "rearm failure was hidden"
      if wait "$monitor_pid"; then fail "failed rearm reported successful monitor exit"; fi
      assert_eq assignment-one "$(cut -f 1 "${HERDR_MONITOR_RECEIPT}.monitor-error")" "failure retains known assignment"
      rg -q 'Lifecycle receipt rearm failed' "$TMPDIR/monitor-error" || fail "missing rearm diagnostic"
      assert_eq corrupt "$(< "$HERDR_MONITOR_RECEIPT")" "failed rearm did not invent a receipt"
    else
      for _ in $(seq 1 250); do
        (( $(call_count '^agent wait worker') >= 2 )) && break
        sleep 0.02
      done
      (( $(call_count '^agent wait worker') >= 2 )) || fail "legacy monitor never resumed waiting"
      assert_eq "" "$(receipt_read_field 10)" "native resume cannot invent legacy assignment"
      assert_eq 1 "$(receipt_read_field 2)" "unowned legacy cycle not rearmed"
      kill "$monitor_pid" 2>/dev/null || true
      wait "$monitor_pid" 2>/dev/null || true
    fi
    assert_no_fake_waiters "$variant rearm cleanup"
  done
)
