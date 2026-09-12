#!/bin/bash

[[ -z "${HERDR_CLOSE_LOADED:-}" ]] || return 0
HERDR_CLOSE_LOADED=1

# Requires the receipt composition and orchestrator usage/agent_info/render_result.
# A subshell owns all close/resource scratch globals and preserves exit semantics.
herdr_close() (
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
  local message="$1" code="${2:-ENGINE_ERROR}"
  herdr_receipt_lock_release
  herdr_engine_error "$code" "$message"
  exit 1
}

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
        close_locked_error "cancellation requires the current registered generation: $name" GENERATION_DRIFT
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
        close_locked_error "handoff requires the current registered generation: $name" GENERATION_DRIFT
    elif [[ -z "$receipt_settled_fingerprint" ||
      -z "$receipt_generation" ]]; then
      close_locked_error "close refused without completion proof: $name"
    fi
    if [[ -n "$close_generation" &&
      "$close_generation" != "$receipt_generation" ]]; then
      close_locked_error "registered lifecycle generation changed: $name" GENERATION_DRIFT
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
      else
        if [[ "$live_state" == idle || "$live_state" == done ]]; then
          herdr_registry_identity_matches "$close_registry_file" "$info" ||
            close_locked_error "worker identity changed or unavailable: $name"
        else
          # A monitor-only orphan is recoverable only after proving the worker
          # pane absent. Unknown/read failures are never occupant identity.
          probe_resource pane "$close_agent_pane"
          [[ "$resource_state" == absent ]] ||
            close_locked_error "close refused: $name state=$live_state"
        fi
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
    else
      probe_resource pane "$close_agent_pane"
      [[ "$resource_state" == absent ]] || close_locked_error "worker cannot be verified: $name"
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
        if [[ -z "$handoff_file" && -z "$cancel_file" ]]; then
          # Rendering and topology inspection may take time. Recheck the native
          # occupant immediately before retirement, including resumed work.
          probe_resource pane "$close_agent_pane"
          if [[ "$resource_state" != absent ]]; then
            info=$(agent_info "$close_agent_pane") || close_locked_error "worker no longer readable: $name"
            herdr_registry_identity_matches "$close_registry_file" "$info" ||
              close_locked_error "worker identity changed before close: $name"
            jq -e '.result.agent.agent_status | . == "idle" or . == "done"' <<<"$info" >/dev/null ||
              close_locked_error "worker resumed before close: $name"
          fi
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
)
