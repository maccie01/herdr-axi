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
notify_reason=""
displayed_state=""
cleanup() {
  for child_pid in "$wait_pid_one" "$wait_pid_two"; do
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

wait_for_transition() {
  local name="$1"
  local baseline="$2"
  local marker="$3"
  local role="$4"
  local observed wait_command_pid=""
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
  herdr "${wait_args[@]}" >/dev/null 2>&1 &
  wait_command_pid=$!
  trap '
    if [[ -n "$wait_command_pid" ]] && kill -0 "$wait_command_pid" 2>/dev/null; then
      kill "$wait_command_pid" 2>/dev/null || true
    fi
    wait "$wait_command_pid" 2>/dev/null || true
    exit 143
  ' HUP INT TERM
  if ! wait "$wait_command_pid"; then
    trap - HUP INT TERM
    return 1
  fi
  wait_command_pid=""
  trap - HUP INT TERM
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
      sleep 1
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
        notify_reason="$reason"
        return 10
        ;;
      error|"")
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
    if [[ -s "$wait_marker" ]]; then
      transition_state=$(cut -f 2 "$wait_marker")
      wait "$wait_pid_one" 2>/dev/null || true
      wait_pid_one=""
      rm -f "$wait_marker"
      wait_marker=""
      return 0
    fi
    if ! kill -0 "$wait_pid_one" 2>/dev/null; then
      wait "$wait_pid_one" 2>/dev/null || true
      wait_pid_one=""
      rm -f "$wait_marker"
      wait_marker=""
      sleep 1
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
  if herdr_receipt_read "$receipt_file"; then
    pending_rearm=true
    pending_cycle="$receipt_cycle"
    pending_settled="$receipt_settled_fingerprint"
  fi
}

apply_pending_rearm() {
  [[ "$pending_rearm" == "true" ]] || return 0
  herdr_receipt_rearm_if_unchanged \
    "$receipt_file" "$pending_cycle" "$pending_settled" monitor-working
  pending_rearm=false
  pending_cycle=""
  pending_settled=""
}

while true; do
  current_state=$(state "$agent_name") || {
    notify lost || true
    exit 0
  }
  if [[ "$current_state" != "$displayed_state" ]]; then
    printf 'agent: %s\nstate: %s\n' "$agent_name" "$current_state"
    displayed_state="$current_state"
  fi
  if [[ "$current_state" == "working" && "$pending_rearm" == "true" ]]; then
    apply_pending_rearm || exit 0
  fi

  case "$current_state" in
    done|idle)
      notify_status=0
      notify settled || notify_status=$?
      case "$notify_status" in
        0)
          remember_rearm_boundary
          wait_worker_transition "$current_state" || exit 0
          if [[ "$transition_state" == "working" ]]; then
            apply_pending_rearm || exit 0
          fi
          ;;
        10)
          if [[ "$notify_reason" != "no-completion-proof" ]]; then
            remember_rearm_boundary
          fi
          wait_worker_transition "$current_state" || exit 0
          if [[ "$transition_state" == "working" &&
            "$pending_rearm" == "true" ]]; then
            apply_pending_rearm || exit 0
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
            apply_pending_rearm || exit 0
          fi
          ;;
        11) remember_rearm_boundary ;;
        *) exit 0 ;;
      esac
      ;;
    working)
      wait_worker_transition "$current_state" || exit 0
      if [[ "$transition_state" == "working" && "$pending_rearm" == "true" ]]; then
        apply_pending_rearm || exit 0
      fi
      ;;
    *)
      wait_worker_transition "$current_state" || {
        notify lost || true
        exit 0
      }
      ;;
  esac
done
