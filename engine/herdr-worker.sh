#!/bin/bash
set -euo pipefail

if [[ "${HERDR_ENV:-}" != "1" ]]; then
  printf '%s\n' "herdr-worker: not running inside Herdr" >&2
  exit 2
fi

for dependency in herdr jq uuidgen rg awk find mktemp stat ps date; do
  command -v "$dependency" >/dev/null || {
    printf '%s\n' "herdr-worker: missing dependency: $dependency" >&2
    exit 2
  }
done

usage() {
  printf '%s\n' "usage: $0 --name NAME --kind copilot|claude|codex --cwd PATH --prompt-file PATH [--label LABEL] [--model MODEL] [--effort LEVEL] [--max-autopilot-continues N] [--workspace ID] [--orchestrator-agent NAME]" >&2
  exit 2
}

name=""
label=""
kind=""
worker_cwd=""
prompt_file=""
model=""
effort="high"
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
[[ "$kind" == "copilot" || "$kind" == "claude" || "$kind" == "codex" ]] || usage
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

receipt_dir="$HERDR_RECEIPT_REGISTRY_DIR"
receipt_file="$HERDR_RECEIPT_FILE"

if [[ "$resume" == "true" ]]; then
  registered="$receipt_dir/$name.json"
  [[ -r "$registered" ]] || exit 1
  agent_pane=$(jq -r '.agent_pane' "$registered")
  tab_id=$(jq -r '.tab_id' "$registered")
  [[ "$(jq -r '.stage' "$registered")" == "created" ]] || exit 1
  info=$(herdr agent get "$agent_pane")
  jq -e --arg pane "$agent_pane" --arg tab "$tab_id" --arg ws "$workspace_id" \
    --arg name "$name" --arg kind "$kind" \
    '.result.agent | .pane_id == $pane and .tab_id == $tab and .workspace_id == $ws and .name == $name and .agent == $kind and (.agent_status == "idle" or .agent_status == "done")' <<<"$info" >/dev/null || exit 1
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
  --env "HERDR_AXI_BIN=$script_dir/../bin/herdr-axi.mjs" \
  --env "PATH=$script_dir/../bin:$PATH" \
  --no-focus)
agent_pane=$(printf '%s\n' "$tab_json" | jq -r '.result.root_pane.pane_id')
tab_id=$(printf '%s\n' "$tab_json" | jq -r '.result.tab.tab_id')
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
  '{name:$name,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:null,receipt_file:$receipt_file,generation:$generation,stage:"created"}' > "$registry_tmp"
mv -f "$registry_tmp" "$receipt_dir/$name.json"

case "$kind" in
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
    fi
    printf '%s\n' "$start_json" >&2
    exit 1
  fi
  # Native startup validates the foreground shell. Prompt glyphs vary by
  # shell/theme and cannot establish readiness (Powerlevel10k, Starship, etc.).
  sleep 0.25
done

herdr_receipt_rearm "$receipt_file" worker-start "$completion_generation" || {
  printf '%s\n' "herdr-worker: could not rearm lifecycle receipt: $name" >&2
  exit 1
}

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
  --cwd "$worker_cwd" \
  --no-focus)
monitor_pane=$(printf '%s\n' "$monitor_json" | jq -r '.result.pane.pane_id // empty')
[[ -n "$monitor_pane" ]] || {
  printf '%s\n' "herdr-worker: lifecycle monitor pane was not created: $name" >&2
  exit 1
}
printf -v monitor_command '%q %q %q %q %q %q' \
  "$script_dir/herdr-lifecycle-monitor.sh" \
  "$name" \
  "$name" \
  "$orchestrator_agent" \
  "$receipt_file" \
  "$script_dir/herdr-hook-notify.sh"
herdr pane run "$monitor_pane" "$monitor_command" >/dev/null

# Persist ownership before submitting any work. A lost startup response must
# not leave the coordinator unaware of a tab it owns.
registry_tmp=$(mktemp "$receipt_dir/$name.json.tmp.XXXXXXXX")
jq -nc --arg name "$name" --arg workspace_id "$workspace_id" \
  --arg tab_id "$tab_id" --arg agent_pane "$agent_pane" \
  --arg monitor_pane "$monitor_pane" --arg receipt_file "$receipt_file" \
  --arg generation "$completion_generation" \
  '{name:$name,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:$monitor_pane,receipt_file:$receipt_file,generation:$generation,stage:"submitting"}' > "$registry_tmp"
mv -f "$registry_tmp" "$receipt_dir/$name.json"
if ! herdr_deliver_prompt "$name" "$completion_task" "$completion_generation"; then
  # Submission may have succeeded. Keep the registered tab for inspection;
  # never destroy a possibly working agent because acknowledgement timed out.
  cleanup_created_tab=false
  printf '%s\n' "herdr-worker: prompt delivery uncertain; inspect registered pane ${agent_pane}" >&2
  exit 1
fi

cleanup_created_tab=false
trap - EXIT

if [[ "$kind" == "copilot" ]]; then
  permission_mode="autopilot"
else
  permission_mode="auto"
fi

jq -n \
  --arg name "$name" \
  --arg kind "$kind" \
  --arg model "$model" \
  --arg permission_mode "$permission_mode" \
  --arg workspace_id "$workspace_id" \
  --arg tab_id "$tab_id" \
  --arg agent_pane "$agent_pane" \
  --arg monitor_pane "$monitor_pane" \
  --arg receipt_file "$receipt_file" \
  --arg generation "$completion_generation" \
  --arg monitoring_mode "$monitoring_mode" \
  '{name:$name,kind:$kind,model:$model,permission_mode:$permission_mode,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:($monitor_pane | if . == "" then null else . end),receipt_file:$receipt_file,generation:$generation,monitoring:$monitoring_mode,stage:"submitted"}'
