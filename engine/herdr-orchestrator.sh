#!/bin/bash
set -euo pipefail

if [[ "${HERDR_ENV:-}" != "1" ]]; then
  printf '%s\n' "herdr-orchestrator: not running inside Herdr" >&2
  exit 2
fi

for dependency in herdr jq rg cut awk find mktemp stat ps "${HERDR_AXI_NODE:-node}"; do
  command -v "$dependency" >/dev/null || {
    printf '%s\n' "herdr-orchestrator: missing dependency: $dependency" >&2
    exit 2
  }
done

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=herdr-receipt.sh
source "$script_dir/herdr-receipt.sh"
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
    printf '%s\n' "MONITOR_SUPERVISION_LOST: $name: $reason; no prompt sent. Inspect herdr-axi run inbox; cancel the task explicitly with herdr-axi run cancel before replacement. Do not retry input or restart an unverified monitor." >&2
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

close_registry_file=""
close_registry_dir=""
close_receipt_file=""
close_workspace_id=""
close_tab_id=""
close_agent_pane=""
close_monitor_pane=""
close_generation=""
close_already_closed=false
resource_state=""
resource_json=""

resolve_close_lifecycle() {
  local name="$1"
  local root candidate candidate_count=0 valid_event_count=0
  local registry_name registry_workspace registry_receipt

  root="${HERDR_RECEIPT_ROOT:-${HOME}/.herdr-orchestrator}"
  root="${root%/}"
  [[ -n "$root" && -d "$root" ]] || {
    printf '%s\n' "herdr-orchestrator: no registered lifecycle for $name" >&2
    return 1
  }

  while IFS= read -r candidate; do
    [[ "${candidate##*/}" == "$name.json" ]] || continue
    close_registry_file="$candidate"
    candidate_count=$((candidate_count + 1))
  done < <(find "$root" -mindepth 2 -maxdepth 2 -type f -name '*.json' -print)

  if (( candidate_count == 0 )); then
    while IFS= read -r candidate; do
      [[ "${candidate##*/}" == "$name.event" ]] || continue
      if herdr_receipt_read "$candidate" 2>/dev/null; then
        close_receipt_file="$candidate"
        valid_event_count=$((valid_event_count + 1))
      fi
    done < <(find "$root" -mindepth 2 -maxdepth 2 -type f -name '*.event' -print)
    if (( valid_event_count == 1 )) &&
      herdr_receipt_read "$close_receipt_file" &&
      [[ "$receipt_terminal" == "closed" ]]; then
      close_already_closed=true
      return 0
    fi
    printf '%s\n' \
      "herdr-orchestrator: registered lifecycle is missing or ambiguous: $name" >&2
    return 1
  fi
  if (( candidate_count != 1 )); then
    printf '%s\n' \
      "herdr-orchestrator: multiple registered lifecycles found: $name" >&2
    return 1
  fi

  close_registry_dir=$(dirname -- "$close_registry_file")
  close_workspace_id="${close_registry_dir##*/}"
  close_receipt_file="$close_registry_dir/$name.event"
  registry_name=$(jq -r '.name // empty' "$close_registry_file" 2>/dev/null || true)
  registry_workspace=$(jq -r '.workspace_id // empty' "$close_registry_file" 2>/dev/null || true)
  registry_receipt=$(jq -r '.receipt_file // empty' "$close_registry_file" 2>/dev/null || true)
  close_tab_id=$(jq -r '.tab_id // empty' "$close_registry_file" 2>/dev/null || true)
  close_agent_pane=$(jq -r '.agent_pane // empty' "$close_registry_file" 2>/dev/null || true)
  close_monitor_pane=$(jq -r '.monitor_pane // empty' "$close_registry_file" 2>/dev/null || true)
  close_generation=$(jq -r '.generation // empty' "$close_registry_file" 2>/dev/null || true)
  close_stage=$(jq -r '.stage // empty' "$close_registry_file" 2>/dev/null || true)
  if [[ "$close_agent_pane" == "${HERDR_PANE_ID:-}" ||
    "$close_agent_pane" == "${HERDR_AXI_OWNER_PANE:-}" ||
    "$close_tab_id" == "${HERDR_TAB_ID:-}" ||
    "$close_tab_id" == "${HERDR_AXI_OWNER_TAB:-}" ]]; then
    printf '%s\n' "herdr-orchestrator: refusing to close the owner pane or tab" >&2
    return 1
  fi
  if [[ "$registry_name" != "$name" ||
    "$registry_workspace" != "$close_workspace_id" ||
    "$registry_receipt" != "$close_receipt_file" ||
    -z "$close_tab_id" ||
    -z "$close_agent_pane" ||
    ( -z "$close_monitor_pane" && "$close_stage" != "created" ) ]]; then
    printf '%s\n' \
      "herdr-orchestrator: registered lifecycle is malformed: $name" >&2
    return 1
  fi
}

