#!/bin/bash
set -euo pipefail

if [[ "${HERDR_ENV:-}" != "1" ]]; then
  printf '%s\n' "herdr-worker: not running inside Herdr" >&2
  exit 2
fi

for dependency in "${HERDR_BIN:-herdr}" jq uuidgen rg awk find mktemp stat ps date "${HERDR_AXI_NODE:-node}"; do
  command -v "$dependency" >/dev/null || {
    printf '%s\n' "herdr-worker: missing dependency: $dependency" >&2
    exit 2
  }
done

export HERDR_AXI_NODE="$(command -v "${HERDR_AXI_NODE:-node}")"
herdr_bin=$(type -P "${HERDR_BIN:-herdr}")
export HERDR_BIN="$(cd -- "$(dirname -- "$herdr_bin")" && pwd)/${herdr_bin##*/}"

usage() {
  printf '%s\n' "usage: $0 --name NAME --kind copilot|claude|codex|cursor --cwd PATH --prompt-file PATH [--label LABEL] [--model MODEL] [--effort LEVEL] [--max-autopilot-continues N] [--workspace ID] [--orchestrator-agent NAME]" >&2
  exit 2
}

name=""
label=""
kind=""
worker_cwd=""
prompt_file=""
model=""
effort=""
max_autopilot_continues="3"
workspace_id=""
orchestrator_agent="orchestrator"
resume=false
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=herdr-receipt.sh
source "$script_dir/herdr-receipt.sh"

while (( $# > 0 )); do
  case "$1" in
    --resume) resume=true; shift ;;
    --name) name="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --kind) kind="${2:-}"; shift 2 ;;
    --cwd) worker_cwd="${2:-}"; shift 2 ;;
    --prompt-file) prompt_file="${2:-}"; shift 2 ;;
    --model) model="${2:-}"; shift 2 ;;
    --effort) effort="${2:-}"; shift 2 ;;
    --max-autopilot-continues) max_autopilot_continues="${2:-}"; shift 2 ;;
    --workspace) workspace_id="${2:-}"; shift 2 ;;
    --orchestrator-agent) orchestrator_agent="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$name" && -n "$kind" && -n "$worker_cwd" && -n "$prompt_file" ]] || usage
[[ -n "$orchestrator_agent" ]] || usage
[[ -d "$worker_cwd" && -r "$prompt_file" ]] || usage
[[ "$kind" == "copilot" || "$kind" == "claude" || "$kind" == "codex" || "$kind" == "cursor" ]] || usage
if [[ -z "$effort" ]]; then
  if [[ "$kind" == "cursor" ]]; then effort=model; else effort=high; fi
fi
[[ "$max_autopilot_continues" =~ ^[0-9]+$ && "$max_autopilot_continues" -gt 0 ]] || usage
[[ -n "$label" ]] || label="$name"

if ! herdr_receipt_resolve "$name" "$workspace_id" "$orchestrator_agent"; then
  printf '%s\n' "herdr-worker: workspace could not be resolved: $name" >&2
  exit 1
fi
workspace_id="$HERDR_RECEIPT_WORKSPACE_ID"

if [[ -z "$model" ]]; then
  case "$kind" in
    copilot|codex) model="gpt-5.6-sol" ;;
    claude) model="opus" ;;
  esac
fi

"$HERDR_AXI_NODE" "$script_dir/../src/launch-policy.mjs" \
  --kind "$kind" --model "$model" --effort "$effort" >/dev/null

receipt_dir="$HERDR_RECEIPT_REGISTRY_DIR"
receipt_file="$HERDR_RECEIPT_FILE"

if [[ "$resume" == "true" ]]; then
  registered="$receipt_dir/$name.json"
  [[ -r "$registered" ]] || exit 1
  agent_pane=$(jq -r '.agent_pane' "$registered")
  tab_id=$(jq -r '.tab_id' "$registered")
  [[ "$(jq -r '.stage' "$registered")" == "created" ]] || exit 1
  if [[ "$(jq -r '.monitor_pane // empty' "$registered")" != "" ]]; then
    printf '%s\n' 'MONITOR_START_UNVERIFIED: existing monitor startup requires explicit cancellation; refusing a duplicate monitor' >&2
    exit 1
  fi
  info=$(herdr agent get "$agent_pane")
  jq -e --arg pane "$agent_pane" --arg tab "$tab_id" --arg ws "$workspace_id" \
    --arg name "$name" --arg kind "$kind" \
    '.result.agent | .pane_id == $pane and .tab_id == $tab and .workspace_id == $ws and .name == $name and .agent == $kind and (.agent_status == "idle" or .agent_status == "done")' <<<"$info" >/dev/null || exit 1
  herdr_registry_capture_identity "$registered" || exit 1
  native_identity=$(jq -c '.native_identity' "$registered")
  previous_generation=$(jq -r '.generation' "$registered")
  cleanup_created_tab=false
