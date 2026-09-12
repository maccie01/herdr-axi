#!/bin/bash
set -euo pipefail

if [[ "${HERDR_ENV:-}" != "1" ]]; then
  printf '%s\n' "herdr-lifecycle-monitor: not running inside Herdr" >&2
  exit 2
fi

if (( $# != 5 )); then
  printf '%s\n' "usage: $0 AGENT LABEL ORCHESTRATOR RECEIPT HOOK" >&2
  exit 2
fi

agent_name="$1"
agent_label="$2"
orchestrator_agent="$3"
receipt_file="$4"
hook_script="$5"
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=herdr-receipt.sh
source "$script_dir/herdr-receipt.sh"

wait_pid_one=""
wait_pid_two=""
wait_marker=""
transition_state=""
pending_rearm=false
pending_cycle=""
pending_settled=""
pending_generation=""
notify_reason=""
displayed_state=""
retry_delay=1
cleanup() {
  # Include a helper spawned just before its PID was assigned.
  for child_pid in $(jobs -pr); do
    if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
      kill "$child_pid" 2>/dev/null || true
      wait "$child_pid" 2>/dev/null || true
    fi
  done
  [[ -z "$wait_marker" ]] || rm -f "$wait_marker"
  herdr_receipt_lock_release
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

state() {
  herdr agent get "$1" 2>/dev/null |
    jq -r '.result.agent.agent_status // empty' 2>/dev/null
}

# Publish before the ready acknowledgement. Leave the identity after exit so a
# later rearm can distinguish this dead process from a surviving terminal pane.
record_monitor_owner() {
  local started temporary=""
  started=$(herdr_process_start "$$" || true)
  if [[ -n "$started" && "$(herdr_lock_owner_state "$$" "$started")" == live ]] &&
    mkdir -p "$(dirname -- "$receipt_file")" &&
    temporary=$(mktemp "${receipt_file}.monitor-owner.XXXXXXXX") &&
    printf '%s\t%s\n' "$$" "$started" > "$temporary" &&
    [[ ! -d "${receipt_file}.monitor-owner" ]] &&
    mv -f "$temporary" "${receipt_file}.monitor-owner"; then
    return 0
  fi
  [[ -z "$temporary" ]] || rm -f "$temporary"
  herdr_engine_error MONITOR_START_UNVERIFIED "cannot publish live monitor identity for $agent_name; no ready acknowledgement. Inspect process visibility and receipt permissions; cancel the owned task before replacement, do not resend its prompt."
  return 1
}

# Display only: small receipt/hint reads, no backend polls or lifecycle mutations.
# Agent readiness and coordinator acceptance are independent states.
display_status() {
  local agent_state="${1:-unknown}" task_state proof_state=missing snapshot
  local generation="" saved_schema="" saved_state="" saved_generation="" coordinator=""
  local task_file="${receipt_file%.event}.task"
  case "$agent_state" in
    done|idle) task_state=awaiting-proof ;;
    working) task_state=running ;;
    *) task_state="$agent_state" ;;
  esac
  if herdr_receipt_read "$receipt_file" && [[ -n "$receipt_generation" ]]; then
    generation="$receipt_generation"
    proof_state=pending
    if [[ "$receipt_settled_fingerprint" == "generation:$generation" ]]; then proof_state=complete; fi
  fi
  if [[ -e "$task_file" ]]; then
    # Tiny post-commit display hint; shell read only, no jq or run-file scan.
    # Bad metadata cannot erase an independently valid local completion receipt.
    if IFS=$'\t' read -r saved_schema saved_state saved_generation < "$task_file" 2>/dev/null &&
      [[ "$saved_schema" == "herdr-task/1" && "$saved_state" =~ ^(starting|running|switching|cancelling|uncertain|accepted|cancelled)$ && "$saved_generation" =~ ^[a-zA-Z0-9-]+$ ]]; then
      [[ "$generation" == "$saved_generation" ]] || proof_state=pending
      case "$saved_state" in running|accepted) ;; *) proof_state=pending ;; esac
      if [[ "$saved_state" != "running" ]]; then task_state="$saved_state"; fi
    else
      coordinator=unavailable
    fi
  fi
  if [[ "$proof_state" == "complete" && "$task_state" == "awaiting-proof" ]]; then task_state=review; fi
  snapshot=$(printf 'agent: %s\ntask: %s\nproof: %s' "$agent_state" "$task_state" "$proof_state")
  [[ -z "$coordinator" ]] || snapshot+=$'\ncoordinator: unavailable'
  if [[ "$snapshot" != "$displayed_state" ]]; then
    printf '%s\n\n' "$snapshot"
    displayed_state="$snapshot"
  fi
}