probe_resource() {
  local kind="$1"
  local identifier="$2"
  local output actual error_code
  resource_state=unknown
  resource_json=""
  if output=$(herdr "$kind" get "$identifier" 2>&1); then
    if [[ "$kind" == "tab" ]]; then
      actual=$(printf '%s\n' "$output" |
        jq -r '.result.tab.tab_id // empty' 2>/dev/null || true)
    else
      actual=$(printf '%s\n' "$output" |
        jq -r '.result.pane.pane_id // empty' 2>/dev/null || true)
    fi
    if [[ "$actual" == "$identifier" ]]; then
      resource_state=present
      resource_json="$output"
    fi
    return 0
  fi
  error_code=$(printf '%s\n' "$output" |
    jq -Rr 'fromjson? | .error.code? // empty' 2>/dev/null |
    awk 'NF { value=$0 } END { print value }')
  if [[ "$error_code" == "${kind}_not_found" ]]; then
    resource_state=absent
  fi
}

validate_registered_resources() {
  local tab_workspace pane_tab tab_pane_count="" known_panes=0
  local tab_state agent_pane_state monitor_pane_state

  probe_resource tab "$close_tab_id"
  tab_state="$resource_state"
  if [[ "$tab_state" == "present" ]]; then
    tab_workspace=$(printf '%s\n' "$resource_json" |
      jq -r '.result.tab.workspace_id // empty')
    tab_pane_count=$(printf '%s\n' "$resource_json" |
      jq -r '.result.tab.pane_count // empty')
    [[ "$tab_workspace" == "$close_workspace_id" ]] ||
      return 1
  fi

  probe_resource pane "$close_agent_pane"
  agent_pane_state="$resource_state"
  if [[ "$agent_pane_state" == "present" ]]; then
    known_panes=$((known_panes + 1))
    pane_tab=$(printf '%s\n' "$resource_json" |
      jq -r '.result.pane.tab_id // empty')
    [[ "$pane_tab" == "$close_tab_id" ]] || return 1
  fi

  resource_state=absent
  [[ -z "$close_monitor_pane" ]] || probe_resource pane "$close_monitor_pane"
  monitor_pane_state="$resource_state"
  if [[ "$monitor_pane_state" == "present" ]]; then
    known_panes=$((known_panes + 1))
    pane_tab=$(printf '%s\n' "$resource_json" |
      jq -r '.result.pane.tab_id // empty')
    [[ "$pane_tab" == "$close_tab_id" ]] || return 1
  fi

  [[ "$tab_state" != "unknown" &&
    "$agent_pane_state" != "unknown" &&
    "$monitor_pane_state" != "unknown" ]] || return 1

  if [[ "$tab_state" == "absent" ]]; then
    [[ "$agent_pane_state" == "absent" &&
      "$monitor_pane_state" == "absent" ]]
    return
  fi
  # A user may have added/moved another pane into our tab after startup.
  [[ "$tab_pane_count" == "$known_panes" ]] || return 1
  [[ "$agent_pane_state" == "present" ||
    "$monitor_pane_state" == "present" ]]
}

registered_resources_absent() {
  probe_resource tab "$close_tab_id"
  [[ "$resource_state" == "absent" ]] || return 1
  probe_resource pane "$close_agent_pane"
  [[ "$resource_state" == "absent" ]] || return 1
  resource_state=absent
  [[ -z "$close_monitor_pane" ]] || probe_resource pane "$close_monitor_pane"
  [[ "$resource_state" == "absent" ]]
}

