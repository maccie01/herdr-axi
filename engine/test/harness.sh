#!/bin/bash

# Sourced by the public runner; owns fixture isolation, cleanup and assertions.
test_root=$(mktemp -d "${TMPDIR:-/tmp}/herdr-monitor-test.XXXXXX")
cleanup_running=false
cleanup() {
  local child_pid
  [[ "$cleanup_running" == "false" ]] || return 0
  cleanup_running=true
  for child_pid in $(jobs -pr); do
    kill "$child_pid" 2>/dev/null || true
  done
  for child_pid in $(jobs -pr); do
    wait "$child_pid" 2>/dev/null || true
  done
  rm -rf "$test_root"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

for fixture in herdr ps uuidgen; do
  cp "$script_dir/test/fixtures/$fixture" "$fake_bin/$fixture"
  chmod +x "$fake_bin/$fixture"
done



# Resolve caller-selected dependencies before isolating the backend PATH.
for dependency in rg jq node; do
  dependency_path=$(type -P "$dependency") || {
    printf 'FAIL: missing test dependency: %s\n' "$dependency" >&2
    exit 1
  }
  dependency_path="$(cd -- "$(dirname -- "$dependency_path")" && pwd -P)/${dependency_path##*/}"
  ln -s "$dependency_path" "$fake_bin/$dependency"
done
export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HERDR_BIN="$fake_bin/herdr"
export FAKE_HERDR_ORCHESTRATOR=orch
unset HERDR_AXI_RUN HERDR_AXI_OWNER_PANE HERDR_AXI_OWNER_TAB HERDR_AXI_MANAGED_TASK HERDR_AXI_AGENT_RATIO
unset HERDR_MONITOR_INBOX HERDR_MONITOR_RENDER_ONLY

[[ "$(command -v herdr)" == "$fake_bin/herdr" ]] || {
  printf '%s\n' "FAIL: fake herdr is not the only reachable herdr" >&2
  exit 1
}
if PATH="/usr/bin:/bin:/usr/sbin:/sbin" command -v herdr >/dev/null 2>&1; then
  printf '%s\n' "FAIL: real herdr is reachable in the isolated system PATH" >&2
  exit 1
fi

fail() {
  printf '%s\n' "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local description="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$description: expected '$expected', got '$actual'"
}

assert_file_absent() {
  local path="$1"
  local description="$2"
  [[ ! -e "$path" ]] || fail "$description: $path still exists"
}

assert_file_present() {
  local path="$1"
  local description="$2"
  [[ -e "$path" ]] || fail "$description: $path is absent"
}

file_value() {
  local path="$1"
  local fallback="${2:-0}"
  local value=""
  if [[ -r "$path" ]]; then
    { IFS= read -r value < "$path"; } 2>/dev/null || value="$fallback"
    printf '%s\n' "$value"
  else
    printf '%s\n' "$fallback"
  fi
}

call_count() {
  local pattern="$1"
  if [[ -r "$FAKE_HERDR_CASE/calls" ]]; then
    grep -c "$pattern" "$FAKE_HERDR_CASE/calls" || true
  else
    printf '%s\n' 0
  fi
}

setup_case() {
  local name="$1"
  export FAKE_HERDR_CASE="$test_root/cases/$name"
  export TMPDIR="$FAKE_HERDR_CASE/tmp"
  export HOME="$FAKE_HERDR_CASE/home"
  export CODEX_HOME="$HOME/.codex"
  export HERDR_RECEIPT_ROOT="$FAKE_HERDR_CASE/receipts"
  export HERDR_ENV=1
  export HERDR_WORKSPACE_ID=ws
  export HERDR_MONITOR_ENABLED=1
  export HERDR_MONITOR_ORCHESTRATOR=orch
  export HERDR_MONITOR_AGENT=worker
  export HERDR_MONITOR_LABEL=worker
  export HERDR_MONITOR_RECEIPT="$HERDR_RECEIPT_ROOT/ws/worker.event"
  export FAKE_MONITOR_PID=$$
  unset HERDR_MONITOR_RESULT_FILE
  unset FAKE_HERDR_APPEND_USER
  mkdir -p \
    "$TMPDIR" \
    "$HOME/.copilot/session-state/session-1" \
    "$HOME/.claude/projects" \
    "$HOME/.codex/sessions"
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/orchestrator-status"
  printf '%s\n' copilot > "$FAKE_HERDR_CASE/kind"
  printf '%s\n' ws > "$FAKE_HERDR_CASE/workspace"
  printf '%s\n' session-1 > "$FAKE_HERDR_CASE/session"
  printf '%s\n' '❯' '⏵⏵ auto mode on (shift+tab to cycle) · for agents' > "$FAKE_HERDR_CASE/startup-screen"
}

transcript_path() {
  printf '%s\n' "$HOME/.copilot/session-state/session-1/events.jsonl"
}

write_complete_transcript() {
  printf '%s\n' \
    '{"type":"user.message","data":{"content":"work .proof.generation-one"}}' \
    '{"type":"assistant.message","data":{"content":"done"}}' \
    '{"type":"session.task_complete","data":{"summary":"complete"}}' \
    > "$(transcript_path)"
  arm_completion_generation
}

write_claude_transcript() {
  local path="$HOME/.claude/projects/session-1.jsonl"
  printf '%s\n' \
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"work .proof.generation-one"}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"intermediate"}]}}' \
    > "$path"
  printf '%s\n' "$path"
}

