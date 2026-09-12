#!/bin/bash
set -euo pipefail

if [[ "${HERDR_ENV:-}" != "1" ]]; then
  printf '%s\n' "herdr-orchestrator: not running inside Herdr" >&2
  exit 2
fi

for dependency in "${HERDR_BIN:-herdr}" jq rg cut awk find mktemp stat ps "${HERDR_AXI_NODE:-node}"; do
  command -v "$dependency" >/dev/null || {
    printf '%s\n' "herdr-orchestrator: missing dependency: $dependency" >&2
    exit 2
  }
done

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=herdr-receipt.sh
source "$script_dir/herdr-receipt.sh"
source "$script_dir/herdr-close.sh"
registry_dir=""

usage() {
  printf '%s\n' \
    "usage:" \
    "  $0 start <herdr-worker.sh options>" \
    "  $0 inspect NAME [NAME ...]" \
    "  $0 result NAME" \
    "  $0 followup NAME --prompt-file PATH" \
    "  $0 retry NAME --prompt-file PATH  # explicit pre-submit rejection only" \
    "  $0 close NAME" >&2
  exit 2
}

agent_info() {
  herdr agent get "$1"
}

resolve_agent_paths() {
  local name="$1"
  local workspace_hint="${2:-}"
  if ! herdr_receipt_resolve "$name" "$workspace_hint" "$name"; then
    printf '%s\n' "herdr-orchestrator: workspace could not be resolved: $name" >&2
    return 1
  fi
  registry_dir="$HERDR_RECEIPT_REGISTRY_DIR"
}

receipt_state() {
  local receipt_file="$1"
  herdr_receipt_read "$receipt_file" || return 1
  if [[ "$receipt_terminal" == "closed" ]]; then
    printf '%s\n' done
    return 0
  fi
  if [[ -n "$receipt_settled_fingerprint" ]]; then
    printf '%s\n' done
    return 0
  fi
  case "$receipt_event:$receipt_outcome" in
    settled:delivered) printf '%s\n' done ;;
    input:delivered) printf '%s\n' blocked ;;
    error:delivered|error:error) printf '%s\n' error ;;
    *) return 1 ;;
  esac
}

resolved_state() {
  local name="$1"
  local info="$2"
  local receipt_file="$3"
  local herdr_state receipt
  herdr_state=$(printf '%s\n' "$info" |
    jq -r '.result.agent.agent_status // empty')

  # A live Herdr turn is authoritative. A native completion can only refine
  # idle/done state, never interrupt work Herdr still observes as active.
  if [[ "$herdr_state" == "working" || "$herdr_state" == "blocked" ]]; then
    printf '%s\n' "$herdr_state"
    return 0
  fi
  receipt=$(receipt_state "$receipt_file" 2>/dev/null || true)
  if [[ -n "$receipt" ]]; then
    printf '%s\n' "$receipt"
  elif [[ "$herdr_state" == "done" ]]; then
    printf '%s\n' idle
  else
    printf '%s\n' "$herdr_state"
  fi
}

agent_state() {
  local name="$1"
  local info
  resolve_agent_paths "$name" || return 1
  info=$(agent_info "$name")
  resolved_state "$name" "$info" "$HERDR_RECEIPT_FILE"
}

deliver_prompt() {
  local name="$1"
  local task="$2"
  local generation="$3"
  herdr_deliver_prompt "$name" "$task" "$generation"
}

render_result() {
  local name="$1"
  local state event
  resolve_agent_paths "$name" || return 1
  state=$(agent_state "$name")
  case "$state" in
    done) event=settled ;;
    blocked) event=input ;;
    working)
      printf '%s\n' "herdr-orchestrator: $name is still working" >&2
      return 1
      ;;
    *)
      printf '%s\n' "herdr-orchestrator: $name has unsafe state ${state:-unknown}" >&2
      return 1
      ;;
  esac
  env \
    HERDR_MONITOR_ENABLED=1 \
    HERDR_MONITOR_RENDER_ONLY=1 \
    HERDR_MONITOR_AGENT="$name" \
    HERDR_MONITOR_LABEL="$name" \
    "$script_dir/herdr-hook-notify.sh" "$event" </dev/null
}

