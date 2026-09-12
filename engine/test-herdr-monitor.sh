#!/bin/bash
set -euo pipefail

if [[ "${1:-}" == "--signal-fixture" ]]; then
  fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/herdr-monitor-signal.XXXXXX")
  cleanup_fixture() {
    rm -rf "$fixture_root"
  }
  trap cleanup_fixture EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '%s\n' "$fixture_root" > "${2:?}"
  while true; do
    sleep 1
  done
fi

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
hook_script="$script_dir/herdr-hook-notify.sh"
monitor_script="$script_dir/herdr-lifecycle-monitor.sh"
worker_script="$script_dir/herdr-worker.sh"
orchestrator_script="$script_dir/herdr-orchestrator.sh"
receipt_script="$script_dir/herdr-receipt.sh"
test_script="$script_dir/test-herdr-monitor.sh"

source "$script_dir/test/harness.sh"
source "$script_dir/test/suites/completion.sh"
source "$script_dir/test/suites/close.sh"
source "$script_dir/test/suites/receipt-locks.sh"
source "$script_dir/test/suites/monitor.sh"
source "$script_dir/test/suites/monitor-cycles.sh"
source "$script_dir/test/suites/startup.sh"
source "$script_dir/test/suites/quota.sh"
source "$script_dir/test/suites/runner.sh"

tests=(
  test_runner_resolves_dependencies_from_incoming_path
  test_receipt_composition_preserves_active_lock
  test_startup_budgets_reject_invalid_before_allocation
  test_startup_budgets_preserve_defaults_and_valid_bounds
  test_worker_provider_defaults_and_explicit_overrides
  test_codex_custom_home_completion_survives_split_monitor_environment
  test_codex_initialization_turn_precedes_exactly_one_assignment
  test_recovered_mode_check_cannot_label_later_failure_unsubmitted
  test_managed_reports_bind_to_current_user_assignment
  test_engine_error_protocol_and_backend_override
  test_session_readiness_retries_observation_but_not_drift
  test_close_rejects_replacement_identity
  test_transcript_completion_rejects_stale_provenance
  test_herdr_blocks_cursor_trust_before_submission
  test_cursor_completion_requires_registered_identity_and_proof
  test_generic_integration_completion_requires_identity_and_proof
  test_missing_integration_fails_before_worker_allocation
  test_missing_native_session_fails_before_submission
  test_monitor_identity_fences_new_assignments
  test_monitor_ready_requires_published_identity
  test_monitor_ready_marker_handshake
  test_rejected_prompt_reuses_monitor_and_cannot_replay_ambiguous_delivery
  test_monitor_start_ack_required_before_prompt
  test_registry_native_identity_survives_start_and_fences_capture
  test_completion_truncation_distinguishes_summary_from_result
  test_completion_report_survives_later_lifecycle_events
  test_split_monitor_preserves_selected_backend
  test_split_monitor_preserves_delivery_mode
  test_quota_protocol_failures_preserve_reports_and_diagnose_node
  test_unknown_readiness_preserves_generation_bound_completion
  test_created_stage_handoff_without_monitor_or_receipt
  test_hook_renders_backend_output_without_holding_receipt_lock
  test_monitor_signal_during_waiter_registration
  test_quota_with_pending_proof_preserves_completed_report
  test_cancel_monitor_orphan_requires_checkpoint_and_preserves_foreign_panes
  test_quota_hook_records_error_without_completion_or_owner_input
  test_quota_handoff_requires_checkpoint_identity_and_paused_worker
  test_claude_report_survives_receipt_ack_but_not_new_task
  test_compact_completion_command_handles_quoted_paths
  test_idle_completion_is_collected
  test_blocked_startup_resumes_owned_pane
  test_blocked_startup_hook_keeps_cancellable_generation
  test_legacy_startup_cancel_repair_is_narrow
  test_claude_startup_requires_verified_auto_mode
  test_monitor_survives_quiet_intervals
  test_monitor_separates_readiness_completion_and_acceptance
  test_failed_native_waits_back_off_and_lost_terminates
  test_backoff_grows_not_just_below_a_loose_attempt_ceiling
  test_managed_inbox_never_prompts_owner
  test_prompt_ack_and_no_nested_agents
  test_close_owner_tab_is_refused
  test_concurrent_settled_once
  test_missing_transcripts_and_stale_copilot
  test_structural_completion_proof_for_all_agents
  test_no_completion_proof_preserves_generation
  test_terminal_dedup_across_nested_events
  test_close_tombstone_followup_and_rearm
  test_workspace_fallback_shared_by_all_callers
  test_workspace_resolution_hard_failure
  test_close_priority_and_close_failure
  test_registered_tab_close_and_idempotency
  test_monitor_only_legacy_tab_close
  test_close_ignores_inherited_paths
  test_close_verifies_resource_disappearance
  test_close_transient_probe_is_fail_closed
  test_close_generation_binding
  test_receipt_override_is_agent_bound
  test_lock_parallelism_and_subshell_identity
  test_lock_reaping_and_exact_identity
  test_transient_process_identity_is_fail_closed
  test_lock_lease_parent_identity_is_fail_closed
  test_sigkill_lock_and_claim_cleanup
  test_lock_timeout_machine_result
  test_delivery_failure_waits_for_transition
  test_hot_loop_negative_probe
  test_same_name_restart_and_new_cycle
  test_monitor_rearm_across_idle_and_fast_completion
  test_blocked_working_cycle_preserves_assignment_and_proof
  test_monitor_rearm_unknown_and_failure_are_not_new_assignments
  test_worker_prompt_failure_is_not_success
  test_prompt_delivery_for_all_agent_kinds
  test_event_bounded_pane_readiness
  test_signal_cleanup_fixture
)

for test_name in "${tests[@]}"; do
  if [[ -n "${HERDR_MONITOR_TEST_FILTER:-}" &&
    "$test_name" != "$HERDR_MONITOR_TEST_FILTER" ]]; then
    continue
  fi
  "$test_name"
  printf 'ok - %s\n' "$test_name"
done
