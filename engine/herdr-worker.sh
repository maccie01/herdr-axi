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
# Direct shell callers need the same stable home across the new worker cwd.
if [[ -n "${CODEX_HOME:-}" && "$CODEX_HOME" != /* ]]; then
  export CODEX_HOME="$(pwd -P)/$CODEX_HOME"
fi
herdr_bin=$(type -P "${HERDR_BIN:-herdr}")
export HERDR_BIN="$(cd -- "$(dirname -- "$herdr_bin")" && pwd)/${herdr_bin##*/}"

usage() {
  printf '%s\n' "usage: $0 --name NAME --kind KIND --cwd PATH --prompt-file PATH [--label LABEL] [--model MODEL] [--effort LEVEL] [--max-autopilot-continues N] [--workspace ID] [--orchestrator-agent NAME]" >&2
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
source "$script_dir/herdr-codex-bootstrap.sh"
source "$script_dir/herdr-engine-config.sh"

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
[[ "$max_autopilot_continues" =~ ^[0-9]+$ && "$max_autopilot_continues" -gt 0 ]] || usage
[[ -n "$label" ]] || label="$name"
herdr_startup_config || exit 2

if ! herdr_receipt_resolve "$name" "$workspace_id" "$orchestrator_agent"; then
  printf '%s\n' "herdr-worker: workspace could not be resolved: $name" >&2
  exit 1
fi
workspace_id="$HERDR_RECEIPT_WORKSPACE_ID"

integration_status=$(herdr integration status) || {
  printf '%s\n' "herdr-worker: could not read installed Herdr integrations" >&2
  exit 1
}
printf '%s\n' "$integration_status" | "$HERDR_AXI_NODE" "$script_dir/../src/launch-policy.mjs" --check-integration "$kind" >/dev/null
launch_args=(--kind "$kind")
[[ -z "$model" ]] || launch_args+=(--model "$model")
[[ -z "$effort" ]] || launch_args+=(--effort "$effort")
launch_policy=$("$HERDR_AXI_NODE" "$script_dir/../src/launch-policy.mjs" --resolve "${launch_args[@]}")
model=$(jq -r '.model // empty' <<<"$launch_policy")
effort=$(jq -r '.effort // empty' <<<"$launch_policy")

receipt_dir="$HERDR_RECEIPT_REGISTRY_DIR"
receipt_file="$HERDR_RECEIPT_FILE"
bootstrap=null

if [[ "$resume" == "true" ]]; then
  registered="$receipt_dir/$name.json"
  [[ -r "$registered" ]] || exit 1
  agent_pane=$(jq -r '.agent_pane' "$registered")
  tab_id=$(jq -r '.tab_id' "$registered")
  [[ "$(jq -r '.stage' "$registered")" == "created" ]] || exit 1
  if [[ "$(jq -r '.monitor_pane // empty' "$registered")" != "" ]]; then
    herdr_engine_error MONITOR_START_UNVERIFIED 'existing monitor startup requires explicit cancellation; refusing a duplicate monitor' false
    exit 1
  fi
  info=$(herdr agent get "$agent_pane")
  jq -e --arg pane "$agent_pane" --arg tab "$tab_id" --arg ws "$workspace_id" \
    --arg name "$name" --arg kind "$kind" \
    --slurpfile registry "$registered" \
    '.result.agent | .pane_id == $pane and .tab_id == $tab and .workspace_id == $ws and .name == $name and .agent == $kind and
      (.agent_status == "idle" or .agent_status == "done" or $registry[0].bootstrap != null)' <<<"$info" >/dev/null || exit 1
  herdr_registry_capture_identity "$registered" || exit 1
  native_identity=$(jq -c '.native_identity' "$registered")
  previous_generation=$(jq -r '.generation' "$registered")
  bootstrap=$(jq -c '.bootstrap // null' "$registered")
  cleanup_created_tab=false
else
  codex_home_args=()
  [[ -z "${CODEX_HOME:-}" ]] || codex_home_args=(--env "CODEX_HOME=$CODEX_HOME")
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
  --env "HERDR_AXI_SIGNAL_TRACE=${HERDR_AXI_SIGNAL_TRACE:-}" \
  --env "HERDR_AXI_RUN=" \
  --env "HERDR_AXI_WORKER=1" \
  --env "CODEX_THREAD_ID=" \
  ${codex_home_args[@]+"${codex_home_args[@]}"} \
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
monitoring_mode="herdr-integration+event-wait+proof"
# Spike switch: HERDR_AXI_NATIVE_HOOKS=0 omits herdr-axi's own provider hooks
# (Claude/Copilot plugins, Codex notify) to measure Herdr-only signalling.
native_hooks="${HERDR_AXI_NATIVE_HOOKS:-1}"
if [[ "$resume" == true && "$bootstrap" != null ]]; then
  completion_generation="$previous_generation"
else
  completion_generation=$(herdr_new_generation)
fi
completion_task=""

# Record returned topology immediately, even when agent startup later fails.
if [[ "$resume" != true || "$bootstrap" == null ]]; then
registry_tmp=$(mktemp "$receipt_dir/$name.json.tmp.XXXXXXXX")
jq -nc --arg name "$name" --arg workspace_id "$workspace_id" \
  --arg tab_id "$tab_id" --arg agent_pane "$agent_pane" \
  --arg receipt_file "$receipt_file" --arg generation "$completion_generation" \
  --arg previous_generation "$previous_generation" --argjson native_identity "$native_identity" --argjson bootstrap "$bootstrap" \
  '{name:$name,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:null,receipt_file:$receipt_file,generation:$generation,previous_generation:$previous_generation,native_identity:$native_identity,stage:"created"} +
   (if $bootstrap == null then {} else {bootstrap:$bootstrap} end)' > "$registry_tmp"
mv -f "$registry_tmp" "$receipt_dir/$name.json"

# Native startup can emit an input hook before agent start returns (trust or
# permission dialog). Arm its generation first so cancellation stays bound.
herdr_receipt_rearm "$receipt_file" worker-start "$completion_generation" || {
  printf '%s\n' "herdr-worker: could not rearm lifecycle receipt: $name" >&2
  exit 1
}
fi

native_args=()
case "$kind" in
  cursor)
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
      --deny-tool 'shell(git commit)'
      --deny-tool 'shell(git push)'
      --deny-tool 'shell(git reset)'
    )
    [[ "$native_hooks" == "0" ]] || native_args+=(--plugin-dir "$script_dir/herdr-monitor-plugins/copilot")
    ;;
  claude)
    native_args=(
      --model "$model"
      --effort "$effort"
      --permission-mode auto
      --name "$name"
    )
    [[ "$native_hooks" == "0" ]] || native_args+=(--plugin-dir "$script_dir/herdr-monitor-plugins/claude")
    ;;
  codex)
    [[ "$native_hooks" == "0" ]] || monitoring_mode="native-notify"
    native_args=(
      --model "$model"
      --approve-for-me
      --add-dir "$receipt_dir"
      --cd "$worker_cwd"
      --config "model_reasoning_effort=$effort"
    )
    [[ "$native_hooks" == "0" ]] || native_args+=(--config "notify=['bash','$script_dir/herdr-hook-notify.sh','settled']")
    ;;