else
  tab_json=$(herdr tab create \
  --workspace "$workspace_id" \
  --cwd "$worker_cwd" \
  --label "$label" \
  --env HERDR_MONITOR_ENABLED=1 \
  --env "HERDR_WORKSPACE_ID=$workspace_id" \
  --env "HERDR_RECEIPT_ROOT=$HERDR_RECEIPT_ROOT_DIR" \
  --env "HERDR_MONITOR_ORCHESTRATOR=$orchestrator_agent" \
  --env "HERDR_MONITOR_AGENT=$name" \
  --env "HERDR_MONITOR_LABEL=$name" \
  --env "HERDR_MONITOR_HOOK_SCRIPT=$script_dir/herdr-hook-notify.sh" \
  --env "HERDR_MONITOR_INBOX=${HERDR_MONITOR_INBOX:-0}" \
  --env "HERDR_AXI_RUN=" \
  --env "HERDR_AXI_WORKER=1" \
  --env DISABLE_AUTO_UPDATE=true \
  --env "HERDR_AXI_BIN=$script_dir/../bin/herdr-axi.mjs" \
  --env "HERDR_AXI_NODE=$HERDR_AXI_NODE" \
  --env "HERDR_BIN=$HERDR_BIN" \
  --env "PATH=$script_dir/../bin:$PATH" \
  --no-focus)
agent_pane=$(printf '%s\n' "$tab_json" | jq -r '.result.root_pane.pane_id')
tab_id=$(printf '%s\n' "$tab_json" | jq -r '.result.tab.tab_id')
  native_identity=$(jq -c '{terminal:(.result.root_pane.terminal_id // null),session:null}' <<<"$tab_json")
  previous_generation=""
  cleanup_created_tab=true
fi
cleanup_on_exit() {
  if [[ "$cleanup_created_tab" == "true" ]]; then
    herdr tab close "$tab_id" >/dev/null || true
  fi
}
trap cleanup_on_exit EXIT

monitor_pane=""
monitoring_mode="native-hooks+event-wait"
completion_generation=$(herdr_new_generation)
completion_task=""

# Record returned topology immediately, even when agent startup later fails.
registry_tmp=$(mktemp "$receipt_dir/$name.json.tmp.XXXXXXXX")
jq -nc --arg name "$name" --arg workspace_id "$workspace_id" \
  --arg tab_id "$tab_id" --arg agent_pane "$agent_pane" \
  --arg receipt_file "$receipt_file" --arg generation "$completion_generation" \
  --arg previous_generation "$previous_generation" --argjson native_identity "$native_identity" \
  '{name:$name,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:null,receipt_file:$receipt_file,generation:$generation,previous_generation:$previous_generation,native_identity:$native_identity,stage:"created"}' > "$registry_tmp"
mv -f "$registry_tmp" "$receipt_dir/$name.json"

# Native startup can emit an input hook before agent start returns (trust or
# permission dialog). Arm its generation first so cancellation stays bound.
herdr_receipt_rearm "$receipt_file" worker-start "$completion_generation" || {
  printf '%s\n' "herdr-worker: could not rearm lifecycle receipt: $name" >&2
  exit 1
}

case "$kind" in
  cursor)
    monitoring_mode="event-wait+proof"
    native_args=(--model "$model" --auto-review --workspace "$worker_cwd" --add-dir "$receipt_dir")
    ;;
  copilot)
    session_id=$(uuidgen)
    native_args=(
      --autopilot
      --allow-all
      --model "$model"
      --effort "$effort"
      --name "$name"
      --session-id "$session_id"
      --max-autopilot-continues "$max_autopilot_continues"
      --plugin-dir "$script_dir/herdr-monitor-plugins/copilot"
      --deny-tool 'shell(git commit)'
      --deny-tool 'shell(git push)'
      --deny-tool 'shell(git reset)'
    )
    ;;
  claude)
    native_args=(
      --model "$model"
      --effort "$effort"
      --permission-mode auto
      --name "$name"
      --plugin-dir "$script_dir/herdr-monitor-plugins/claude"
    )
    ;;
  codex)
    monitoring_mode="native-notify"
    native_args=(
      --model "$model"
      --approve-for-me
      --add-dir "$receipt_dir"
      --cd "$worker_cwd"
      --config "model_reasoning_effort=$effort"
      --config "notify=['bash','$script_dir/herdr-hook-notify.sh','settled']"
    )
    ;;