# Broken/expired native waits must not turn transcript collection into a hot
# loop. Stay supervised; real transitions reset this bounded failure backoff.
backoff() {
  sleep "$retry_delay" &
  wait_pid_one=$!
  wait "$wait_pid_one" || true
  wait_pid_one=""
  retry_delay=$((retry_delay * 2))
  (( retry_delay <= 30 )) || retry_delay=30
}

wait_for_transition() {
  local name="$1"
  local baseline="$2"
  local marker="$3"
  local role="$4"
  local observed wait_command_pid="" wait_interrupted=false wait_status=0
  local wait_args=(agent wait "$name")
  case "$baseline" in
    working)
      wait_args+=(--until idle --until done --until blocked)
      ;;
    idle)
      wait_args+=(--until working --until done --until blocked)
      ;;
    done)
      wait_args+=(--until working --until idle --until blocked)
      ;;
    blocked)
      wait_args+=(--until working --until idle --until done)
      ;;
    *)
      wait_args+=(--until working --until idle --until done --until blocked)
      ;;
  esac
  # Defer exit until spawn/PID registration finishes. A trap that exits before
  # $! is assigned loses the backend child; ignoring the signal loses shutdown.
  trap 'wait_interrupted=true; if [[ -n "$wait_command_pid" ]]; then kill "$wait_command_pid" 2>/dev/null || true; fi' HUP INT TERM
  # Invoke the executable directly: the HERDR_BIN shell-function adapter would
  # otherwise add an intermediate process and leave the real waiter orphaned.
  command "${HERDR_BIN:-herdr}" "${wait_args[@]}" >/dev/null 2>&1 &
  wait_command_pid=$!
  if [[ "$wait_interrupted" == "true" ]]; then kill "$wait_command_pid" 2>/dev/null || true; fi
  wait "$wait_command_pid" || wait_status=$?
  # A signal interrupts Bash wait before the child is reaped.
  if [[ "$wait_interrupted" == "true" ]]; then
    wait "$wait_command_pid" 2>/dev/null || true
    exit 143
  fi
  wait_command_pid=""
  trap - HUP INT TERM
  (( wait_status == 0 )) || return 1
  observed=$(state "$name" || true)
  [[ -n "$observed" && "$observed" != "$baseline" ]] || return 1
  printf '%s\t%s\n' "$role" "$observed" > "$marker"
}

wait_for_any_transition() {
  local worker_baseline="$1"
  local orchestrator_baseline="$2"
  local ticks="${HERDR_MONITOR_CHANGE_WAIT_TICKS:-600}"
  local tick
  wait_marker=$(mktemp "${TMPDIR:-/tmp}/herdr-monitor-transition.XXXXXX") || return 1
  rm -f "$wait_marker"

  wait_for_transition "$agent_name" "$worker_baseline" "$wait_marker" worker &
  wait_pid_one=$!
  wait_for_transition "$orchestrator_agent" "$orchestrator_baseline" "$wait_marker" orchestrator &
  wait_pid_two=$!

  tick=0
  while (( tick < ticks )); do
    if (( tick % 50 == 0 )); then display_status "$worker_baseline"; fi
    if [[ -s "$wait_marker" ]]; then
      for child_pid in "$wait_pid_one" "$wait_pid_two"; do
        if kill -0 "$child_pid" 2>/dev/null; then
          kill "$child_pid" 2>/dev/null || true
        fi
        wait "$child_pid" 2>/dev/null || true
      done
      wait_pid_one=""
      wait_pid_two=""
      rm -f "$wait_marker"
      wait_marker=""
      retry_delay=1
      return 0
    fi
    if ! kill -0 "$wait_pid_one" 2>/dev/null &&
      ! kill -0 "$wait_pid_two" 2>/dev/null; then
      wait "$wait_pid_one" 2>/dev/null || true
      wait "$wait_pid_two" 2>/dev/null || true
      wait_pid_one=""
      wait_pid_two=""
      rm -f "$wait_marker"
      wait_marker=""
      # Native waits can expire or lose their connection without a transition.
      # Retry with backoff; a quiet minute is not the end of supervision.
      backoff
      return 0
    fi
    tick=$((tick + 1))
    sleep 0.1
  done

  for child_pid in "$wait_pid_one" "$wait_pid_two"; do
    if kill -0 "$child_pid" 2>/dev/null; then
      kill "$child_pid" 2>/dev/null || true
    fi
    wait "$child_pid" 2>/dev/null || true
  done
  wait_pid_one=""
  wait_pid_two=""
  rm -f "$wait_marker"
  wait_marker=""
  return 0
}