esac

start_json=""
pane_ready_deadline=$(($(date +%s) + start_ready_timeout_seconds))
while [[ "$resume" != "true" ]]; do
  if start_json=$(herdr agent start "$name" \
    --kind "$kind" \
    --pane "$agent_pane" \
    --timeout 120000 \
    -- ${native_args[@]+"${native_args[@]}"} 2>&1); then
    break
  fi
  if (( $(date +%s) >= pane_ready_deadline )) || ! jq -e '.error.code == "agent_pane_busy"' <<<"$start_json" >/dev/null; then
    # Keep startup dialogs inspectable; a human/owner must decide the response.
    if jq -e '.error.code == "agent_not_ready"' <<<"$start_json" >/dev/null; then
      cleanup_created_tab=false
      herdr_registry_capture_identity "$receipt_dir/$name.json" true || true
      herdr_engine_error STARTUP_BLOCKED "Herdr rejected native startup as agent_not_ready; inspect the owned startup dialog before recovery" false
    else
      herdr_engine_error STARTUP_UNVERIFIED "Herdr did not acknowledge native startup; task not submitted" false
    fi
    printf '%s\n' "$start_json" >&2
    exit 1
  fi
  # Native startup validates the foreground shell. Prompt glyphs vary by
  # shell/theme and cannot establish readiness (Powerlevel10k, Starship, etc.).
  sleep 0.25