esac

start_json=""
pane_ready_deadline=$(($(date +%s) + ${HERDR_START_READY_TIMEOUT_SECONDS:-12}))
while [[ "$resume" != "true" ]]; do
  if start_json=$(herdr agent start "$name" \
    --kind "$kind" \
    --pane "$agent_pane" \
    --timeout 120000 \
    -- "${native_args[@]}" 2>&1); then
    break
  fi
  if (( $(date +%s) >= pane_ready_deadline )) || ! jq -e '.error.code == "agent_pane_busy"' <<<"$start_json" >/dev/null; then
    # Keep startup dialogs inspectable; a human/owner must decide the response.
    if jq -e '.error.code == "agent_not_ready"' <<<"$start_json" >/dev/null; then
      cleanup_created_tab=false
      herdr_registry_capture_identity "$receipt_dir/$name.json" true || true
    fi
    printf '%s\n' "$start_json" >&2
    exit 1
  fi
  # Native startup validates the foreground shell. Prompt glyphs vary by
  # shell/theme and cannot establish readiness (Powerlevel10k, Starship, etc.).
  sleep 0.25
done

# Preserve a started agent if identity capture fails; never destroy a possible
# replacement based only on an old pane ID. Recovery stays fail-closed.
if ! herdr_registry_capture_identity "$receipt_dir/$name.json" true; then
  cleanup_created_tab=false
  exit 1
fi

if [[ "$kind" == "cursor" ]]; then
  cursor_session=$(jq -r '.native_identity.session // empty' "$receipt_dir/$name.json")
  if ! mode_screen=$(herdr agent read "$agent_pane" --source visible --lines 40) ||
    ! printf '%s\n' "$mode_screen" | "$HERDR_AXI_NODE" "$script_dir/../src/launch-policy.mjs" --check-cursor-screen --session "$cursor_session" >/dev/null; then
    cleanup_created_tab=false
    exit 1
  fi
fi

if [[ "$kind" == "claude" ]]; then
  # Passing --permission-mode auto is not proof that the provider enabled it.
  # Keep an unsupported or unverified session inspectable, without sending work.
  # Native readiness may precede the first footer render. Retry only missing
  # evidence, with at most 7.75s backoff; a wrong mode fails immediately.
  mode_delays=(0.25 0.5 1 2 4)
  for mode_attempt in 0 1 2 3 4 5; do
    if ! mode_screen=$(herdr agent read "$agent_pane" --source visible --lines 40); then
      cleanup_created_tab=false
      exit 1
    fi
    if mode_error=$(printf '%s\n' "$mode_screen" |
      "$HERDR_AXI_NODE" "$script_dir/../src/launch-policy.mjs" --check-screen 2>&1); then
      break
    fi
    if [[ "$mode_error" != AUTO_MODE_UNVERIFIED:* || "$mode_attempt" == 5 ]]; then
      printf '%s\n' "$mode_error" >&2
      cleanup_created_tab=false
      exit 1
    fi
    sleep "${mode_delays[$mode_attempt]}"
  done
fi

task=$(< "$prompt_file")
if [[ "${HERDR_AXI_MANAGED_TASK:-0}" != "1" ]]; then
  task+=$'\n\nDo not start subagents. No Herdr workers, follow-up tasks, commits or pushes. Scope: assigned files only. Output: concise TOON; files, checks, decisions, blockers. No repository plans/state logs unless explicit deliverables. Coordinator review required.'
fi
completion_task=$(herdr_append_completion_instruction \
  "$task" "$receipt_file" "$completion_generation")

monitor_json=$(herdr pane split \
  --pane "$agent_pane" \
  --direction down \
  --ratio "${HERDR_AXI_AGENT_RATIO:-0.75}" \
  --cwd "$receipt_dir" \
  --env DISABLE_AUTO_UPDATE=true \
  --no-focus)
monitor_pane=$(printf '%s\n' "$monitor_json" | jq -r '.result.pane.pane_id // empty')
[[ -n "$monitor_pane" ]] || {
  printf '%s\n' "herdr-worker: lifecycle monitor pane was not created: $name" >&2
  exit 1
}
# Save the split before sending input: a shell startup UI can consume pane run
# without starting the monitor. Preserve this topology for explicit cancellation.
registry_tmp=$(mktemp "$receipt_dir/$name.json.tmp.XXXXXXXX")
jq --arg monitor_pane "$monitor_pane" '.monitor_pane=$monitor_pane' \
  "$receipt_dir/$name.json" > "$registry_tmp"
