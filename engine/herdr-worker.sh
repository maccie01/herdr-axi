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
  printf '%s\n' "usage: $0 --name NAME --kind copilot|claude|codex --cwd PATH --prompt-file PATH [--model MODEL] [--effort LEVEL] [--max-autopilot-continues N] [--workspace ID] [--orchestrator-agent NAME]" >&2
  exit 2
}

name=""
kind=""
worker_cwd=""
prompt_file=""
model=""
effort="high"
max_autopilot_continues="3"
workspace_id=""
orchestrator_agent="orchestrator"
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=herdr-receipt.sh
source "$script_dir/herdr-receipt.sh"

while (( $# > 0 )); do
  case "$1" in
    --name) name="${2:-}"; shift 2 ;;
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

tab_json=$(herdr tab create \
  --workspace "$workspace_id" \
  --cwd "$worker_cwd" \
  --label "$name" \
  --env HERDR_MONITOR_ENABLED=1 \
  --env "HERDR_WORKSPACE_ID=$workspace_id" \
  --env "HERDR_RECEIPT_ROOT=$HERDR_RECEIPT_ROOT_DIR" \
  --env "HERDR_MONITOR_ORCHESTRATOR=$orchestrator_agent" \
  --env "HERDR_MONITOR_AGENT=$name" \
  --env "HERDR_MONITOR_LABEL=$name" \
  --env "HERDR_MONITOR_HOOK_SCRIPT=$script_dir/herdr-hook-notify.sh" \
  --no-focus)
agent_pane=$(printf '%s\n' "$tab_json" | jq -r '.result.root_pane.pane_id')
tab_id=$(printf '%s\n' "$tab_json" | jq -r '.result.tab.tab_id')
cleanup_created_tab=true
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
      --sandbox workspace-write
      --add-dir "$receipt_dir"
      --cd "$worker_cwd"
      --config "model_reasoning_effort=$effort"
      --config "notify=['bash','$script_dir/herdr-hook-notify.sh','settled']"
    )
    ;;
esac

start_json=""
pane_ready_deadline=$(($(date +%s) + 12))
wait_for_agent_pane() {
  local remaining_seconds remaining_ms
  remaining_seconds=$((pane_ready_deadline - $(date +%s)))
  (( remaining_seconds > 0 )) || return 1
  remaining_ms=$((remaining_seconds * 1000))
  herdr pane wait-output "$agent_pane" \
    --regex '(^|[[:space:]])[$#%>] ?$' \
    --timeout "$remaining_ms" >/dev/null 2>&1
}

for attempt in 1 2 3; do
  if ! wait_for_agent_pane; then
    printf '%s\n' "herdr-worker: agent pane did not become ready: $name" >&2
    exit 1
  fi
  if start_json=$(herdr agent start "$name" \
    --kind "$kind" \
    --pane "$agent_pane" \
    --timeout 120000 \
    -- "${native_args[@]}" 2>&1); then
    break
  fi
  if (( attempt == 3 )) || ! jq -e '.error.code == "agent_pane_busy"' <<<"$start_json" >/dev/null; then
    printf '%s\n' "$start_json" >&2
    exit 1
  fi
done

herdr_receipt_rearm "$receipt_file" worker-start "$completion_generation" || {
  printf '%s\n' "herdr-worker: could not rearm lifecycle receipt: $name" >&2
  exit 1
}

task=$(< "$prompt_file")
case "$kind" in
  copilot|codex)
    task+=$'\n\nLaufzeitdirektive der Orchestrierung: Nutze einmal einen Claude-Opus-Subagenten über die direkte Subagent-Funktion deiner Runtime für eine kurze adversariale Beratung zum riskantesten Teil dieses Pakets. Starte selbst weder Herdr noch den Repo-Orchestrator; falls Opus nicht direkt verfügbar ist, dokumentiere diese Grenze knapp und arbeite selbst weiter. Das ersetzt keine spätere unabhängige Abnahme. Beginne kein Folgepaket und führe weder Commit noch Push aus.'
    ;;
  claude)
    task+=$'\n\nLaufzeitdirektive der Orchestrierung: Nutze einmal einen GPT-5.6-Sol-Subagenten über die direkte Subagent-Funktion deiner Runtime für mechanische Evidenzsammlung oder einen eng begrenzten Gegencheck. Starte selbst weder Herdr noch den Repo-Orchestrator; falls Sol nicht direkt verfügbar ist, dokumentiere diese Grenze knapp und arbeite selbst weiter. Deine unabhängige Opus-Bewertung bleibt maßgeblich. Führe weder Commit noch Push aus.'
    ;;
esac
completion_task=$(herdr_append_completion_instruction \
  "$task" "$receipt_file" "$completion_generation")
if ! herdr_deliver_prompt "$name" "$completion_task" "$completion_generation"; then
  printf '%s\n' "herdr-worker: prompt delivery could not be proven for ${name}" >&2
  exit 1
fi

monitor_json=$(herdr pane split \
  --pane "$agent_pane" \
  --direction down \
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
  '{name:$name,kind:$kind,model:$model,permission_mode:$permission_mode,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:($monitor_pane | if . == "" then null else . end),receipt_file:$receipt_file,generation:$generation,monitoring:$monitoring_mode}'