# A surviving pane is not evidence that its lifecycle process is still running.
require_live_monitor() {
  local name="$1" receipt_file="$2"
  local registry_file="$registry_dir/$name.json"
  local monitor_pane monitor_pid="" monitor_start="" pane_info generation notice reason=""
  if [[ ! -e "$registry_file" && "${HERDR_AXI_MANAGED_TASK:-}" != 1 ]]; then return 0; fi
  monitor_pane=$(jq -r '.monitor_pane // empty' "$registry_file" 2>/dev/null || true)
  pane_info=$(herdr pane get "$monitor_pane" 2>/dev/null || true)
  if [[ -z "$monitor_pane" ]] || ! jq -e --slurpfile registry "$registry_file" \
    '.result.pane | .pane_id == $registry[0].monitor_pane and .tab_id == $registry[0].tab_id and .workspace_id == $registry[0].workspace_id' \
    <<<"$pane_info" >/dev/null 2>&1; then
    reason="registered monitor pane unavailable or changed"
  elif [[ ! -f "${receipt_file}.monitor-owner" || ! -r "${receipt_file}.monitor-owner" ]] ||
    ! { IFS=$'\t' read -r monitor_pid monitor_start < "${receipt_file}.monitor-owner"; } 2>/dev/null; then
    reason="monitor process identity unavailable"
  elif [[ "$(herdr_lock_owner_state "$monitor_pid" "$monitor_start")" != live ]]; then
    reason="monitor process not affirmatively live"
  fi
  generation=$(jq -r '.generation // empty' "$registry_file" 2>/dev/null || true)
  if [[ -z "$reason" && -r "${receipt_file}.monitor-error" ]]; then
    notice=$(head -c 4096 "${receipt_file}.monitor-error" 2>/dev/null || true)
    if [[ "$notice" == "-"$'\t'* || ( -n "$generation" && "$notice" == "$generation"$'\t'* ) ]]; then
      reason="monitor reported ${notice#*$'\t'}"
    fi
  fi
  if [[ -n "$reason" ]]; then
    herdr_engine_error MONITOR_SUPERVISION_LOST "$name: $reason; no prompt sent. Inspect herdr-axi run inbox; cancel the task explicitly with herdr-axi run cancel before replacement. Do not retry input or restart an unverified monitor." false
    return 1
  fi
}

refresh_registry_generation() {
  local name="$1"
  local receipt_file="$2"
  local generation="$3"
  local registry_file="$registry_dir/$name.json"
  local registry_name registry_receipt temp_file
  [[ -e "$registry_file" ]] || return 0
  registry_name=$(jq -r '.name // empty' "$registry_file" 2>/dev/null || true)
  registry_receipt=$(jq -r '.receipt_file // empty' "$registry_file" 2>/dev/null || true)
  [[ "$registry_name" == "$name" && "$registry_receipt" == "$receipt_file" ]] ||
    return 1
  temp_file=$(mktemp "${registry_file}.tmp.XXXXXXXX") || return 1
  if ! jq --arg generation "$generation" \
    '.previous_generation = .generation | .generation = $generation' "$registry_file" > "$temp_file"; then
    rm -f "$temp_file"
    return 1
  fi
  if ! mv -f "$temp_file" "$registry_file"; then
    rm -f "$temp_file"
    return 1
  fi
}

command_name="${1:-}"
[[ -n "$command_name" ]] || usage
shift