mv -f "$registry_tmp" "$receipt_dir/$name.json"
cleanup_created_tab=false
# Split panes inherit the server environment, not necessarily the worker tab's
# custom variables. Pin delivery mode and receipt routing for both live and lost
# workers; a lost agent cannot supply its workspace through backend metadata.
printf -v monitor_command '%q %q %q %q %q %q %q %q %q %q %q %q %q' \
  env "HERDR_AXI_NODE=$HERDR_AXI_NODE" "HERDR_MONITOR_INBOX=${HERDR_MONITOR_INBOX:-0}" \
  "HERDR_BIN=$HERDR_BIN" \
  "HERDR_MONITOR_READY=$completion_generation" \
  "HERDR_RECEIPT_ROOT=$HERDR_RECEIPT_ROOT_DIR" "HERDR_WORKSPACE_ID=$workspace_id" \
  "$script_dir/herdr-lifecycle-monitor.sh" \
  "$name" \
  "$name" \
  "$orchestrator_agent" \
  "$receipt_file" \
  "$script_dir/herdr-hook-notify.sh"
herdr pane run "$monitor_pane" "$monitor_command" >/dev/null
# The monitor publishes ${receipt_file}.monitor-ready only after its live
# identity is published. Output matching is not used; renderers may wrap it.
monitor_ready_file="${receipt_file}.monitor-ready"
monitor_ready_verified=false
monitor_ready_ticks=0
monitor_ready_limit=$(( (${HERDR_MONITOR_READY_TIMEOUT_SECONDS:-10} * 10) ))
while (( monitor_ready_ticks < monitor_ready_limit )); do
  if herdr_monitor_ready_valid "$receipt_file" "$completion_generation"; then
    monitor_ready_verified=true
    rm -f "$monitor_ready_file"
    break
  fi
  monitor_ready_ticks=$((monitor_ready_ticks + 1))
  sleep 0.1
done
if [[ "$monitor_ready_verified" != "true" ]]; then
  rm -f "$monitor_ready_file"
  printf '%s\n' "MONITOR_START_UNVERIFIED: monitor $monitor_pane did not acknowledge startup; task not submitted. Inspect startup and cancel this owned task; no automatic keys or duplicate monitor." >&2
  exit 1
fi

# Persist ownership before submitting any work. A lost startup response must
# not leave the coordinator unaware of a tab it owns.
registry_tmp=$(mktemp "$receipt_dir/$name.json.tmp.XXXXXXXX")
jq --arg monitor_pane "$monitor_pane" \
  '.monitor_pane=$monitor_pane | .stage="submitting"' "$receipt_dir/$name.json" > "$registry_tmp"
mv -f "$registry_tmp" "$receipt_dir/$name.json"
if ! herdr_deliver_prompt "$name" "$completion_task" "$completion_generation"; then
  # Submission may have succeeded. Keep the registered tab for inspection;
  # never destroy a possibly working agent because acknowledgement timed out.
  cleanup_created_tab=false
  herdr_registry_capture_identity "$receipt_dir/$name.json" true || true
  if [[ "$HERDR_PROMPT_REJECTED" != true ]]; then
    printf '%s\n' "herdr-worker: prompt delivery uncertain; inspect registered pane ${agent_pane}" >&2
  fi
  exit 1
fi

cleanup_created_tab=false
trap - EXIT
herdr_registry_capture_identity "$receipt_dir/$name.json" true || exit 1

permission_mode_verified=false
case "$kind" in
  cursor) permission_mode=auto-review ;;
  copilot) permission_mode=autopilot ;;
  codex) permission_mode=approve-for-me ;;
  claude) permission_mode=auto; permission_mode_verified=true ;;
esac

jq -n \
  --arg name "$name" \
  --arg kind "$kind" \
  --arg model "$model" \
  --arg permission_mode "$permission_mode" \
  --argjson permission_mode_verified "$permission_mode_verified" \
  --arg workspace_id "$workspace_id" \
  --arg tab_id "$tab_id" \
  --arg agent_pane "$agent_pane" \
  --arg monitor_pane "$monitor_pane" \
  --arg receipt_file "$receipt_file" \
  --arg generation "$completion_generation" \
  --arg monitoring_mode "$monitoring_mode" \
  --slurpfile registry "$receipt_dir/$name.json" \
  '{name:$name,kind:$kind,model:$model,permission_mode:$permission_mode,permission_mode_verified:$permission_mode_verified,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:($monitor_pane | if . == "" then null else . end),receipt_file:$receipt_file,generation:$generation,monitoring:$monitoring_mode,stage:"submitted"} + ($registry[0] | {native_identity,previous_generation})'