notify() {
  local event_kind="$1"
  local result_file outcome reason worker_before orchestrator_before worker_after
  local lost_attempts=0
  notify_reason=""
  while true; do
    result_file=$(mktemp "${TMPDIR:-/tmp}/herdr-monitor-result.XXXXXX") || return 1
    rm -f "$result_file"
    env \
      HERDR_MONITOR_ENABLED=1 \
      HERDR_MONITOR_ORCHESTRATOR="$orchestrator_agent" \
      HERDR_MONITOR_AGENT="$agent_name" \
      HERDR_MONITOR_LABEL="$agent_label" \
      HERDR_MONITOR_RECEIPT="$receipt_file" \
      HERDR_MONITOR_RESULT_FILE="$result_file" \
      bash "$hook_script" "$event_kind" </dev/null

    outcome=""
    reason=""
    if [[ -r "$result_file" ]]; then
      { IFS=$'\t' read -r outcome reason < "$result_file"; } 2>/dev/null || true
    fi
    rm -f "$result_file"

    case "$outcome" in
      delivered) return 0 ;;
      suppressed)
        [[ "$event_kind" != "lost" ]] || return 0
        notify_reason="$reason"
        return 10
        ;;
      error|"")
        # A lost worker cannot transition, but its hook may only be temporarily
        # locked. Retry delivery finitely, without waiting for a nonexistent pane.
        if [[ "$event_kind" == "lost" ]]; then
          lost_attempts=$((lost_attempts + 1))
          (( lost_attempts < 3 )) || return 1
          backoff
          continue
        fi
        worker_before=$(state "$agent_name" || true)
        orchestrator_before=$(state "$orchestrator_agent" || true)
        if ! wait_for_any_transition "$worker_before" "$orchestrator_before"; then
          return 1
        fi
        worker_after=$(state "$agent_name" || true)
        if [[ "$worker_after" != "$worker_before" ]]; then
          return 11
        fi
        ;;
      *) return 1 ;;
    esac
  done
}

report_lost() {
  display_status lost
  retry_delay=1
  if notify lost; then return 0; fi
  herdr_receipt_read "$receipt_file" || true
  if [[ -z "$receipt_generation" ]]; then
    receipt_generation=$(jq -r '.generation // empty' "${receipt_file%.event}.json" 2>/dev/null || true)
  fi
  local notice="Lost notification failed after 3 attempts; inspect receipt/hook availability"
  local temporary="${receipt_file}.monitor-error.$$"
  if mkdir -p "$(dirname -- "$receipt_file")" && printf '%s\t%s\n' "${receipt_generation:--}" "$notice" > "$temporary"; then
    mv -f "$temporary" "${receipt_file}.monitor-error" || true
  fi
  printf '%s\n' "$notice" >&2
  return 1
}

wait_worker_transition() {
  local baseline="$1"
  local ticks="${HERDR_MONITOR_CHANGE_WAIT_TICKS:-600}"
  local tick=0
  transition_state=""
  wait_marker=$(mktemp "${TMPDIR:-/tmp}/herdr-monitor-worker.XXXXXX") || return 1
  rm -f "$wait_marker"
  wait_for_transition "$agent_name" "$baseline" "$wait_marker" worker &
  wait_pid_one=$!
  while (( tick < ticks )); do
    if (( tick % 50 == 0 )); then display_status "$baseline"; fi
    if [[ -s "$wait_marker" ]]; then
      transition_state=$(cut -f 2 "$wait_marker")
      wait "$wait_pid_one" 2>/dev/null || true
      wait_pid_one=""
      rm -f "$wait_marker"
      wait_marker=""
      retry_delay=1
      return 0
    fi
    if ! kill -0 "$wait_pid_one" 2>/dev/null; then
      wait "$wait_pid_one" 2>/dev/null || true
      wait_pid_one=""
      rm -f "$wait_marker"
      wait_marker=""
      backoff
      transition_state=$(state "$agent_name" || true)
      return 0
    fi
    tick=$((tick + 1))
    sleep 0.1
  done
  if kill -0 "$wait_pid_one" 2>/dev/null; then
    kill "$wait_pid_one" 2>/dev/null || true
  fi
  wait "$wait_pid_one" 2>/dev/null || true
  wait_pid_one=""
  rm -f "$wait_marker"
  wait_marker=""
  transition_state=$(state "$agent_name" || true)
  return 0
}