close_locked_error() {
  local message="$1"
  herdr_receipt_lock_release
  printf '%s\n' "herdr-orchestrator: $message" >&2
  exit 1
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
    (( $# == 1 || $# == 3 )) || usage
    name="$1"
    handoff_file=""
    handoff_json=""
    cancel_file=""
    cancel_json=""
    close_event=settled
    close_reason=close
    if (( $# == 3 )); then
      [[ ( "$2" == "--handoff" || "$2" == "--cancel" ) && "${HERDR_AXI_MANAGED_TASK:-}" == "1" ]] || usage
      [[ "$3" == "${HERDR_RECEIPT_ROOT%/receipts}/run.json" ]] || usage
      close_event=lost
      if [[ "$2" == "--handoff" ]]; then
        handoff_file="$3"; close_reason=handoff
      else
        cancel_file="$3"; close_reason=cancelled
      fi
    fi
    resolve_close_lifecycle "$name"
    if [[ "$close_already_closed" == "true" ]]; then
      jq -nc --arg name "$name" \
        '{name:$name,closed:true,already_closed:true}'
      exit 0
    fi
    receipt_file="$close_receipt_file"
    herdr_receipt_lock_acquire "$receipt_file" || {
      printf '%s\n' "herdr-orchestrator: close could not lock receipt: $name" >&2
      exit 1
    }

    if ! herdr_receipt_read "$receipt_file"; then
      # A blocked startup has a registry but no submitted task/receipt yet.
      [[ ( -n "$cancel_file" || -n "$handoff_file" ) && "$close_stage" == "created" && ! -e "$receipt_file" ]] ||
        close_locked_error "close receipt is unreadable: $name"
      receipt_generation="$close_generation"
    fi
    if [[ -n "$cancel_file" ]]; then
      # Older workers armed receipts after native startup. An input hook could
      # therefore leave a blank generation at a dialog, before any task existed.
      # Only that unsubmitted shape may bind to the checkpoint; real drift fails.
      if [[ -z "$receipt_generation" && "$close_stage" == "created" &&
        -z "$close_monitor_pane" && -z "$receipt_settled_fingerprint" &&
        "$receipt_terminal" == "open" && "$receipt_event" != "settled" &&
        ! -e "${receipt_file}.proof.${close_generation}" && ! -e "${receipt_file}.proof." ]]; then
        receipt_generation="$close_generation"
      fi
      cancel_json=$(jq -ce --arg name "$name" --arg pane "$close_agent_pane" \
        --arg tab "$close_tab_id" --arg generation "$close_generation" \
        --arg workspace "$close_workspace_id" --arg receipt "$close_receipt_file" '
        select(.schema == 1 and .workspace == $workspace and .owner.pane != $pane and .owner.tab != $tab) |
        [.tasks[] | select(.state == "cancelling" and .pane == $pane and .name == $name) |
          .cancellation | select(.from.pane == $pane and .from.tab == $tab and .from.name == $name and
            .from.generation == $generation and .from.receipt == $receipt and
            (.evidence | type) == "string" and (.evidence | length) > 0 and (.output | type) == "string")] |
        if length == 1 then {from: (.[0].from | {terminal,session})} else error("missing checkpoint") end' "$cancel_file") ||
        close_locked_error "cancellation checkpoint missing or mismatched: $name"
      [[ -n "$close_generation" && "$close_generation" == "$receipt_generation" ]] ||
        close_locked_error "cancellation requires the current registered generation: $name"
    elif [[ -n "$handoff_file" ]]; then
      [[ "$receipt_settled_fingerprint" != "generation:$receipt_generation" ]] ||
        close_locked_error "worker completed; cancel switch and review before normal close: $name"
      handoff_json=$(jq -ce --arg name "$name" --arg pane "$close_agent_pane" \
        --arg tab "$close_tab_id" --arg generation "$close_generation" \
        --arg workspace "$close_workspace_id" --arg receipt "$close_receipt_file" '
        select(.schema == 1 and .workspace == $workspace and .owner.pane != $pane and .owner.tab != $tab) |
        [.tasks[] | select(.state == "switching" and .pane == $pane and .name == $name) |
          .handoffs[-1] | select(.from.pane == $pane and .from.tab == $tab and .from.name == $name and
            .from.generation == $generation and .from.receipt == $receipt and .quota.code == "QUOTA_EXHAUSTED" and
            (.output | type) == "string" and .to.kind != .from.kind)] |
        if length == 1 then {from: (.[0].from | {terminal,session})} else error("missing checkpoint") end' "$handoff_file") ||
        close_locked_error "handoff checkpoint missing or mismatched: $name"
      [[ -n "$close_generation" && "$close_generation" == "$receipt_generation" ]] ||
        close_locked_error "handoff requires the current registered generation: $name"
    elif [[ -z "$receipt_settled_fingerprint" ||
      -z "$receipt_generation" ]]; then
      close_locked_error "close refused without completion proof: $name"
    fi
    if [[ -n "$close_generation" &&
      "$close_generation" != "$receipt_generation" ]]; then
      close_locked_error "registered lifecycle generation changed: $name"
    fi
    if [[ -z "$close_generation" ]]; then
      printf '%s\n' \
        "herdr-orchestrator: closing legacy registry without generation: $name" >&2
    fi

    info=$(agent_info "$name" 2>/dev/null || true)
    if [[ -n "$info" ]]; then
      live_name=$(printf '%s\n' "$info" |
        jq -r '.result.agent.name // empty')
      live_state=$(printf '%s\n' "$info" |
        jq -r '.result.agent.agent_status // empty')
      live_workspace=$(printf '%s\n' "$info" |
        jq -r '.result.agent.workspace_id // empty')
      live_tab=$(printf '%s\n' "$info" |
        jq -r '.result.agent.tab_id // empty')
      live_pane=$(printf '%s\n' "$info" |
        jq -r '.result.agent.pane_id // empty')
      if [[ -n "$live_name" && "$live_name" != "$name" ]]; then
        close_locked_error "live agent does not match registry: $name"
      fi
      if [[ -n "$cancel_file" ]]; then
        [[ "$live_name" == "$name" && "$live_workspace" == "$close_workspace_id" &&
          "$live_tab" == "$close_tab_id" && "$live_pane" == "$close_agent_pane" ]] ||
          close_locked_error "cancellation live topology changed: $name"
        printf '%s\n' "$info" | jq -e --argjson checkpoint "$cancel_json" '
          .result.agent | (.terminal_id == $checkpoint.from.terminal or $checkpoint.from.terminal == null) and
          (.agent_session.value == $checkpoint.from.session or $checkpoint.from.session == null)' >/dev/null ||
          close_locked_error "cancellation worker identity changed: $name"
      elif [[ -n "$handoff_file" ]]; then
        [[ "$live_name" == "$name" && "$live_workspace" == "$close_workspace_id" &&
          "$live_tab" == "$close_tab_id" && "$live_pane" == "$close_agent_pane" ]] ||
          close_locked_error "handoff live topology changed: $name"
        [[ "$live_state" == "idle" || "$live_state" == "done" || "$live_state" == "blocked" || "$live_state" == "unknown" ]] ||
          close_locked_error "handoff refuses active worker: $name"
        printf '%s\n' "$info" | jq -e --argjson checkpoint "$handoff_json" '
          .result.agent | (.terminal_id == $checkpoint.from.terminal or $checkpoint.from.terminal == null) and
          (.agent_session.value == $checkpoint.from.session or $checkpoint.from.session == null)' >/dev/null ||
          close_locked_error "handoff worker identity changed: $name"
        herdr agent read "$close_agent_pane" --source visible --lines 40 |
          "${HERDR_AXI_NODE:-node}" "$script_dir/../src/quota.mjs" |
          jq -se 'length == 1 and (.[0] | type == "object" and .code == "QUOTA_EXHAUSTED" and (.message | type) == "string")' >/dev/null ||
          close_locked_error "handoff quota no longer confirmed: $name"
        # Proof may arrive after JS checkpointing but before retirement. Do not
        # close a completed generation merely because its hook has not settled.
        if herdr_completion_proof_valid "$receipt_file" "$receipt_generation"; then
          close_locked_error "completion proof pending; cancel switch and collect inbox before review: $name"
        fi
        handoff_identity_filter='.result.agent | {name,pane_id,tab_id,workspace_id,terminal_id,agent_session,agent_status}'
        handoff_identity=$(printf '%s\n' "$info" | jq -c "$handoff_identity_filter")
        refreshed_identity=$(agent_info "$close_agent_pane" | jq -c "$handoff_identity_filter") ||
          close_locked_error "handoff worker no longer readable: $name"
        [[ "$handoff_identity" == "$refreshed_identity" ]] ||
          close_locked_error "handoff worker changed or resumed during quota check: $name"
      elif [[ "$live_state" == "working" || "$live_state" == "blocked" ]]; then
        close_locked_error "close refused: $name state=$live_state"
      fi
      if [[ -n "$live_workspace" &&
        "$live_workspace" != "$close_workspace_id" ]]; then
        close_locked_error "live workspace does not match registry: $name"
      fi
      if [[ -n "$live_tab" && "$live_tab" != "$close_tab_id" ]]; then
        close_locked_error "live tab does not match registry: $name"
      fi
      if [[ -n "$live_pane" && "$live_pane" != "$close_agent_pane" ]]; then
        close_locked_error "live agent pane does not match registry: $name"
      fi
    elif [[ -n "$cancel_file" ]]; then
      # Monitor-only orphan: do not mistake a new occupant or an unreadable
      # worker pane for absence. Full tab topology is checked below as usual.
      probe_resource pane "$close_agent_pane"
      [[ "$resource_state" == "absent" ]] || close_locked_error "cancellation worker cannot be verified: $name"
    elif [[ -n "$handoff_file" ]]; then
      registered_resources_absent || close_locked_error "handoff worker cannot be verified: $name"
    fi

    rendered_result=""
    if [[ -z "$handoff_file" && -z "$cancel_file" ]]; then
      rendered_result=$(env \
      HERDR_MONITOR_ENABLED=1 \
      HERDR_MONITOR_RENDER_ONLY=1 \
      HERDR_MONITOR_AGENT="$name" \
      HERDR_MONITOR_LABEL="$name" \
      HERDR_MONITOR_RECEIPT="$receipt_file" \
      "$script_dir/herdr-hook-notify.sh" settled </dev/null) ||
      close_locked_error "completed result could not be rendered: $name"
    fi

    validate_registered_resources ||
      close_locked_error "registered tab or panes could not be validated: $name"
    probe_resource tab "$close_tab_id"
    case "$resource_state" in
      present)
        if [[ "$receipt_terminal" == "closed" ]]; then
          close_locked_error "closed receipt still has a live tab: $name"
        fi
        herdr tab close "$close_tab_id" >/dev/null ||
          close_locked_error "registered tab close failed: $name"
        herdr agent wait "$name" --until unknown \
          --timeout "${HERDR_CLOSE_WAIT_TIMEOUT_MS:-5000}" >/dev/null 2>&1 || true
        registered_resources_absent ||
          close_locked_error "registered tab or panes remained after close: $name"
        ;;
      absent)
        registered_resources_absent ||
          close_locked_error "registered panes remained without their tab: $name"
        ;;
      *)
        close_locked_error "registered tab state became unreadable: $name"
        ;;
    esac

    if ! herdr_receipt_write \
      "$receipt_file" "$receipt_cycle" "$close_event" closed closed \
      "$receipt_delivered_event" "$receipt_delivered_fingerprint" \
      "$receipt_settled_fingerprint" closed "$receipt_generation" "$close_reason"; then
      close_locked_error "closed tombstone could not be written: $name"
    fi
    if ! rm -f "$close_registry_file"; then
      close_locked_error "verified registry could not be removed: $name"
    fi
    herdr_receipt_lock_release
    printf '%s\n' "$rendered_result"
    jq -nc --arg name "$name" '{name:$name,closed:true}'
    ;;
  *) usage ;;
esac