write_codex_transcript() {
  local path="$HOME/.codex/sessions/rollout-session-1.jsonl"
  printf '%s\n' \
    '{"type":"event_msg","payload":{"type":"user_message","message":"work .proof.generation-one"}}' \
    '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"complete"}]}}' \
    > "$path"
  printf '%s\n' "$path"
}

arm_completion_generation() {
  local generation="${1:-generation-one}"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    herdr-receipt/3 1 cycle armed "" "" "" "" open "$generation" test \
    > "$HERDR_MONITOR_RECEIPT"
  write_current_completion_proof
}

write_current_completion_proof() {
  local generation completion_file
  generation=$(cut -f 10 "$HERDR_MONITOR_RECEIPT")
  completion_file="${HERDR_MONITOR_RECEIPT}.proof.${generation}"
  printf '%s\n' "$generation" > "$completion_file"
}

write_worker_registry() {
  local name="${1:-worker}"
  local workspace="${2:-ws}"
  local generation="${3:-$(cut -f 10 "$HERDR_RECEIPT_ROOT/$workspace/$name.event")}"
  local registry_dir="$HERDR_RECEIPT_ROOT/$workspace"
  mkdir -p "$registry_dir"
  jq -nc \
    --arg name "$name" \
    --arg workspace_id "$workspace" \
    --arg tab_id tab-1 \
    --arg agent_pane pane-1 \
    --arg monitor_pane monitor-1 \
    --arg receipt_file "$registry_dir/$name.event" \
    --arg generation "$generation" \
    '{name:$name,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:$monitor_pane,receipt_file:$receipt_file,generation:$generation,native_identity:{terminal:"terminal-1",session:"session-1"}}' \
    > "$registry_dir/$name.json"
  : > "$FAKE_HERDR_CASE/tab-alive"
  : > "$FAKE_HERDR_CASE/pane-1-alive"
  : > "$FAKE_HERDR_CASE/monitor-1-alive"
  printf '%s\t%s\n' "$FAKE_MONITOR_PID" "$(/bin/ps -p "$FAKE_MONITOR_PID" -o lstart= | awk '{$1=$1; print}')" > "$registry_dir/$name.event.monitor-owner"
}

remove_current_completion_proof() {
  local generation
  generation=$(cut -f 10 "$HERDR_MONITOR_RECEIPT")
  rm -f "${HERDR_MONITOR_RECEIPT}.proof.${generation}"
}

append_user_message() {
  jq -nc --arg generation "$(cut -f 10 "$HERDR_MONITOR_RECEIPT")" \
    '{type:"user.message",data:{content:("more work .proof." + $generation)}}' \
    >> "$(transcript_path)"
}

append_task_complete() {
  printf '%s\n' '{"type":"session.task_complete","data":{"summary":"complete again"}}' \
    >> "$(transcript_path)"
}

payload() {
  jq -nc --arg path "$(transcript_path)" \
    '{transcriptPath:$path,session_id:"session-1",last_assistant_message:"native completion"}'
}

payload_with_path() {
  jq -nc --arg path "$1" \
    '{transcriptPath:$path,last_assistant_message:"native completion without transcript"}'
}

run_hook() {
  # Managed production hooks always have a registered worker before delivery.
  # Legacy standalone fixtures intentionally retain their registry-free setup.
  if [[ "${HERDR_MONITOR_INBOX:-0}" == 1 && "${HERDR_TEST_NO_REGISTRY:-0}" != 1 &&
    -r "$HERDR_MONITOR_RECEIPT" && ! -e "${HERDR_MONITOR_RECEIPT%.event}.json" ]]; then
    write_worker_registry
  fi
  if [[ "${HERDR_TEST_TRACE_HOOK:-0}" == "1" ]]; then
    bash -x "$hook_script" "$1" "${2:-{}}"
  else
    bash "$hook_script" "$1" "${2:-{}}"
  fi
}

receipt_read_field() {
  cut -f "$1" "$HERDR_MONITOR_RECEIPT"
}

wait_for_file() {
  local path="$1"
  local attempts="${2:-100}"
  local index=0
  while [[ ! -e "$path" && "$index" -lt "$attempts" ]]; do
    index=$((index + 1))
    sleep 0.02
  done
  [[ -e "$path" ]]
}

assert_no_fake_waiters() {
  local description="$1"
  local attempt
  for attempt in $(seq 1 250); do
    if ! ps -ax -o command= |
      awk -v fake="$fake_bin/herdr agent wait" \
        '$1 ~ /bash$/ && index($0, fake) { found=1 } END { exit !found }'; then
      return 0
    fi
    sleep 0.02
  done
  fail "$description: fake herdr wait process survived"
}