remember_rearm_boundary() {
  pending_rearm=false
  pending_cycle=""
  pending_settled=""
  pending_generation=""
  if herdr_receipt_read "$receipt_file"; then
    pending_rearm=true
    pending_cycle="$receipt_cycle"
    pending_settled="$receipt_settled_fingerprint"
    pending_generation="$receipt_generation"
  fi
}

apply_pending_rearm() {
  [[ "$pending_rearm" == "true" ]] || return 0
  # A native state transition cannot invent an assignment for a legacy receipt.
  if [[ -n "$pending_generation" ]] && ! herdr_receipt_rearm_if_unchanged \
    "$receipt_file" "$pending_cycle" "$pending_settled" monitor-working "$pending_generation"; then
    local notice="Lifecycle receipt rearm failed; inspect receipt/lock before restarting supervision"
    local temporary="${receipt_file}.monitor-error.$$"
    if printf '%s\t%s\n' "$pending_generation" "$notice" > "$temporary"; then
      mv -f "$temporary" "${receipt_file}.monitor-error" || true
    fi
    printf '%s\n' "$notice" >&2
    return 1
  fi
  pending_rearm=false
  pending_cycle=""
  pending_settled=""
  pending_generation=""
}

record_monitor_owner || exit 1
while true; do
  current_state=$(state "$agent_name") || {
    if report_lost; then exit 0; else exit 1; fi
  }
  if [[ -n "${HERDR_MONITOR_READY:-}" ]]; then
    printf 'herdr-monitor-ready:%s\n' "$HERDR_MONITOR_READY"
    if ! herdr_monitor_ready_publish "$receipt_file" "$HERDR_MONITOR_READY"; then
      herdr_engine_error MONITOR_START_UNVERIFIED "cannot publish the ready marker for $agent_name; no ready acknowledgement"
      exit 1
    fi
    unset HERDR_MONITOR_READY
  fi
  if [[ "$current_state" == "working" && "$pending_rearm" == "true" ]]; then
    apply_pending_rearm || exit 1
  fi
  display_status "$current_state"

  case "$current_state" in
    done|idle)
      notify_status=0
      notify settled || notify_status=$?
      case "$notify_status" in
        0)
          remember_rearm_boundary
          wait_worker_transition "$current_state" || exit 0
          if [[ "$transition_state" == "working" ]]; then
            apply_pending_rearm || exit 1
          fi
          ;;
        10)
          if [[ "$notify_reason" != "no-completion-proof" ]]; then
            remember_rearm_boundary
          fi
          wait_worker_transition "$current_state" || exit 0
          if [[ "$transition_state" == "working" &&
            "$pending_rearm" == "true" ]]; then
            apply_pending_rearm || exit 1
          fi
          ;;
        11) remember_rearm_boundary ;;
        *) exit 0 ;;
      esac
      ;;
    blocked)
      notify_status=0
      notify input || notify_status=$?
      case "$notify_status" in
        0|10)
          remember_rearm_boundary
          wait_worker_transition blocked || exit 0
          if [[ "$transition_state" == "working" ]]; then
            apply_pending_rearm || exit 1
          fi
          ;;
        11) remember_rearm_boundary ;;
        *) exit 0 ;;
      esac
      ;;
    working)
      wait_worker_transition "$current_state" || exit 0
      if [[ "$transition_state" == "working" && "$pending_rearm" == "true" ]]; then
        apply_pending_rearm || exit 1
      fi
      ;;
    *)
      if [[ "$current_state" == "unknown" && "${HERDR_MONITOR_INBOX:-0}" == "1" ]]; then
        notify quota || true
      fi
      wait_worker_transition "$current_state" || {
        if report_lost; then exit 0; else exit 1; fi
      }
      ;;
  esac
done