done

# Herdr integrations use the native session as the replacement-stable identity.
# A terminal alone cannot prove that startup has reached the intended agent, and
# unrelated startup activity can otherwise satisfy a later prompt wait. Allow a
# short reporting delay, then fail closed before creating a monitor or sending
# task text.
# Once started, preserve the tab even if observation fails or finds a replacement.
cleanup_created_tab=false
if [[ "$kind" == codex ]]; then
  herdr_codex_bootstrap "$receipt_dir/$name.json" "$bootstrap_timeout_seconds" || exit 1
fi
if ! herdr_registry_wait_session "$receipt_dir/$name.json" "$session_ready_timeout_seconds"; then
  exit 1
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
    # A failed observation can recover. Keep its frame private so it cannot
    # mislabel a later post-submission failure as an unsubmitted assignment.
    mode_protocol=$(mktemp "$receipt_dir/$name.mode.XXXXXXXX")
    if mode_error=$(printf '%s\n' "$mode_screen" |
      HERDR_AXI_ENGINE_PROTOCOL=1 "$HERDR_AXI_NODE" "$script_dir/../src/launch-policy.mjs" --check-screen 3> "$mode_protocol" 2>&1); then
      rm -f "$mode_protocol"
      break
    fi
    mode_code=$(jq -r 'select(.schema == 1) | .code' "$mode_protocol" 2>/dev/null || true)
    mode_message=$(jq -r 'select(.schema == 1) | .message' "$mode_protocol" 2>/dev/null || true)
    rm -f "$mode_protocol"
    if [[ "$mode_code" != AUTO_MODE_UNVERIFIED || "$mode_attempt" == 5 ]]; then
      herdr_engine_error "${mode_code:-AUTO_MODE_UNVERIFIED}" "${mode_message:-$mode_error}" false
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

monitor_ready_limit=$((monitor_ready_timeout_seconds * 10))

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
# custom variables. Pin transcript home, delivery mode and receipt routing for both live and lost
# workers; a lost agent cannot supply its workspace through backend metadata.
printf -v monitor_command '%q %q %q %q %q %q %q %q %q %q %q %q %q %q %q' \
  env "HERDR_AXI_NODE=$HERDR_AXI_NODE" "HERDR_AXI_SIGNAL_TRACE=${HERDR_AXI_SIGNAL_TRACE:-}" "HERDR_MONITOR_INBOX=${HERDR_MONITOR_INBOX:-0}" \
  "HERDR_BIN=$HERDR_BIN" \
  "CODEX_HOME=${CODEX_HOME:-${HOME}/.codex}" \
  "HERDR_MONITOR_READY=$completion_generation" \
  "HERDR_RECEIPT_ROOT=$HERDR_RECEIPT_ROOT_DIR" "HERDR_WORKSPACE_ID=$workspace_id" \
  "$script_dir/herdr-lifecycle-monitor.sh" \
  "$name" \
  "$name" \
  "$orchestrator_agent" \
  "$receipt_file" \
  "$script_dir/herdr-hook-notify.sh"
# A recovery may reuse the current task generation after a worker-side crash.
# Remove an unconsumed marker before starting the new monitor so only this
# pane's post-identity publication can acknowledge startup.
monitor_ready_file="${receipt_file}.monitor-ready"
rm -f "$monitor_ready_file"
herdr pane run "$monitor_pane" "$monitor_command" >/dev/null
# The monitor publishes ${receipt_file}.monitor-ready only after its live
# identity is published. Output matching is not used; renderers may wrap it.
monitor_ready_verified=false
monitor_ready_ticks=0
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
  herdr_engine_error MONITOR_START_UNVERIFIED "monitor $monitor_pane did not acknowledge startup; task not submitted. Inspect startup and cancel this owned task; no automatic keys or duplicate monitor." false
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
  *) permission_mode=native ;;
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
  '{name:$name,kind:$kind,model:$model,permission_mode:$permission_mode,permission_mode_verified:$permission_mode_verified,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:($monitor_pane | if . == "" then null else . end),receipt_file:$receipt_file,generation:$generation,monitoring:$monitoring_mode,stage:"submitted"} + ($registry[0] | {native_identity,previous_generation} + (if .bootstrap == null then {} else {bootstrap} end))'