case "$command_name" in
  start)
    (( $# > 0 )) || usage
    start_result=$("$script_dir/herdr-worker.sh" "$@")
    name=$(printf '%s\n' "$start_result" | jq -r '.name // empty')
    workspace_id=$(printf '%s\n' "$start_result" | jq -r '.workspace_id // empty')
    [[ -n "$name" && -n "$workspace_id" ]] || {
      printf '%s\n' "$start_result" >&2
      exit 1
    }
    resolve_agent_paths "$name" "$workspace_id"
    compact_result=$(printf '%s\n' "$start_result" | jq -c '.')
    registry_tmp=$(mktemp "$registry_dir/$name.json.tmp.XXXXXXXX")
    printf '%s\n' "$compact_result" > "$registry_tmp"
    mv -f "$registry_tmp" "$registry_dir/$name.json"
    printf '%s\n' "$compact_result"
    ;;
  inspect)
    (( $# > 0 )) || usage
    {
      for name in "$@"; do
        resolve_agent_paths "$name"
        info=$(agent_info "$name")
        herdr_state=$(printf '%s\n' "$info" |
          jq -r '.result.agent.agent_status // empty')
        effective_state=$(resolved_state "$name" "$info" "$HERDR_RECEIPT_FILE")
        receipt_status=$(receipt_state "$HERDR_RECEIPT_FILE" 2>/dev/null || true)
        if [[ "$herdr_state" == "working" ]]; then
          state_source=herdr
        elif [[ -n "$receipt_status" ]]; then
          state_source=monitor-receipt
        else
          state_source=herdr
        fi
        notification_delivery=""
        if herdr_receipt_read "$HERDR_RECEIPT_FILE" 2>/dev/null; then
          notification_delivery="$receipt_outcome"
        fi
        printf '%s\n' "$info" |
          jq -c --arg status "$effective_state" --arg herdr_status "$herdr_state" \
            --arg status_source "$state_source" --arg delivered "$notification_delivery" \
            '{name:.result.agent.name,kind:.result.agent.agent,status:$status,herdr_status:$herdr_status,status_source:$status_source,notification_delivery:($delivered | if . == "" then null else . end),cwd:.result.agent.cwd,session_id:.result.agent.agent_session.value,tab_id:.result.agent.tab_id,pane_id:.result.agent.pane_id}'
      done
    } | jq -sc '.'
    ;;
  result)
    (( $# == 1 )) || usage
    render_result "$1"
    ;;
  collect)
    (( $# == 1 )) || usage
    resolve_agent_paths "$1"
    env HERDR_MONITOR_ENABLED=1 HERDR_MONITOR_INBOX=1 \
      HERDR_MONITOR_ORCHESTRATOR="${HERDR_AXI_OWNER_PANE:-orchestrator}" \
      HERDR_MONITOR_AGENT="$1" HERDR_MONITOR_RECEIPT="$HERDR_RECEIPT_FILE" \
      "$script_dir/herdr-hook-notify.sh" settled </dev/null
    ;;
  followup)
    if (( $# != 3 )) || [[ "${2:-}" != "--prompt-file" || ! -r "${3:-}" ]]; then
      usage
    fi
    name="$1"
    resolve_agent_paths "$name"
    state=$(agent_state "$name")
    [[ "$state" == "done" || "$state" == "error" ]] || {
      printf '%s\n' "herdr-orchestrator: followup refused: $name state=${state:-unknown}" >&2
      exit 1
    }
    receipt_file="$HERDR_RECEIPT_FILE"
    require_live_monitor "$name" "$receipt_file" || exit 1
    if [[ -e "$registry_dir/$name.json" ]]; then
      herdr_registry_capture_identity "$registry_dir/$name.json" || exit 1
    fi
    herdr_receipt_lock_acquire "$receipt_file" || {
      printf '%s\n' "herdr-orchestrator: followup could not lock receipt: $name" >&2
      exit 1
    }
    info=$(agent_info "$name")
    state=$(resolved_state "$name" "$info" "$receipt_file")
    if [[ "$state" != "done" && "$state" != "error" ]]; then
      herdr_receipt_lock_release
      printf '%s\n' "herdr-orchestrator: followup state changed: $name state=${state:-unknown}" >&2
      exit 1
    fi
    completion_generation=$(herdr_new_generation)
    if ! herdr_receipt_rearm_locked \
      "$receipt_file" followup "$completion_generation"; then
      herdr_receipt_lock_release
      exit 1
    fi
    if ! refresh_registry_generation \
      "$name" "$receipt_file" "$completion_generation"; then
      herdr_receipt_lock_release
      printf '%s\n' \
        "herdr-orchestrator: followup registry generation could not be updated: $name" >&2
      exit 1
    fi
    herdr_receipt_lock_release
    followup_task=$(herdr_append_completion_instruction \
      "$(< "$3")" "$receipt_file" "$completion_generation")
    if ! deliver_prompt "$name" "$followup_task" "$completion_generation"; then
      if [[ -e "$registry_dir/$name.json" ]]; then
        herdr_registry_capture_identity "$registry_dir/$name.json" true || true
      fi
      exit 1
    fi
    if [[ -e "$registry_dir/$name.json" ]]; then
      herdr_registry_capture_identity "$registry_dir/$name.json" true || exit 1
    fi
    herdr_registry_delivery_stage "$name" "$completion_generation" submitted || exit 1
    jq -nc --arg name "$name" '{name:$name,prompt_delivered:true}'
    ;;
  retry)
    [[ "${HERDR_AXI_MANAGED_TASK:-}" == 1 && $# == 3 && "$2" == --prompt-file && -r "$3" ]] || usage
    name="$1"
    resolve_agent_paths "$name"
    registry_file="$registry_dir/$name.json"
    herdr_registry_capture_identity "$registry_file" || exit 1
    info=$(agent_info "$name")
    jq -e '.result.agent.agent_status == "idle" or .result.agent.agent_status == "done"' <<<"$info" >/dev/null || {
      printf '%s\n' "herdr-orchestrator: rejected prompt is not ready; inspect its dialog" >&2; exit 1;
    }
    receipt_file="$HERDR_RECEIPT_FILE"
    require_live_monitor "$name" "$receipt_file" || exit 1
    herdr_receipt_lock_acquire "$receipt_file" || exit 1
    completion_generation=$(jq -er 'select(.stage == "rejected" and .delivery_error == "agent_blocked") | .generation' "$registry_file") ||
      close_locked_error "retry requires durable pre-submit rejection: $name"
    herdr_receipt_read "$receipt_file" || close_locked_error "retry receipt unavailable: $name"
    [[ "$receipt_generation" == "$completion_generation" && "$receipt_terminal" != closed &&
      "$receipt_settled_fingerprint" != "generation:$completion_generation" ]] || close_locked_error "retry generation already settled or changed: $name"
    # Rejection sent no work. Rearm with a linked generation so the first real
    # submission may establish its native session without weakening identity.
    completion_generation=$(herdr_new_generation) || close_locked_error "retry generation unavailable: $name"
    herdr_receipt_rearm_locked "$receipt_file" rejected-retry "$completion_generation" || close_locked_error "retry rearm failed: $name"
    refresh_registry_generation "$name" "$receipt_file" "$completion_generation" || close_locked_error "retry registry rearm failed: $name"
    # Consume retry authority before releasing the lock or sending input.
    herdr_registry_delivery_stage "$name" "$completion_generation" submitting || close_locked_error "retry reservation failed: $name"
    herdr_receipt_lock_release
    retry_task=$(herdr_append_completion_instruction "$(< "$3")" "$receipt_file" "$completion_generation")
    if ! deliver_prompt "$name" "$retry_task" "$completion_generation"; then
      herdr_registry_capture_identity "$registry_file" true || true
      exit 1
    fi
    herdr_registry_capture_identity "$registry_file" true || exit 1
    herdr_registry_delivery_stage "$name" "$completion_generation" submitted || exit 1
    jq -nc --arg name "$name" '{name:$name,prompt_delivered:true}'
    ;;
  close)
    herdr_close "$@"
    ;;
  *) usage ;;
esac
