#!/bin/bash
set -euo pipefail

if [[ "${1:-}" == "--signal-fixture" ]]; then
  fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/herdr-monitor-signal.XXXXXX")
  cleanup_fixture() {
    rm -rf "$fixture_root"
  }
  trap cleanup_fixture EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '%s\n' "$fixture_root" > "${2:?}"
  while true; do
    sleep 1
  done
fi

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
hook_script="$script_dir/herdr-hook-notify.sh"
monitor_script="$script_dir/herdr-lifecycle-monitor.sh"
worker_script="$script_dir/herdr-worker.sh"
orchestrator_script="$script_dir/herdr-orchestrator.sh"
receipt_script="$script_dir/herdr-receipt.sh"
test_script="$script_dir/test-herdr-monitor.sh"

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

cat > "$fake_bin/herdr" <<'EOF'
#!/bin/bash
set -euo pipefail

case_dir="${FAKE_HERDR_CASE:?}"
orchestrator="${FAKE_HERDR_ORCHESTRATOR:-orch}"
mkdir -p "$case_dir"

read_value() {
  local path="$1"
  local fallback="$2"
  local value=""
  if [[ -r "$path" ]]; then
    { IFS= read -r value < "$path"; } 2>/dev/null || value="$fallback"
  else
    value="$fallback"
  fi
  [[ "$value" != "__empty__" ]] || value=""
  printf '%s\n' "$value"
}

acquire_case_lock() {
  local lock_dir="$case_dir/counter.lock"
  while ! mkdir "$lock_dir" 2>/dev/null; do
    sleep 0.005
  done
}

release_case_lock() {
  rmdir "$case_dir/counter.lock"
}

record_call() {
  acquire_case_lock
  printf '%s\n' "$*" >> "$case_dir/calls"
  release_case_lock
}

status_for() {
  if [[ "$1" == "$orchestrator" ]]; then
    read_value "$case_dir/orchestrator-status" idle
  else
    read_value "$case_dir/status" done
  fi
}

matches_target() {
  local candidate="$1"
  shift
  local target
  for target in "$@"; do
    [[ "$candidate" != "$target" ]] || return 0
  done
  return 1
}

group="${1:-}"
action="${2:-}"
shift $(( $# >= 2 ? 2 : $# ))
record_call "$group $action $*"
if [[ -e "$case_dir/check-unlocked-reads" && "$group" == "agent" &&
  ( "$action" == "get" || "$action" == "read" ) && -e "${HERDR_MONITOR_RECEIPT:-/nonexistent}.lock" ]]; then
  printf '%s\n' "$group $action" >> "$case_dir/locked-backend-reads"
fi

case "$group:$action" in
  agent:get)
    [[ ! -e "$case_dir/agent-get-fail" ]] || exit 1
    name="${1:-worker}"
    [[ "$name" != "pane-1" ]] || name=worker
    status=$(status_for "$name")
    kind=$(read_value "$case_dir/kind" copilot)
    workspace=$(read_value "$case_dir/workspace" ws)
    session=$(read_value "$case_dir/session" session-1)
    tab_id=$(read_value "$case_dir/agent-tab-id" tab-1)
    pane_id=$(read_value "$case_dir/agent-pane-id" pane-1)
    jq -nc \
      --arg name "$name" \
      --arg status "$status" \
      --arg kind "$kind" \
      --arg workspace "$workspace" \
      --arg session "$session" \
      --arg tab_id "$tab_id" \
      --arg pane_id "$pane_id" \
      '{result:{agent:{name:$name,agent_status:$status,agent:$kind,workspace_id:$workspace,agent_session:{value:$session},tab_id:$tab_id,pane_id:$pane_id,cwd:"/tmp"}}}'
    ;;
  agent:prompt)
    target="${1:?}"
    message="${2:-}"
    acquire_case_lock
    if [[ "$target" == "$orchestrator" ]]; then
      attempts=$(read_value "$case_dir/prompt-attempts" 0)
      printf '%s\n' "$((attempts + 1))" > "$case_dir/prompt-attempts"
      failures=$(read_value "$case_dir/prompt-failures" 0)
      if (( failures > 0 )); then
        printf '%s\n' "$((failures - 1))" > "$case_dir/prompt-failures"
        release_case_lock
        exit 1
      fi
      successes=$(read_value "$case_dir/prompt-successes" 0)
      printf '%s\n' "$((successes + 1))" > "$case_dir/prompt-successes"
      {
        printf '%s\n' "=== PROMPT ==="
        printf '%s\n' "$message"
      } >> "$case_dir/messages"
    else
      if [[ -e "$case_dir/worker-prompt-fail" ]]; then
        release_case_lock
        exit 1
      fi
      worker_prompts=$(read_value "$case_dir/worker-prompts" 0)
      printf '%s\n' "$((worker_prompts + 1))" > "$case_dir/worker-prompts"
      printf '%s\n' "$message" > "$case_dir/visible"
      prompt_mode=$(read_value "$case_dir/worker-prompt-mode" success)
      case "$prompt_mode" in
        success)
          printf '%s\n' working > "$case_dir/status"
          ;;
        stalled-visible)
          printf '%s\n' idle > "$case_dir/status"
          release_case_lock
          jq -nc '{error:{code:"agent_prompt_stalled"}}'
          exit 1
          ;;
        stalled-hidden)
          : > "$case_dir/visible"
          printf '%s\n' idle > "$case_dir/status"
          release_case_lock
          jq -nc '{error:{code:"agent_prompt_stalled"}}'
          exit 1
          ;;
        slow-start)
          printf '%s\n' idle > "$case_dir/status"
          : > "$case_dir/start-on-read"
          release_case_lock
          jq -nc '{error:{code:"agent_prompt_stalled"}}'
          exit 1
          ;;
        blocked)
          printf '%s\n' blocked > "$case_dir/status"
          release_case_lock
          jq -nc '{error:{code:"agent_blocked"}}'
          exit 1
          ;;
        *)
          release_case_lock
          exit 2
          ;;
      esac
      if [[ "${FAKE_HERDR_APPEND_USER:-0}" == "1" ]]; then
        printf '%s\n' '{"type":"user.message","data":{"content":"follow-up"}}' \
          >> "${HOME}/.copilot/session-state/$(read_value "$case_dir/session" session-1)/events.jsonl"
      fi
    fi
    release_case_lock
    jq -nc '{result:{prompt_delivered:true}}'
    ;;
  agent:wait)
    name="${1:-worker}"
    shift || true
    targets=()
    while (( $# > 0 )); do
      case "$1" in
        --until)
          targets+=("${2:-}")
          shift 2
          ;;
        --timeout)
          shift 2
          ;;
        *) shift ;;
      esac
    done
    for _ in $(seq 1 500); do
      if [[ -e "$case_dir/tab-close-pending" ]] &&
        matches_target unknown "${targets[@]}"; then
        rm -f \
          "$case_dir/tab-close-pending" \
          "$case_dir/tab-alive" \
          "$case_dir/pane-1-alive" \
          "$case_dir/monitor-1-alive"
        printf '%s\n' unknown > "$case_dir/status"
      fi
      current=$(status_for "$name")
      if matches_target "$current" "${targets[@]}"; then
        exit 0
      fi
      [[ ! -e "$case_dir/release-waits" ]] || exit 1
      sleep 0.02
    done
    exit 1
    ;;
  agent:read)
    if [[ -e "$case_dir/delayed-footer" ]]; then
      remaining=$(read_value "$case_dir/delayed-footer" 1)
      if (( remaining > 1 )); then
        printf '%s\n' "$((remaining - 1))" > "$case_dir/delayed-footer"
      else
        rm -f "$case_dir/delayed-footer"
      fi
      printf '%s\n' 'Starting Claude...'
      exit 0
    fi
    if [[ -e "$case_dir/start-on-read" ]]; then
      rm -f "$case_dir/start-on-read"
      printf '%s\n' working > "$case_dir/status"
    fi
    if [[ -r "$case_dir/visible" ]]; then
      cat "$case_dir/visible"
    elif [[ -r "$case_dir/startup-screen" ]]; then
      cat "$case_dir/startup-screen"
    else
      printf '%s\n' "fake visible agent output"
    fi
    ;;
  agent:start)
    if [[ -e "$case_dir/start-blocked" ]]; then
      printf '%s\n' blocked > "$case_dir/status"
      if [[ -r "$case_dir/start-hook" ]]; then
        HERDR_MONITOR_INBOX=1 bash "$(< "$case_dir/start-hook")" input '{"message":"Approve this folder?"}'
      fi
      jq -nc '{error:{code:"agent_not_ready"}}'
      exit 1
    fi
    if [[ -e "$case_dir/pane-wait-fail" ]]; then
      jq -nc '{error:{code:"agent_pane_busy"}}'
      exit 1
    fi
    sleep "$(read_value "$case_dir/pane-ready-delay" 0)"
    busy_count=$(read_value "$case_dir/start-busy-count" 0)
    if (( busy_count > 0 )); then
      printf '%s\n' "$((busy_count - 1))" > "$case_dir/start-busy-count"
      jq -nc '{error:{code:"agent_pane_busy"}}'
      exit 1
    fi
    printf '%s\n' idle > "$case_dir/status"
    jq -nc '{result:{started:true}}'
    ;;
  agent:send-keys)
    printf '%s\n' working > "$case_dir/status"
    ;;
  tab:create)
    while (( $# > 0 )); do
      if [[ "$1" == "--label" ]]; then printf '%s\n' "$2" > "$case_dir/tab-label"; break; fi
      shift
    done
    : > "$case_dir/tab-alive"
    : > "$case_dir/pane-1-alive"
    rm -f "$case_dir/pane-ready"
    jq -nc '{result:{root_pane:{pane_id:"pane-1"},tab:{tab_id:"tab-1"}}}'
    ;;
  tab:get)
    acquire_case_lock
    tab_get_count=$(read_value "$case_dir/tab-get-count" 0)
    tab_get_count=$((tab_get_count + 1))
    printf '%s\n' "$tab_get_count" > "$case_dir/tab-get-count"
    tab_get_fail_at=$(read_value "$case_dir/tab-get-fail-at" 0)
    release_case_lock
    if (( tab_get_count == tab_get_fail_at )); then
      jq -nc '{error:{code:"transport_failed"}}'
      exit 1
    fi
    [[ -e "$case_dir/tab-alive" ]] || {
      jq -nc '{error:{code:"tab_not_found"}}'
      exit 1
    }
    pane_count=0
    for pane_file in pane-1-alive monitor-1-alive extra-pane; do
      [[ ! -e "$case_dir/$pane_file" ]] || pane_count=$((pane_count + 1))
    done
    jq -nc --argjson count "$pane_count" '{result:{tab:{tab_id:"tab-1",workspace_id:"ws",pane_count:$count}}}'
    ;;
  tab:close)
    [[ ! -e "$case_dir/tab-close-fail" ]] || exit 1
    if [[ -e "$case_dir/tab-close-deferred" ]]; then
      : > "$case_dir/tab-close-pending"
    elif [[ ! -e "$case_dir/tab-close-sticky" ]]; then
      rm -f \
        "$case_dir/tab-alive" \
        "$case_dir/pane-1-alive" \
        "$case_dir/monitor-1-alive"
      printf '%s\n' unknown > "$case_dir/status"
    else
      printf '%s\n' unknown > "$case_dir/status"
    fi
    printf '%s\n' closed > "$case_dir/closed"
    ;;
  pane:wait-output)
    [[ ! -e "$case_dir/pane-wait-fail" ]] || exit 1
    ready_delay=$(read_value "$case_dir/pane-ready-delay" 0)
    sleep "$ready_delay"
    : > "$case_dir/pane-ready"
    jq -nc '{result:{matched:true}}'
    ;;
  pane:split)
    : > "$case_dir/monitor-1-alive"
    jq -nc '{result:{pane:{pane_id:"monitor-1"}}}'
    ;;
  pane:get)
    pane_id="${1:?}"
    [[ -e "$case_dir/${pane_id}-alive" ]] || {
      jq -nc '{error:{code:"pane_not_found"}}'
      exit 1
    }
    jq -nc --arg pane_id "$pane_id" \
      '{result:{pane:{pane_id:$pane_id,tab_id:"tab-1",workspace_id:"ws"}}}'
    ;;
  pane:run)
    printf '%s\n' "$*" > "$case_dir/monitor-command"
    ;;
  pane:close)
    [[ ! -e "$case_dir/pane-close-fail" ]] || exit 1
    rm -f "$case_dir/${1:?}-alive"
    printf '%s\n' closed > "$case_dir/closed"
    ;;
  *)
    printf '%s\n' "unsupported fake herdr call: $group $action $*" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$fake_bin/herdr"

cat > "$fake_bin/ps" <<'EOF'
#!/bin/bash
set -euo pipefail

case_dir="${FAKE_HERDR_CASE:-}"
target_pid=""
for ((index=1; index <= $#; index++)); do
  if [[ "${!index}" == "-p" ]]; then
    next=$((index + 1))
    target_pid="${!next:-}"
    break
  fi
done
if [[ -n "$case_dir" && -r "$case_dir/ps-fail-pid" &&
  -r "$case_dir/ps-fail-count" &&
  "$target_pid" == "$(< "$case_dir/ps-fail-pid")" ]]; then
  count=$(< "$case_dir/ps-fail-count")
  if (( count > 0 )); then
    printf '%s\n' "$((count - 1))" > "$case_dir/ps-fail-count"
    exit 0
  fi
fi
exec /bin/ps "$@"
EOF
chmod +x "$fake_bin/ps"

cat > "$fake_bin/uuidgen" <<'EOF'
#!/bin/bash
printf '%s\n' "00000000-0000-4000-8000-000000000001"
EOF
chmod +x "$fake_bin/uuidgen"

ln -s /opt/homebrew/bin/rg "$fake_bin/rg"
ln -s "$(command -v node)" "$fake_bin/node"
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
  export HERDR_RECEIPT_ROOT="$FAKE_HERDR_CASE/receipts"
  export HERDR_ENV=1
  export HERDR_WORKSPACE_ID=ws
  export HERDR_MONITOR_ENABLED=1
  export HERDR_MONITOR_ORCHESTRATOR=orch
  export HERDR_MONITOR_AGENT=worker
  export HERDR_MONITOR_LABEL=worker
  export HERDR_MONITOR_RECEIPT="$HERDR_RECEIPT_ROOT/ws/worker.event"
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
    '{"type":"user.message","data":{"content":"work"}}' \
    '{"type":"assistant.message","data":{"content":"done"}}' \
    '{"type":"session.task_complete","data":{"summary":"complete"}}' \
    > "$(transcript_path)"
  arm_completion_generation
}

write_claude_transcript() {
  local path="$HOME/.claude/projects/session-1.jsonl"
  printf '%s\n' \
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"work"}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"intermediate"}]}}' \
    > "$path"
  printf '%s\n' "$path"
}

write_codex_transcript() {
  local path="$HOME/.codex/sessions/rollout-session-1.jsonl"
  printf '%s\n' \
    '{"type":"event_msg","payload":{"type":"user_message","message":"work"}}' \
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
    '{name:$name,workspace_id:$workspace_id,tab_id:$tab_id,agent_pane:$agent_pane,monitor_pane:$monitor_pane,receipt_file:$receipt_file,generation:$generation}' \
    > "$registry_dir/$name.json"
  : > "$FAKE_HERDR_CASE/tab-alive"
  : > "$FAKE_HERDR_CASE/pane-1-alive"
  : > "$FAKE_HERDR_CASE/monitor-1-alive"
}

remove_current_completion_proof() {
  local generation
  generation=$(cut -f 10 "$HERDR_MONITOR_RECEIPT")
  rm -f "${HERDR_MONITOR_RECEIPT}.proof.${generation}"
}

append_user_message() {
  printf '%s\n' '{"type":"user.message","data":{"content":"more work"}}' \
    >> "$(transcript_path)"
}

append_task_complete() {
  printf '%s\n' '{"type":"session.task_complete","data":{"summary":"complete again"}}' \
    >> "$(transcript_path)"
}

payload() {
  jq -nc --arg path "$(transcript_path)" \
    '{transcriptPath:$path,last_assistant_message:"native completion"}'
}

payload_with_path() {
  jq -nc --arg path "$1" \
    '{transcriptPath:$path,last_assistant_message:"native completion without transcript"}'
}

run_hook() {
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

test_concurrent_settled_once() (
  setup_case concurrent
  concurrency_gate=""
  if [[ -n "${HERDR_MONITOR_CONCURRENCY_GATE_ROOT:-}" ]]; then
    mkdir -p "$HERDR_MONITOR_CONCURRENCY_GATE_ROOT"
    concurrency_gate="$HERDR_MONITOR_CONCURRENCY_GATE_ROOT/active"
    while ! mkdir "$concurrency_gate" 2>/dev/null; do
      sleep 0.05
    done
    trap 'rmdir "$concurrency_gate" 2>/dev/null || true' EXIT
  fi
  write_complete_transcript
  event_payload=$(payload)
  concurrent_count="${HERDR_CONCURRENT_COUNT:-32}"
  for index in $(seq 1 "$concurrent_count"); do
    HERDR_MONITOR_RESULT_FILE="$TMPDIR/concurrent-$index.result" \
      run_hook settled "$event_payload" &
  done
  wait
  first_result=$(find "$TMPDIR" -name 'concurrent-*.result' -type f \
    -exec head -n 1 {} \; 2>/dev/null | head -n 1)
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "$concurrent_count concurrent settled hooks (${first_result:-no result})"
  assert_eq settled "$(receipt_read_field 6)" "delivered terminal event"
  [[ -n "$(receipt_read_field 8)" ]] || fail "settled fingerprint is empty"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.lock" "concurrent lock cleanup"
)

test_missing_transcripts_and_stale_copilot() (
  setup_case missing-claude
  printf '%s\n' claude > "$FAKE_HERDR_CASE/kind"
  arm_completion_generation
  claude_path="$HOME/.claude/projects/session-1.jsonl"
  result_file="$TMPDIR/claude.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" \
    run_hook settled "$(payload_with_path "$claude_path")"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "Claude payload without transcript"
  assert_eq suppressed "$(cut -f 1 "$result_file")" "Claude result"
  assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
    "Claude missing transcript reason"

  setup_case missing-codex
  printf '%s\n' codex > "$FAKE_HERDR_CASE/kind"
  arm_completion_generation
  codex_path="$HOME/.codex/sessions/rollout-session-1.jsonl"
  result_file="$TMPDIR/codex.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" \
    run_hook settled "$(payload_with_path "$codex_path")"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "Codex payload without transcript"
  assert_eq suppressed "$(cut -f 1 "$result_file")" "Codex result"
  assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
    "Codex missing transcript reason"

  setup_case stale-copilot
  write_complete_transcript
  stale_path="$HOME/.copilot/session-state/other-session/events.jsonl"
  result_file="$TMPDIR/stale.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" \
    run_hook settled "$(payload_with_path "$stale_path")"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "stale Copilot transcript"
  assert_eq suppressed "$(cut -f 1 "$result_file")" "stale outcome"
  assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
    "stale reason"
)

test_terminal_dedup_across_nested_events() (
  setup_case nested-events
  write_complete_transcript
  event_payload=$(payload)
  run_hook settled "$event_payload"
  original_settled=$(receipt_read_field 8)
  run_hook input '{"title":"Approval","message":"Input needed"}'
  run_hook error '{"message":"Worker failed"}'
  run_hook lost '{}'
  assert_eq 4 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "nested nonterminal delivery"
  assert_eq "$original_settled" "$(receipt_read_field 8)" \
    "settled fingerprint preservation"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  result_output=$(bash "$orchestrator_script" result worker)
  [[ "$result_output" == *'ist fertig'* ]] ||
    fail "nonterminal event downgraded the completed cycle"
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  run_hook settled "$event_payload"
  assert_eq 4 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "identical settled after nested events"
  assert_eq duplicate-settled "$(receipt_read_field 11)" \
    "terminal duplicate reason"
)

test_close_tombstone_followup_and_rearm() (
  setup_case close-followup
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] || fail "close did not report success"
  assert_eq closed "$(receipt_read_field 9)" "close tombstone"
  assert_eq 1 "$(receipt_read_field 2)" "close tombstone cycle"
  assert_eq settled "$(receipt_read_field 6)" "close delivered event"
  assert_eq generation:generation-one "$(receipt_read_field 8)" \
    "close settled fingerprint"
  assert_eq generation-one "$(receipt_read_field 10)" \
    "close generation"
  assert_eq close "$(receipt_read_field 11)" "close reason"

  run_hook input '{"title":"Approval","message":"Late input"}'
  assert_eq closed "$(receipt_read_field 9)" "tombstone after input"
  assert_eq closed-tombstone "$(receipt_read_field 11)" "late input suppressed"
  run_hook settled "$(payload)"
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "all post-close notifications suppressed"

  prompt_file="$FAKE_HERDR_CASE/followup.txt"
  printf '%s\n' "next turn" > "$prompt_file"
  export FAKE_HERDR_APPEND_USER=1
  bash "$orchestrator_script" followup worker --prompt-file "$prompt_file" >/dev/null
  assert_eq armed "$(receipt_read_field 4)" "followup armed state"
  assert_eq open "$(receipt_read_field 9)" "followup opens tombstone"
  append_task_complete
  write_current_completion_proof
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  run_hook settled "$(payload)"
  assert_eq 2 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "completion after followup"
)

test_workspace_fallback_shared_by_all_callers() (
  setup_case workspace-fallback
  write_complete_transcript
  unset HERDR_WORKSPACE_ID
  unset HERDR_MONITOR_RECEIPT
  fallback_receipt="$HERDR_RECEIPT_ROOT/ws/worker.event"
  run_hook settled "$(payload)"
  assert_file_present "$fallback_receipt" "hook fallback receipt"

  prompt_file="$FAKE_HERDR_CASE/followup.txt"
  printf '%s\n' "next turn" > "$prompt_file"
  export FAKE_HERDR_APPEND_USER=1
  bash "$orchestrator_script" followup worker --prompt-file "$prompt_file" >/dev/null
  assert_eq armed "$(cut -f 4 "$fallback_receipt")" \
    "orchestrator shared fallback"

  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "new worker" > "$worker_prompt"
  worker_output=$(bash "$worker_script" \
    --name worker-two \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --orchestrator-agent orch)
  assert_eq "$HERDR_RECEIPT_ROOT/ws/worker-two.event" \
    "$(printf '%s\n' "$worker_output" | jq -r '.receipt_file')" \
    "worker shared fallback"
  assert_eq "$(cut -f 10 "$HERDR_RECEIPT_ROOT/ws/worker-two.event")" \
    "$(printf '%s\n' "$worker_output" | jq -r '.generation')" \
    "worker registry generation"
  assert_file_absent "$HERDR_RECEIPT_ROOT/default" "default workspace"
)

test_workspace_resolution_hard_failure() (
  setup_case workspace-failure
  unset HERDR_WORKSPACE_ID
  unset HERDR_MONITOR_RECEIPT
  printf '%s\n' __empty__ > "$FAKE_HERDR_CASE/workspace"
  result_file="$TMPDIR/workspace.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" run_hook lost '{}'
  assert_eq error "$(cut -f 1 "$result_file")" "hook workspace failure"
  assert_eq workspace-unresolved "$(cut -f 2 "$result_file")" \
    "hook workspace reason"

  prompt_file="$FAKE_HERDR_CASE/followup.txt"
  printf '%s\n' "next" > "$prompt_file"
  if bash "$orchestrator_script" followup worker --prompt-file "$prompt_file" \
    >/dev/null 2>&1; then
    fail "orchestrator accepted an unresolved workspace"
  fi
  if bash "$worker_script" \
    --name worker-two \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$prompt_file" \
    --orchestrator-agent orch >/dev/null 2>&1; then
    fail "worker accepted an unresolved workspace"
  fi
  assert_file_absent "$HERDR_RECEIPT_ROOT/default" "hard-failure default"
)

test_close_priority_and_close_failure() (
  setup_case close-priority
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close interrupted a working Herdr turn"
  fi
  assert_eq open "$(receipt_read_field 9)" "working close tombstone"

  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  : > "$FAKE_HERDR_CASE/tab-close-fail"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close succeeded despite tab close failure"
  fi
  assert_eq open "$(receipt_read_field 9)" "failed tab close tombstone"
  rm -f "$FAKE_HERDR_CASE/tab-close-fail"
  bash "$orchestrator_script" close worker >/dev/null
  assert_eq closed "$(receipt_read_field 9)" "successful tab close tombstone"

  setup_case unregistered-close
  write_complete_transcript
  run_hook settled "$(payload)"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close succeeded without a registered lifecycle"
  fi
  assert_eq open "$(receipt_read_field 9)" "unregistered close tombstone"
  assert_eq 0 "$(call_count 'pane close')" \
    "unregistered close pane fallback count"
)

test_registered_tab_close_and_idempotency() (
  setup_case close-two-pane
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  : > "$FAKE_HERDR_CASE/tab-close-deferred"
  registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "registered two-pane close did not report success"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "registered tab after close"
  assert_file_absent "$FAKE_HERDR_CASE/pane-1-alive" \
    "registered agent pane after close"
  assert_file_absent "$FAKE_HERDR_CASE/monitor-1-alive" \
    "registered monitor pane after close"
  assert_file_absent "$registry" "registry after verified close"
  assert_eq 1 "$(call_count 'tab close tab-1')" \
    "registered tab close count"
  assert_eq 1 "$(call_count 'agent wait worker --until unknown')" \
    "registered close event wait count"
  assert_eq 0 "$(call_count 'pane close')" \
    "registered close pane fallback count"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "repeated close was not harmless"
  assert_eq 1 "$(call_count 'tab close tab-1')" \
    "repeated close tab count"
  assert_eq 0 "$(call_count 'pane close')" \
    "repeated close pane count"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "repeated close recreated tab"
)

test_monitor_only_legacy_tab_close() (
  setup_case close-monitor-only
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  jq 'del(.generation)' "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    > "$HERDR_RECEIPT_ROOT/ws/worker.json.tmp"
  mv "$HERDR_RECEIPT_ROOT/ws/worker.json.tmp" \
    "$HERDR_RECEIPT_ROOT/ws/worker.json"
  rm -f "$FAKE_HERDR_CASE/pane-1-alive"
  printf '%s\n' unknown > "$FAKE_HERDR_CASE/status"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "monitor-only registered tab close did not report success"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "monitor-only registered tab after close"
  assert_file_absent "$FAKE_HERDR_CASE/monitor-1-alive" \
    "monitor-only registered pane after close"
  assert_file_absent "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "monitor-only registry after close"
)

test_close_ignores_inherited_paths() (
  setup_case close-wrong-inherited-path
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  foreign_receipt="$HERDR_RECEIPT_ROOT/foreign/worker.event"
  mkdir -p "$(dirname -- "$foreign_receipt")"
  printf '%s\n' foreign-sentinel > "$foreign_receipt"
  output=$(HERDR_WORKSPACE_ID=foreign \
    HERDR_MONITOR_RECEIPT="$foreign_receipt" \
    bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "agent-bound close rejected valid registry"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "wrong inherited path diverted registered tab close"
  assert_file_absent "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "wrong inherited path retained valid registry"
  assert_eq foreign-sentinel "$(< "$foreign_receipt")" \
    "wrong inherited receipt was modified"
  output=$(HERDR_WORKSPACE_ID=foreign \
    HERDR_MONITOR_RECEIPT="$foreign_receipt" \
    bash "$orchestrator_script" close worker)
  [[ "$output" == *'"already_closed":true'* ]] ||
    fail "wrong inherited receipt diverted repeated close"
  assert_eq 1 "$(call_count 'tab close tab-1')" \
    "wrong inherited receipt repeated tab close count"
)

test_close_verifies_resource_disappearance() (
  setup_case close-sticky-tab
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  : > "$FAKE_HERDR_CASE/tab-close-sticky"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close trusted tab-close success without disappearance"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
    "sticky tab unexpectedly disappeared"
  assert_file_present "$FAKE_HERDR_CASE/monitor-1-alive" \
    "sticky monitor pane unexpectedly disappeared"
  assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "sticky close removed registry"
  assert_eq open "$(receipt_read_field 9)" \
    "sticky close wrote tombstone"
)

test_close_transient_probe_is_fail_closed() (
  setup_case close-transient-tab-probe
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  printf '%s\n' 2 > "$FAKE_HERDR_CASE/tab-get-fail-at"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close treated an unreadable tab state as absence"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
    "transient tab probe closed tab"
  assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "transient tab probe removed registry"
  assert_eq open "$(receipt_read_field 9)" \
    "transient tab probe wrote tombstone"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "close did not recover after transient tab probe"
)

test_close_generation_binding() (
  setup_case close-followup-generation
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  original_generation=$(receipt_read_field 10)
  write_current_completion_proof
  followup_prompt="$FAKE_HERDR_CASE/followup.txt"
  printf '%s\n' "followup before close" > "$followup_prompt"
  export FAKE_HERDR_APPEND_USER=1
  bash "$orchestrator_script" followup worker \
    --prompt-file "$followup_prompt" >/dev/null
  followup_generation=$(receipt_read_field 10)
  [[ "$followup_generation" != "$original_generation" ]] ||
    fail "followup did not create a new lifecycle generation"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.proof.${original_generation}" "explicit followup invalidates old proof"
  assert_eq "$followup_generation" \
    "$(jq -r '.generation' "$HERDR_RECEIPT_ROOT/ws/worker.json")" \
    "followup registry generation"
  append_task_complete
  write_current_completion_proof
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  run_hook settled "$(payload)"
  output=$(bash "$orchestrator_script" close worker)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "proven followup lifecycle could not close"

  setup_case close-generation-mismatch
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry worker ws different-generation
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "close accepted a mismatched lifecycle generation"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
    "generation mismatch closed tab"
  assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" \
    "generation mismatch removed registry"
  assert_eq 0 "$(call_count 'tab close tab-1')" \
    "generation mismatch tab close count"
  assert_eq open "$(receipt_read_field 9)" \
    "generation mismatch wrote tombstone"
)

test_lock_parallelism_and_subshell_identity() (
  setup_case lock-parallel
  receipt="$HERDR_MONITOR_RECEIPT"
  critical="$FAKE_HERDR_CASE/critical"
  violation="$FAKE_HERDR_CASE/violation"
  for _ in $(seq 1 32); do
    (
      # shellcheck source=herdr-receipt.sh
      source "$receipt_script"
      herdr_receipt_lock_acquire "$receipt" || exit 1
      if ! mkdir "$critical" 2>/dev/null; then
        : > "$violation"
      else
        sleep 0.02
        rmdir "$critical"
      fi
      herdr_receipt_lock_release
    ) &
  done
  wait
  assert_file_absent "$violation" "subshell mutual exclusion"
  assert_file_absent "${receipt}.lock" "parallel lock"
  if find "$(dirname -- "$receipt")" -name 'worker.event.lock.claim.*' \
    -print -quit | grep -q .; then
    fail "parallel claims remained"
  fi
)

test_lock_reaping_and_exact_identity() (
  setup_case lock-reaping
  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  receipt="$HERDR_MONITOR_RECEIPT"
  mkdir -p "$(dirname -- "$receipt")"
  live_pid=$$
  live_start=$(herdr_process_start "$live_pid")

  lock_forms=(
    "malformed"
    ""
    $'999999\tThu Jan  1 00:00:00 1970\tdead'
    "${live_pid}"$'\t'"wrong start"$'\t'"reused"
  )
  for lock_content in "${lock_forms[@]}"; do
    printf '%s\n' "$lock_content" > "${receipt}.lock"
    HERDR_RECEIPT_LOCK_ATTEMPTS=80 \
      herdr_receipt_lock_acquire "$receipt" ||
      fail "stale lock was not reaped: ${lock_content:-empty}"
    herdr_receipt_lock_release
  done

  printf '%s\n' malformed > "${receipt}.lock"
  chmod 000 "${receipt}.lock"
  HERDR_RECEIPT_LOCK_ATTEMPTS=80 \
    herdr_receipt_lock_acquire "$receipt" ||
    fail "unreadable lock was not reaped"
  herdr_receipt_lock_release

  printf '%s\t%s\t%s\n' "$live_pid" "$live_start" live > "${receipt}.lock"
  live_inode=$(herdr_path_inode "${receipt}.lock")
  if HERDR_RECEIPT_LOCK_ATTEMPTS=20 \
    herdr_receipt_lock_acquire "$receipt"; then
    fail "live lock was reaped"
  fi
  assert_eq "$live_inode" "$(herdr_path_inode "${receipt}.lock")" \
    "live lock identity"
  rm -f "${receipt}.lock"

  printf '%s\n' old > "${receipt}.lock"
  old_inode=$(herdr_path_inode "${receipt}.lock")
  rm -f "${receipt}.lock"
  printf '%s\n' new > "${receipt}.lock"
  new_inode=$(herdr_path_inode "${receipt}.lock")
  herdr_remove_exact_file "${receipt}.lock" "$old_inode"
  assert_eq "$new_inode" "$(herdr_path_inode "${receipt}.lock")" \
    "replacement lock survived stale reap"
  rm -f "${receipt}.lock"
)

test_sigkill_lock_and_claim_cleanup() (
  setup_case sigkill-lock
  receipt="$HERDR_MONITOR_RECEIPT"
  acquired="$FAKE_HERDR_CASE/acquired"
  bash -c '
    set -euo pipefail
    source "$1"
    herdr_receipt_lock_acquire "$2"
    : > "$3"
    sleep 30
  ' bash "$receipt_script" "$receipt" "$acquired" &
  holder_pid=$!
  wait_for_file "$acquired" || fail "SIGKILL holder did not acquire"
  kill -9 "$holder_pid"
  wait "$holder_pid" 2>/dev/null || true

  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  HERDR_RECEIPT_LOCK_ATTEMPTS=100 \
    herdr_receipt_lock_acquire "$receipt" ||
    fail "SIGKILL lock was not reaped"
  herdr_receipt_lock_release
  assert_file_absent "${receipt}.lock" "SIGKILL lock cleanup"
  if find "$(dirname -- "$receipt")" -name 'worker.event.lock.claim.*' \
    -print -quit | grep -q .; then
    fail "SIGKILL claim remained"
  fi

  block_bin="$FAKE_HERDR_CASE/block-bin"
  claim_ready="$FAKE_HERDR_CASE/claim-ready"
  mkdir -p "$block_bin"
  cat > "$block_bin/ln" <<EOF
#!/bin/bash
printf '%s\n' "\$\$" > "$claim_ready"
sleep 30
exec /bin/ln "\$@"
EOF
  chmod +x "$block_bin/ln"
  PATH="$block_bin:$PATH" bash -c '
    set -euo pipefail
    source "$1"
    herdr_receipt_lock_acquire "$2"
  ' bash "$receipt_script" "$receipt" &
  claimant_pid=$!
  wait_for_file "$claim_ready" || fail "claim SIGKILL fixture did not start"
  claimant_ln_pid=$(< "$claim_ready")
  kill -9 "$claimant_pid"
  kill -9 "$claimant_ln_pid" 2>/dev/null || true
  wait "$claimant_pid" 2>/dev/null || true
  sleep 0.2
  if ! find "$(dirname -- "$receipt")" -name 'worker.event.lock.claim.*' \
    -print -quit | grep -q .; then
    fail "claim SIGKILL did not leave the intended orphan"
  fi
  HERDR_RECEIPT_LOCK_ATTEMPTS=100 \
    herdr_receipt_lock_acquire "$receipt" ||
    fail "orphan claim blocked the next acquisition"
  herdr_receipt_lock_release
  if find "$(dirname -- "$receipt")" -name 'worker.event.lock.claim.*' \
    -print -quit | grep -q .; then
    fail "orphan claim was not cleaned"
  fi
)

test_lock_timeout_machine_result() (
  setup_case lock-timeout
  write_complete_transcript
  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  lock_pid=$$
  lock_start=$(herdr_process_start "$lock_pid")
  printf '%s\t%s\t%s\n' "$lock_pid" "$lock_start" live \
    > "${HERDR_MONITOR_RECEIPT}.lock"
  result_file="$TMPDIR/lock.result"
  HERDR_RECEIPT_LOCK_ATTEMPTS=20 HERDR_MONITOR_RESULT_FILE="$result_file" \
    run_hook settled "$(payload)"
  assert_eq error "$(cut -f 1 "$result_file")" "lock timeout outcome"
  assert_eq lock-timeout "$(cut -f 2 "$result_file")" "lock timeout reason"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "lock timeout delivery"
  rm -f "${HERDR_MONITOR_RECEIPT}.lock"
)

test_delivery_failure_waits_for_transition() (
  setup_case delivery-transition
  write_complete_transcript
  printf '%s\n' 3 > "$FAKE_HERDR_CASE/prompt-failures"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  for _ in $(seq 1 500); do
    (( $(call_count 'agent wait orch') >= 1 )) && break
    sleep 0.02
  done
  (( $(call_count 'agent wait orch') >= 1 )) ||
    fail "orchestrator transition wait did not start"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "delivery before state transition"
  printf '%s\n' working > "$FAKE_HERDR_CASE/orchestrator-status"
  for _ in $(seq 1 500); do
    [[ "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" == "1" ]] && break
    sleep 0.02
  done
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "delivery after orchestrator transition"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "delivery transition cleanup"
)

test_hot_loop_negative_probe() (
  setup_case hot-loop
  write_complete_transcript
  printf '%s\n' 999 > "$FAKE_HERDR_CASE/prompt-failures"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 4
  total_calls=$(wc -l < "$FAKE_HERDR_CASE/calls" | awk '{$1=$1; print}')
  (( total_calls <= 25 )) ||
    fail "hot-loop upper bound exceeded: $total_calls calls in 4 seconds"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "hot-loop cleanup"
  if find "$TMPDIR" -name 'herdr-monitor-*' -print -quit | grep -q .; then
    fail "monitor temporary file remained after signal"
  fi

  setup_case suppressed-loop
  write_complete_transcript
  append_user_message
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 4
  total_calls=$(wc -l < "$FAKE_HERDR_CASE/calls" | awk '{$1=$1; print}')
  (( total_calls <= 12 )) ||
    fail "suppression hot-loop bound exceeded: $total_calls calls in 4 seconds"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "suppression cleanup"

  setup_case lock-timeout-loop
  write_complete_transcript
  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  lock_pid=$$
  lock_start=$(herdr_process_start "$lock_pid")
  printf '%s\t%s\t%s\n' "$lock_pid" "$lock_start" live \
    > "${HERDR_MONITOR_RECEIPT}.lock"
  HERDR_RECEIPT_LOCK_ATTEMPTS=20 HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 4
  total_calls=$(wc -l < "$FAKE_HERDR_CASE/calls" | awk '{$1=$1; print}')
  (( total_calls <= 12 )) ||
    fail "lock-timeout hot-loop bound exceeded: $total_calls calls in 4 seconds"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  rm -f "${HERDR_MONITOR_RECEIPT}.lock"
  assert_no_fake_waiters "lock-timeout cleanup"

  setup_case missing-receipt-loop
  empty_hook="$FAKE_HERDR_CASE/empty-hook.sh"
  cat > "$empty_hook" <<'EOF'
#!/bin/bash
exit 0
EOF
  chmod +x "$empty_hook"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$empty_hook" &
  monitor_pid=$!
  sleep 4
  total_calls=$(wc -l < "$FAKE_HERDR_CASE/calls" | awk '{$1=$1; print}')
  (( total_calls <= 8 )) ||
    fail "missing-receipt hot-loop bound exceeded: $total_calls calls in 4 seconds"
  assert_file_absent "$HERDR_MONITOR_RECEIPT" "missing receipt probe"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "missing-receipt cleanup"
)

test_same_name_restart_and_new_cycle() (
  setup_case same-name
  write_complete_transcript
  remove_current_completion_proof
  rm -f "$HERDR_MONITOR_RECEIPT"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "first" > "$worker_prompt"
  bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null
  assert_eq 1 "$(receipt_read_field 2)" "first worker cycle"

  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "second" > "$worker_prompt"
  bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null
  assert_eq 2 "$(receipt_read_field 2)" "same-name restart cycle"
  assert_eq armed "$(receipt_read_field 4)" "same-name restart armed"
)

test_structural_completion_proof_for_all_agents() (
  for kind in claude codex; do
    setup_case "completion-$kind"
    printf '%s\n' "$kind" > "$FAKE_HERDR_CASE/kind"
    if [[ "$kind" == "claude" ]]; then
      transcript=$(write_claude_transcript)
    else
      transcript=$(write_codex_transcript)
    fi
    arm_completion_generation
    remove_current_completion_proof
    result_file="$TMPDIR/no-proof.result"
    HERDR_MONITOR_RESULT_FILE="$result_file" \
      run_hook settled "$(payload_with_path "$transcript")"
    assert_eq suppressed "$(cut -f 1 "$result_file")" \
      "$kind intermediate outcome"
    assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
      "$kind intermediate reason"
    assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
      "$kind intermediate delivery"
    if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
      fail "$kind close accepted an unproven completion"
    fi

    write_current_completion_proof
    HERDR_MONITOR_RESULT_FILE="$result_file" \
      run_hook settled "$(payload_with_path "$transcript")"
    assert_eq delivered "$(cut -f 1 "$result_file")" \
      "$kind proven outcome"
    assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
      "$kind proven delivery"
    HERDR_MONITOR_RESULT_FILE="$result_file" \
      run_hook settled "$(payload_with_path "$transcript")"
    assert_eq suppressed "$(cut -f 1 "$result_file")" \
      "$kind duplicate outcome"
    assert_eq duplicate-settled "$(cut -f 2 "$result_file")" \
      "$kind duplicate reason"
    assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
      "$kind duplicate delivery"
  done

  setup_case missing-session
  write_complete_transcript
  printf '%s\n' __empty__ > "$FAKE_HERDR_CASE/session"
  result_file="$TMPDIR/missing-session.result"
  HERDR_MONITOR_RESULT_FILE="$result_file" run_hook settled "$(payload)"
  assert_eq suppressed "$(cut -f 1 "$result_file")" \
    "missing session outcome"
  assert_eq no-completion-proof "$(cut -f 2 "$result_file")" \
    "missing session reason"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "missing session delivery"
)

test_no_completion_proof_preserves_generation() (
  setup_case proof-monitor
  printf '%s\n' claude > "$FAKE_HERDR_CASE/kind"
  write_claude_transcript >/dev/null
  arm_completion_generation stable-generation
  remove_current_completion_proof
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  for _ in $(seq 1 200); do
    [[ "$(receipt_read_field 11 2>/dev/null || true)" == "no-completion-proof" ]] &&
      break
    sleep 0.02
  done
  assert_eq no-completion-proof "$(receipt_read_field 11)" \
    "monitor intermediate suppression"
  assert_eq stable-generation "$(receipt_read_field 10)" \
    "suppressed generation"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 500); do
    (( $(call_count 'agent wait worker') >= 2 )) && break
    sleep 0.02
  done
  (( $(call_count 'agent wait worker') >= 2 )) ||
    fail "monitor did not establish the post-idle event wait"
  write_current_completion_proof
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 500); do
    [[ "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" == "1" ]] && break
    sleep 0.02
  done
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "proven completion after intermediate stop"
  assert_eq stable-generation "$(receipt_read_field 10)" \
    "completion generation after intermediate stop"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "proof monitor cleanup"
)

test_prompt_delivery_for_all_agent_kinds() (
  for kind in copilot claude codex; do
    setup_case "prompt-$kind"
    printf '%s\n' stalled-visible > "$FAKE_HERDR_CASE/worker-prompt-mode"
    worker_prompt="$FAKE_HERDR_CASE/worker.txt"
    printf '%s\n' "prompt for $kind" > "$worker_prompt"
    worker_output=$(bash "$worker_script" \
      --name worker \
      --kind "$kind" \
      --cwd "$FAKE_HERDR_CASE" \
      --prompt-file "$worker_prompt" \
      --workspace ws \
      --orchestrator-agent orch)
    expected_mode=auto
    expected_verified=false
    case "$kind" in copilot) expected_mode=autopilot ;; codex) expected_mode=approve-for-me ;; claude) expected_verified=true ;; esac
    assert_eq "$expected_mode" "$(jq -r '.permission_mode' <<< "$worker_output")" "$kind reported launch mode"
    assert_eq "$expected_verified" "$(jq -r '.permission_mode_verified' <<< "$worker_output")" "$kind honest runtime verification"
    assert_eq 1 "$(call_count 'agent send-keys worker enter')" \
      "$kind explicit Enter count"
    assert_eq 0 "$(call_count 'pane wait-output pane-1')" \
      "$kind has no prompt-glyph dependency"
    assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
      "$kind successful worker tab"
    assert_file_present "$FAKE_HERDR_CASE/monitor-command" \
      "$kind successful monitor"
  done

  setup_case prompt-slow-start
  printf '%s\n' slow-start > "$FAKE_HERDR_CASE/worker-prompt-mode"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "slow start" > "$worker_prompt"
  bash "$worker_script" \
    --name worker \
    --kind claude \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null
  assert_eq 0 "$(call_count 'agent send-keys worker enter')" \
    "slow start received no blind Enter"

  for failure_mode in stalled-hidden blocked; do
    setup_case "prompt-failure-$failure_mode"
    printf '%s\n' "$failure_mode" > "$FAKE_HERDR_CASE/worker-prompt-mode"
    worker_prompt="$FAKE_HERDR_CASE/worker.txt"
    printf '%s\n' "must roll back" > "$worker_prompt"
    if bash "$worker_script" \
      --name worker \
      --kind claude \
      --cwd "$FAKE_HERDR_CASE" \
      --prompt-file "$worker_prompt" \
      --workspace ws \
      --orchestrator-agent orch >/dev/null 2>&1; then
      fail "$failure_mode prompt unexpectedly succeeded"
    fi
    assert_file_present "$FAKE_HERDR_CASE/tab-alive" \
      "$failure_mode uncertain prompt preserves work"
    assert_eq 0 "$(call_count 'tab close tab-1')" \
      "$failure_mode tab close count"
    assert_file_present "$FAKE_HERDR_CASE/monitor-command" \
      "$failure_mode retained monitor"
    assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" \
      "$failure_mode retained ownership"
  done
)

test_event_bounded_pane_readiness() (
  setup_case pane-readiness
  printf '%s\n' 0.20 > "$FAKE_HERDR_CASE/pane-ready-delay"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "wait for shell" > "$worker_prompt"
  bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null
  assert_eq 0 "$(call_count 'pane wait-output pane-1')" \
    "native readiness without prompt-glyph guessing"
  assert_eq 1 "$(call_count 'agent start worker')" \
    "start after delayed readiness"

  setup_case pane-retries
  printf '%s\n' 2 > "$FAKE_HERDR_CASE/start-busy-count"
  printf '%s\n' 0.05 > "$FAKE_HERDR_CASE/pane-ready-delay"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "retry after event" > "$worker_prompt"
  bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null
  assert_eq 0 "$(call_count 'pane wait-output pane-1')" \
    "native readiness owns retries"
  assert_eq 3 "$(call_count 'agent start worker')" \
    "preserved start attempt count"

  setup_case pane-failure
  export HERDR_START_READY_TIMEOUT_SECONDS=1
  : > "$FAKE_HERDR_CASE/pane-wait-fail"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "never start" > "$worker_prompt"
  if bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null 2>&1; then
    fail "worker started without pane readiness"
  fi
  (( $(call_count 'agent start worker') > 0 )) || fail "missing native availability probe"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "pane readiness rollback"

  setup_case start-retry-failure
  printf '%s\n' 100 > "$FAKE_HERDR_CASE/start-busy-count"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "never registers" > "$worker_prompt"
  if bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null 2>&1; then
    fail "worker succeeded with a permanently busy pane"
  fi
  (( $(call_count 'agent start worker') <= 8 )) || fail "unbounded startup retries"
  assert_eq 0 "$(call_count 'pane wait-output pane-1')" \
    "failed native start has no glyph wait"
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" \
    "failed start rollback"
  assert_file_absent "$FAKE_HERDR_CASE/monitor-command" \
    "failed start unregistered monitor"
)

test_transient_process_identity_is_fail_closed() (
  setup_case transient-identity
  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  receipt="$HERDR_MONITOR_RECEIPT"
  mkdir -p "$(dirname -- "$receipt")"
  sleep 30 &
  live_pid=$!
  live_start=$(herdr_process_start "$live_pid")
  printf '%s\t%s\t%s\n' "$live_pid" "$live_start" live > "${receipt}.lock"
  live_inode=$(herdr_path_inode "${receipt}.lock")
  printf '%s\n' "$live_pid" > "$FAKE_HERDR_CASE/ps-fail-pid"
  printf '%s\n' 100 > "$FAKE_HERDR_CASE/ps-fail-count"
  if HERDR_RECEIPT_LOCK_ATTEMPTS=12 \
    herdr_receipt_lock_acquire "$receipt"; then
    fail "transient ps failure reaped a live lock"
  fi
  assert_eq "$live_inode" "$(herdr_path_inode "${receipt}.lock")" \
    "live lock after transient ps failure"

  claim="${receipt}.lock.claim.live"
  printf '%s\t%s\t%s\n' "$live_pid" "$live_start" live > "$claim"
  printf '%s\n' 10 > "$FAKE_HERDR_CASE/ps-fail-count"
  herdr_cleanup_orphan_claims "${receipt}.lock"
  assert_file_present "$claim" "live claim after transient ps failure"

  rm -f "${receipt}.lock" "$claim"
  kill "$live_pid"
  wait "$live_pid" 2>/dev/null || true
)

test_lock_lease_parent_identity_is_fail_closed() (
  setup_case transient-lease-parent
  receipt="$HERDR_MONITOR_RECEIPT"
  start_holder="$FAKE_HERDR_CASE/start-holder"
  holder_acquired="$FAKE_HERDR_CASE/holder-acquired"
  holder_release="$FAKE_HERDR_CASE/release-holder"
  bash -c '
    set -euo pipefail
    source "$1"
    while [[ ! -e "$3" ]]; do sleep 0.01; done
    herdr_receipt_lock_acquire "$2"
    : > "$4"
    while [[ ! -e "$5" ]]; do sleep 0.01; done
    herdr_receipt_lock_release
  ' bash "$receipt_script" "$receipt" "$start_holder" "$holder_acquired" \
    "$holder_release" &
  holder_pid=$!
  printf '%s\n' "$holder_pid" > "$FAKE_HERDR_CASE/ps-fail-pid"
  printf '%s\n' 100 > "$FAKE_HERDR_CASE/ps-fail-count"
  : > "$start_holder"
  wait_for_file "$holder_acquired" ||
    fail "holder did not acquire with transient parent ps failure"

  # shellcheck source=herdr-receipt.sh
  source "$receipt_script"
  if HERDR_RECEIPT_LOCK_ATTEMPTS=20 \
    herdr_receipt_lock_acquire "$receipt"; then
    fail "contender acquired while fail-closed lease holder was active"
  fi
  : > "$holder_release"
  wait "$holder_pid"
  HERDR_RECEIPT_LOCK_ATTEMPTS=100 \
    herdr_receipt_lock_acquire "$receipt" ||
    fail "lock was not available after holder release"
  herdr_receipt_lock_release
  assert_file_absent "${receipt}.lock" "transient lease lock cleanup"
)

test_receipt_override_is_agent_bound() (
  setup_case receipt-agent-binding
  worker_receipt="$HERDR_MONITOR_RECEIPT"
  mkdir -p "$(dirname -- "$worker_receipt")"
  printf '%s\n' worker-sentinel > "$worker_receipt"
  other_receipt="$HERDR_RECEIPT_ROOT/ws/other.event"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    herdr-receipt/3 1 settled delivered generation:other \
    settled generation:other generation:other open other delivered \
    > "$other_receipt"
  write_worker_registry other ws other
  output=$(bash "$orchestrator_script" close other)
  [[ "$output" == *'"closed":true'* ]] ||
    fail "close other did not report success"
  assert_eq worker-sentinel "$(< "$worker_receipt")" \
    "worker receipt after close other"
  assert_eq closed "$(cut -f 9 "$other_receipt")" \
    "other receipt tombstone"
  assert_eq other "$(cut -f 10 "$other_receipt")" \
    "other receipt generation"
  assert_eq close "$(cut -f 11 "$other_receipt")" \
    "other receipt close reason"
)

test_monitor_rearm_across_idle_and_fast_completion() (
  setup_case monitor-rearm-idle
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.proof.generation-one" "settlement consumed proof file"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 0.5
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  sleep 0.5
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 100); do
    [[ "$(receipt_read_field 2)" == "2" ]] && break
    sleep 0.02
  done
  assert_eq 2 "$(receipt_read_field 2)" "done-idle-working rearm"
  assert_eq generation:generation-one "$(receipt_read_field 8)" "same task retains delivered completion"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 250); do
    (( $(call_count '^agent wait worker') >= 4 )) && break
    sleep 0.02
  done
  assert_eq generation:generation-one "$(receipt_read_field 8)" "working-idle retains consumed proof evidence"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "idle rearm cleanup"
  bash "$orchestrator_script" close worker >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "completion remains usable for normal close"

  setup_case monitor-fast-completion
  write_complete_transcript
  run_hook settled "$(payload)"
  HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" \
      worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 0.5
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 100); do
    [[ "$(receipt_read_field 2)" == "2" ]] && break
    sleep 0.02
  done
  assert_eq 2 "$(receipt_read_field 2)" "fast completion rearm"
  # Only an explicit assignment change, never native readiness, resets proof.
  source "$receipt_script"
  herdr_receipt_rearm "$HERDR_MONITOR_RECEIPT" followup generation-two
  assert_eq "" "$(receipt_read_field 8)" "explicit assignment clears prior completion"
  write_current_completion_proof
  append_user_message
  append_task_complete
  printf '%s\n' done > "$FAKE_HERDR_CASE/status"
  run_hook settled "$(payload)"
  for _ in $(seq 1 100); do
    [[ "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" == "2" ]] && break
    sleep 0.02
  done
  assert_eq 2 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "fast completion across rearm"
  sleep 0.5
  assert_eq 2 "$(file_value "$FAKE_HERDR_CASE/prompt-successes")" \
    "fast completion duplicate guard"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "fast completion cleanup"
)

test_monitor_rearm_unknown_and_failure_are_not_new_assignments() (
  for variant in blank corrupt; do
    setup_case "monitor-rearm-$variant"
    arm_completion_generation assignment-one
    remove_current_completion_proof
    if [[ "$variant" == blank ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        herdr-receipt/3 1 input delivered input input input "" open "" legacy > "$HERDR_MONITOR_RECEIPT"
    fi
    printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
    HERDR_MONITOR_INBOX=1 HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
      bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$TMPDIR/monitor-output" 2> "$TMPDIR/monitor-error" &
    monitor_pid=$!
    for _ in $(seq 1 250); do
      (( $(call_count '^agent wait worker') >= 1 )) && break
      sleep 0.02
    done
    (( $(call_count '^agent wait worker') >= 1 )) || fail "$variant blocked boundary not captured"
    [[ "$variant" != corrupt ]] || printf '%s\n' corrupt > "$HERDR_MONITOR_RECEIPT"
    printf '%s\n' working > "$FAKE_HERDR_CASE/status"
    if [[ "$variant" == corrupt ]]; then
      wait_for_file "${HERDR_MONITOR_RECEIPT}.monitor-error" || fail "rearm failure was hidden"
      if wait "$monitor_pid"; then fail "failed rearm reported successful monitor exit"; fi
      assert_eq assignment-one "$(cut -f 1 "${HERDR_MONITOR_RECEIPT}.monitor-error")" "failure retains known assignment"
      rg -q 'Lifecycle receipt rearm failed' "$TMPDIR/monitor-error" || fail "missing rearm diagnostic"
      assert_eq corrupt "$(< "$HERDR_MONITOR_RECEIPT")" "failed rearm did not invent a receipt"
    else
      for _ in $(seq 1 250); do
        (( $(call_count '^agent wait worker') >= 2 )) && break
        sleep 0.02
      done
      (( $(call_count '^agent wait worker') >= 2 )) || fail "legacy monitor never resumed waiting"
      assert_eq "" "$(receipt_read_field 10)" "native resume cannot invent legacy assignment"
      assert_eq 1 "$(receipt_read_field 2)" "unowned legacy cycle not rearmed"
      kill "$monitor_pid" 2>/dev/null || true
      wait "$monitor_pid" 2>/dev/null || true
    fi
    assert_no_fake_waiters "$variant rearm cleanup"
  done
)

test_blocked_working_cycle_preserves_assignment_and_proof() (
  setup_case blocked-working-generation
  arm_completion_generation assignment-one
  write_worker_registry worker ws assignment-one
  printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
  HERDR_MONITOR_INBOX=1 HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$TMPDIR/monitor-output" &
  monitor_pid=$!
  wait_for_file "${HERDR_MONITOR_RECEIPT}.inbox" || fail "blocked input was not collected"
  # Wait until the monitor has remembered the boundary, then resume this task.
  for _ in $(seq 1 250); do
    (( $(call_count '^agent wait worker') >= 1 )) && break
    sleep 0.02
  done
  (( $(call_count '^agent wait worker') >= 1 )) || fail "blocked wait never armed"
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  for _ in $(seq 1 250); do
    [[ "$(receipt_read_field 2)" == 2 ]] && break
    sleep 0.02
  done
  assert_eq 2 "$(receipt_read_field 2)" "native resume starts status cycle"
  assert_eq assignment-one "$(receipt_read_field 10)" "native resume preserves assignment generation"
  assert_eq assignment-one "$(jq -r '.generation' "$HERDR_RECEIPT_ROOT/ws/worker.json")" "registry still agrees"
  assert_file_present "${HERDR_MONITOR_RECEIPT}.proof.assignment-one" "native resume retains concurrent completion proof"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "blocked-working cleanup"
  run_file="$FAKE_HERDR_CASE/run.json"
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" \
    '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"cancelling",cancellation:{from:{name:"worker",pane:"pane-1",tab:"tab-1",generation:"assignment-one",session:"session-1",receipt:$receipt},evidence:"User authorizes interruption; partial state preserved",output:"Saved assignment checkpoint"}}]}' > "$run_file"
  HERDR_AXI_MANAGED_TASK=1 bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "resumed assignment remains cancellable"
)

test_worker_prompt_failure_is_not_success() (
  setup_case worker-prompt-failure
  write_complete_transcript
  : > "$FAKE_HERDR_CASE/worker-prompt-fail"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "must fail" > "$worker_prompt"
  if bash "$worker_script" \
    --name worker \
    --kind copilot \
    --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" \
    --workspace ws \
    --orchestrator-agent orch >/dev/null 2>&1; then
    fail "worker reported success after prompt failure"
  fi
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" \
    "failed worker prompt count"
)

test_signal_cleanup_fixture() (
  setup_case signal-cleanup
  signals=(HUP TERM HUP TERM TERM HUP TERM)
  delays=(0.05 0.10 0.15 0.20 0.25 0.30 0.35)
  for index in $(seq 0 6); do
    ready="$FAKE_HERDR_CASE/fixture-$index.ready"
    TMPDIR="$TMPDIR" bash "$test_script" --signal-fixture "$ready" &
    fixture_pid=$!
    wait_for_file "$ready" || fail "signal fixture $index did not start"
    fixture_root=$(< "$ready")
    assert_file_present "$fixture_root" "signal fixture $index root"
    sleep "${delays[$index]}"
    kill -"${signals[$index]}" "$fixture_pid"
    wait "$fixture_pid" 2>/dev/null || true
    assert_file_absent "$fixture_root" "signal fixture $index cleanup"
  done
)

test_monitor_survives_quiet_intervals() (
  for status in working idle unknown; do
    setup_case "quiet-$status"
    printf '%s\n' "$status" > "$FAKE_HERDR_CASE/status"
    HERDR_MONITOR_CHANGE_WAIT_TICKS=2 \
      bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
    monitor_pid=$!
    sleep 1.5
    kill -0 "$monitor_pid" 2>/dev/null || fail "$status monitor exited on a quiet interval"
    kill "$monitor_pid" 2>/dev/null || true
    wait "$monitor_pid" 2>/dev/null || true
    assert_no_fake_waiters "quiet $status cleanup"
  done
)

test_monitor_separates_readiness_completion_and_acceptance() (
  setup_case monitor-display
  write_complete_transcript
  HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
  run_file="$FAKE_HERDR_CASE/run.json"
  printf '%s\n' 'unreadable coordinator JSON must not erase local proof' > "$run_file"
  task_file="${HERDR_MONITOR_RECEIPT%.event}.task"
  generation=$(receipt_read_field 10)
  printf 'herdr-task/1\trunning\t%s\n' "$generation" > "$task_file"
  display_log="$FAKE_HERDR_CASE/display"
  HERDR_MONITOR_INBOX=1 HERDR_MONITOR_CHANGE_WAIT_TICKS=100 \
    bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$display_log" &
  monitor_pid=$!
  trap 'kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true' EXIT
  expect_display() {
    local expected attempt lines=4
    expected=$(printf 'agent: %s\ntask: %s\nproof: %s' "$1" "$2" "$3")
    if [[ -n "${4:-}" ]]; then expected+=$'\ncoordinator: unavailable'; lines=5; fi
    for attempt in $(seq 1 500); do
      [[ "$(tail -n "$lines" "$display_log")" != "$expected" ]] || return 0
      sleep 0.02
    done
    fail "missing monitor display: $expected; got $(tail -n 4 "$display_log")"
  }
  expect_display done review complete
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  expect_display idle review complete
  printf '%s\n' 'partial hint' > "$task_file"
  expect_display idle review complete unavailable
  # Coordinator-only changes must refresh without another agent transition.
  printf 'herdr-task/1\taccepted\t%s\n' "$generation" > "$task_file"
  expect_display idle accepted complete
  printf 'herdr-task/1\tswitching\t%s\n' "$generation" > "$task_file"
  expect_display idle switching pending
  # Reusing a pane must not label the old generation's receipt as new proof.
  printf 'herdr-task/1\tstarting\t%s\n' "$generation" > "$task_file"
  expect_display idle starting pending
  printf 'herdr-task/1\trunning\tnext-generation\n' > "$task_file"
  expect_display idle awaiting-proof pending
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  expect_display working running pending
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  trap - EXIT
  assert_no_fake_waiters "monitor display cleanup"
)

test_failed_native_waits_back_off_and_lost_terminates() (
  setup_case failed-native-waits
  write_complete_transcript
  printf '%s\n' 999 > "$FAKE_HERDR_CASE/prompt-failures"
  : > "$FAKE_HERDR_CASE/release-waits"
  bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  sleep 5
  kill -0 "$monitor_pid" 2>/dev/null || fail "failed wait ended supervision"
  attempts=$(file_value "$FAKE_HERDR_CASE/prompt-attempts")
  (( attempts > 0 && attempts <= 9 )) || fail "failed waits caused a hot loop: $attempts prompt attempts"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "failed wait cleanup"

  setup_case lost-with-hook-failure
  : > "$FAKE_HERDR_CASE/agent-get-fail"
  empty_hook="$FAKE_HERDR_CASE/empty-hook.sh"
  printf '%s\n' '#!/bin/bash' 'echo attempt >> "$FAKE_HERDR_CASE/lost-attempts"' 'exit 0' > "$empty_hook"
  bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$empty_hook" &
  monitor_pid=$!
  for _ in $(seq 1 400); do
    kill -0 "$monitor_pid" 2>/dev/null || break
    sleep 0.02
  done
  if kill -0 "$monitor_pid" 2>/dev/null; then
    kill "$monitor_pid" 2>/dev/null || true
    wait "$monitor_pid" 2>/dev/null || true
    fail "lost notification retried forever"
  fi
  if wait "$monitor_pid"; then fail "permanent lost notification failure must not exit successfully"; fi
  assert_eq 3 "$(wc -l < "$FAKE_HERDR_CASE/lost-attempts" | tr -d ' ')" "lost delivery retry count"
  [[ -s "${HERDR_MONITOR_RECEIPT}.monitor-error" ]] || fail "lost failure must leave durable diagnostics"
  assert_eq 0 "$(call_count 'agent wait')" "lost worker must not wait for a transition"

  setup_case lost-transient-hook
  : > "$FAKE_HERDR_CASE/agent-get-fail"
  retry_hook="$FAKE_HERDR_CASE/retry-hook.sh"
  printf '%s\n' '#!/bin/bash' \
    'echo attempt >> "$FAKE_HERDR_CASE/lost-attempts"' \
    'if [[ $(wc -l < "$FAKE_HERDR_CASE/lost-attempts") -ge 3 ]]; then printf "delivered\tok\n" > "$HERDR_MONITOR_RESULT_FILE"; else printf "error\tlock-timeout\n" > "$HERDR_MONITOR_RESULT_FILE"; fi' > "$retry_hook"
  bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$retry_hook"
  assert_eq 3 "$(wc -l < "$FAKE_HERDR_CASE/lost-attempts" | tr -d ' ')" "transient lost delivery retried"
  assert_file_absent "${HERDR_MONITOR_RECEIPT}.monitor-error" "successful lost delivery"
)

test_backoff_grows_not_just_below_a_loose_attempt_ceiling() (
  setup_case exponential-backoff
  # Exercise the exact production function; accelerated sleep records requested
  # delays. A constant 1-second mutant fails even when attempts <= 9 still passes.
  eval "$(sed -n '/^backoff() {/,/^}/p' "$monitor_script")"
  sleep() { printf '%s\n' "$1" >> "$FAKE_HERDR_CASE/delays"; /bin/sleep 0.01; }
  retry_delay=1
  for _ in 1 2 3 4 5 6 7; do backoff; done
  assert_eq $'1\n2\n4\n8\n16\n30\n30' "$(< "$FAKE_HERDR_CASE/delays")" "exponential bounded backoff"
)

test_managed_inbox_never_prompts_owner() (
  setup_case managed-inbox
  write_complete_transcript
  HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "inbox owner interruptions"
  assert_file_present "${HERDR_MONITOR_RECEIPT}.inbox" "durable inbox"
  assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "inbox event"
  assert_eq "$(receipt_read_field 10)" "$(jq -r '.generation' "${HERDR_MONITOR_RECEIPT}.inbox")" "inbox generation"
  [[ "$(jq '.summary | length' "${HERDR_MONITOR_RECEIPT}.inbox")" -le 600 ]] || fail "unbounded inbox"
  assert_eq delivered "$(receipt_read_field 4)" "inbox receipt completion"
)

test_split_monitor_preserves_delivery_mode() (
  for mode in 1 0; do
    setup_case "split-monitor-mode-$mode"
    worker_prompt="$FAKE_HERDR_CASE/worker.txt"
    printf '%s\n' 'bounded read-only task' > "$worker_prompt"
    HERDR_MONITOR_INBOX="$mode" bash "$worker_script" --name worker --kind copilot \
      --cwd "$FAKE_HERDR_CASE" --prompt-file "$worker_prompt" \
      --workspace ws --orchestrator-agent orch >/dev/null
    monitor_command=$(< "$FAKE_HERDR_CASE/monitor-command")
    # Execute the actual generated command as a fresh split pane whose server
    # environment did not inherit the worker tab's custom variables.
    : > "$FAKE_HERDR_CASE/agent-get-fail"
    env -u HERDR_MONITOR_INBOX -u HERDR_RECEIPT_ROOT HERDR_WORKSPACE_ID=foreign \
      bash -c "${monitor_command#* }"
    if [[ "$mode" == 1 ]]; then
      assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "managed split owner interruptions"
      assert_file_present "${HERDR_MONITOR_RECEIPT}.inbox" "split durable inbox"
      assert_eq lost "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "split lost event"
    else
      assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "legacy split notification"
    fi
  done
)

test_prompt_ack_and_no_nested_agents() (
  setup_case prompt-ack
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded task" > "$worker_prompt"
  bash "$worker_script" --name worker --kind codex --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch --label 'Byte review · codex' >/dev/null
  assert_eq 'Byte review · codex' "$(< "$FAKE_HERDR_CASE/tab-label")" "readable tab label"
  rg -q -- '--env DISABLE_AUTO_UPDATE=true' "$FAKE_HERDR_CASE/calls" || fail "worker shell may consume startup command in update prompt"
  rg -q -- '--wait --until working --until blocked --until idle --until done --timeout 15000' "$FAKE_HERDR_CASE/calls" || fail "startup waits for settlement"
  rg -q 'Do not start subagents' "$FAKE_HERDR_CASE/visible" || fail "nested workers not prohibited"
  rg -q -- '--ratio 0.75' "$FAKE_HERDR_CASE/calls" || fail "worker layout not 75/25"
  rg -q 'concise TOON' "$FAKE_HERDR_CASE/visible" || fail "TOON contract missing"
  rg -q -- '--approve-for-me' "$FAKE_HERDR_CASE/calls" || fail "Codex review policy missing"
  if rg -q -- '--sandbox' "$FAKE_HERDR_CASE/calls"; then fail "incompatible Codex flags"; fi
  assert_file_present "$HERDR_RECEIPT_ROOT/ws/worker.json" "startup ownership registry"
)

test_idle_completion_is_collected() (
  setup_case idle-completion
  write_complete_transcript
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  HERDR_MONITOR_INBOX=1 HERDR_MONITOR_CHANGE_WAIT_TICKS=2 \
    bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" &
  monitor_pid=$!
  wait_for_file "${HERDR_MONITOR_RECEIPT}.inbox" || fail "idle completion was never collected"
  # Inbox publication precedes receipt acknowledgement. Wait for the actual
  # condition, not a sibling file (especially under concurrent test load).
  for _ in $(seq 1 250); do
    [[ "$(receipt_read_field 4)" == "delivered" ]] && break
    sleep 0.02
  done
  assert_eq delivered "$(receipt_read_field 4)" "idle completion receipt"
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "idle completion cleanup"
)

test_blocked_startup_resumes_owned_pane() (
  setup_case resume-startup
  : > "$FAKE_HERDR_CASE/start-blocked"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "resume this assignment" > "$worker_prompt"
  if bash "$worker_script" --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch >/dev/null 2>&1; then
    fail "blocked startup claimed success"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" "retained startup dialog"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "no prompt before startup approval"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  bash "$worker_script" --resume --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch >/dev/null
  assert_eq 1 "$(call_count 'tab create')" "resume reused tab"
  assert_eq 1 "$(call_count 'agent start worker')" "resume reused agent"
  assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "resume delivered once"
)

test_blocked_startup_hook_keeps_cancellable_generation() (
  setup_case startup-hook-cancel
  : > "$FAKE_HERDR_CASE/start-blocked"
  printf '%s\n' "$hook_script" > "$FAKE_HERDR_CASE/start-hook"
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded work" > "$worker_prompt"
  if bash "$worker_script" --name worker --kind copilot --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch >/dev/null 2>&1; then
    fail "blocked startup claimed success"
  fi
  generation=$(jq -r '.generation' "$HERDR_RECEIPT_ROOT/ws/worker.json")
  assert_eq "$generation" "$(receipt_read_field 10)" "native input retains startup generation"
  assert_eq "$generation" "$(jq -r '.generation' "${HERDR_MONITOR_RECEIPT}.inbox")" "input report bound to startup"
  assert_eq input "$(receipt_read_field 3)" "real startup hook ran"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "no task sent at trust dialog"
  run_file="$FAKE_HERDR_CASE/run.json"
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" --arg generation "$generation" \
    '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"cancelling",cancellation:{from:{name:"worker",pane:"pane-1",tab:"tab-1",generation:$generation,session:"session-1",receipt:$receipt},evidence:"Stop blocked startup; no task submitted",output:"Folder approval pending"}}]}' > "$run_file"
  HERDR_AXI_MANAGED_TASK=1 bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "whole blocked startup tab closed"
  assert_eq 1 "$(call_count '^tab close')" "one owned tab close"
  assert_eq cancelled "$(receipt_read_field 11)" "cancellation tombstone"
)

test_legacy_startup_cancel_repair_is_narrow() (
  for variant in blank drift settled monitor proof foreign; do
    setup_case "legacy-startup-$variant"
    mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      herdr-receipt/3 1 input delivered input input input "" open "" delivered > "$HERDR_MONITOR_RECEIPT"
    write_worker_registry worker ws testgen
    registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
    jq '.stage="created" | .monitor_pane=null' "$registry" > "$TMPDIR/registry"
    mv "$TMPDIR/registry" "$registry"
    rm -f "$FAKE_HERDR_CASE/monitor-1-alive"
    case "$variant" in
      drift) arm_completion_generation other; remove_current_completion_proof ;;
      settled) printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        herdr-receipt/3 1 settled delivered settled settled settled settled open "" delivered > "$HERDR_MONITOR_RECEIPT" ;;
      monitor) jq '.monitor_pane="monitor-1"' "$registry" > "$TMPDIR/registry"; mv "$TMPDIR/registry" "$registry"; : > "$FAKE_HERDR_CASE/monitor-1-alive" ;;
      proof) printf '%s\n' testgen > "${HERDR_MONITOR_RECEIPT}.proof.testgen" ;;
      foreign) : > "$FAKE_HERDR_CASE/extra-pane" ;;
    esac
    run_file="$FAKE_HERDR_CASE/run.json"
    jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" \
      '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"cancelling",cancellation:{from:{name:"worker",pane:"pane-1",tab:"tab-1",generation:"testgen",session:"session-1",receipt:$receipt},evidence:"User authorized stop at startup",output:"Startup dialog"}}]}' > "$run_file"
    if HERDR_AXI_MANAGED_TASK=1 bash "$orchestrator_script" close worker --cancel "$run_file" > "$TMPDIR/result" 2>&1; then
      [[ "$variant" == blank ]] || fail "legacy repair accepted $variant"
      assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "legacy startup retired"
      assert_eq testgen "$(receipt_read_field 10)" "legacy cancellation bound generation"
    else
      [[ "$variant" != blank ]] || fail "legacy startup refused: $(< "$TMPDIR/result")"
      assert_eq 0 "$(call_count '^tab close')" "$variant never closes"
      assert_file_present "$FAKE_HERDR_CASE/tab-alive" "$variant remains inspectable"
    fi
  done
)

test_claude_startup_requires_verified_auto_mode() (
  setup_case claude-unsupported-model
  worker_prompt="$FAKE_HERDR_CASE/worker.txt"
  printf '%s\n' "bounded implementation" > "$worker_prompt"
  if bash "$worker_script" --name worker --kind claude --model haiku --cwd "$FAKE_HERDR_CASE" \
    --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/result" 2>&1; then
    fail "unsupported manual-fallback model accepted"
  fi
  assert_eq 0 "$(call_count '^tab create')" "invalid model rejected before allocation"
  rg -q AUTO_MODE_UNSUPPORTED "$TMPDIR/result" || fail "missing model policy error"
  for mode in auto slow-auto manual unknown delayed-auto delayed-manual slow-manual; do
    setup_case "claude-mode-$mode"
    printf '%s\n' claude > "$FAKE_HERDR_CASE/kind"
    case "$mode" in
      manual|delayed-manual|slow-manual) printf '%s\n' '❯' '⏵⏵ accept edits on (shift+tab to cycle)' > "$FAKE_HERDR_CASE/startup-screen" ;;
      unknown) printf '%s\n' 'Starting Claude...' > "$FAKE_HERDR_CASE/startup-screen" ;;
    esac
    [[ "$mode" != delayed-* ]] || : > "$FAKE_HERDR_CASE/delayed-footer"
    [[ "$mode" != slow-* ]] || printf '%s\n' 4 > "$FAKE_HERDR_CASE/delayed-footer"
    worker_prompt="$FAKE_HERDR_CASE/worker.txt"
    printf '%s\n' "bounded implementation" > "$worker_prompt"
    if bash "$worker_script" --name worker --kind claude --cwd "$FAKE_HERDR_CASE" \
      --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/result" 2>&1; then
      [[ "$mode" == auto || "$mode" == delayed-auto || "$mode" == slow-auto ]] || fail "work submitted in $mode mode"
      assert_eq 1 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "verified auto gets one prompt"
      [[ "$mode" != auto ]] || assert_eq 1 "$(call_count '^agent read')" "ready auto has no retry"
      [[ "$mode" != slow-auto ]] || assert_eq 5 "$(call_count '^agent read')" "slow footer accepted without resubmission"
    else
      [[ "$mode" != auto && "$mode" != delayed-auto && "$mode" != slow-auto ]] || fail "auto startup refused: $(< "$TMPDIR/result")"
      case "$mode" in
        manual) assert_eq 1 "$(call_count '^agent read')" "manual fails immediately" ;;
        delayed-manual) assert_eq 2 "$(call_count '^agent read')" "manual after rendering fails immediately" ;;
        slow-manual) assert_eq 5 "$(call_count '^agent read')" "slow manual never receives assignment" ;;
        unknown) assert_eq 6 "$(call_count '^agent read')" "missing footer retry budget" ;;
      esac
      assert_file_present "$FAKE_HERDR_CASE/tab-alive" "$mode startup retained for inspection"
      assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "$mode gets no assignment"
      assert_eq 0 "$(call_count '^pane split')" "$mode creates no unnecessary monitor"
      rg -q 'MODE_UNSUPPORTED|MODE_UNVERIFIED' "$TMPDIR/result" || fail "missing actionable mode error"
      # Recover/resume must check the observed mode too; merely idle is not enough.
      if bash "$worker_script" --resume --name worker --kind claude --cwd "$FAKE_HERDR_CASE" \
        --prompt-file "$worker_prompt" --workspace ws --orchestrator-agent orch > "$TMPDIR/resume" 2>&1; then
        fail "$mode bypassed mode check on resume"
      fi
      assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/worker-prompts")" "$mode resume still sends no work"
      assert_eq 1 "$(call_count '^tab create')" "$mode resume reuses owned tab"
    fi
  done
)

test_close_owner_tab_is_refused() (
  setup_case close-owner-tab
  write_complete_transcript
  run_hook settled "$(payload)"
  write_worker_registry worker ws
  if HERDR_AXI_OWNER_TAB=tab-1 bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "closed owner tab"
  fi
  assert_eq 0 "$(call_count 'tab close tab-1')" "self close calls"
  : > "$FAKE_HERDR_CASE/extra-pane"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "closed a tab containing an unregistered pane"
  fi
  assert_eq 0 "$(call_count 'tab close tab-1')" "foreign pane close calls"
)

test_claude_report_survives_receipt_ack_but_not_new_task() (
  setup_case claude-report
  printf '%s\n' claude > "$FAKE_HERDR_CASE/kind"
  transcript="$HOME/.claude/projects/session-1.jsonl"
  printf '%s\n' \
    '{"type":"user","message":{"content":"current task"}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"task: current\nchecks: PASS"}]}}' \
    '{"type":"user","message":{"content":[{"type":"tool_result","content":"receipt written"}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Receipt written; see above."}]}}' > "$transcript"
  result=$(HERDR_MONITOR_RENDER_ONLY=1 bash "$hook_script" settled '{}')
  [[ "$result" == *"checks: PASS"* ]] || fail "structured result lost behind receipt acknowledgement"
  printf '%s\n' \
    '{"type":"user","message":{"content":[{"type":"text","text":"new task"}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"New task result"}]}}' >> "$transcript"
  result=$(HERDR_MONITOR_RENDER_ONLY=1 bash "$hook_script" settled '{}')
  [[ "$result" == *"New task result"* && "$result" != *"checks: PASS"* ]] || fail "old task report leaked into new task"
)

test_compact_completion_command_handles_quoted_paths() (
  setup_case compact-proof
  source "$receipt_script"
  proof_receipt="$TMPDIR/space and 'quote.event"
  command=$(herdr_append_completion_instruction task "$proof_receipt" testgen | tail -n 1)
  bash -c "$command"
  assert_eq testgen "$(< "$proof_receipt.proof.testgen")" "compact proof content"
  assert_file_absent "$proof_receipt.proof.testgen.tmp" "atomic temporary proof"
)

test_quota_handoff_requires_checkpoint_identity_and_paused_worker() (
  setup_case quota-handoff
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  herdr_receipt_lock_acquire "$HERDR_MONITOR_RECEIPT"
  herdr_receipt_rearm_locked "$HERDR_MONITOR_RECEIPT" handoff testgen
  herdr_receipt_lock_release
  write_worker_registry worker ws testgen
  export HERDR_AXI_MANAGED_TASK=1
  run_file="$FAKE_HERDR_CASE/run.json"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed without durable checkpoint"
  fi
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"switching",handoffs:[{from:{name:"worker",kind:"copilot",pane:"pane-1",tab:"tab-1",generation:"testgen",session:"session-1",receipt:$receipt},to:{kind:"codex"},quota:{code:"QUOTA_EXHAUSTED"},output:"saved partial work"}]}]}' > "$run_file"
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed an active worker"
  fi
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  printf '%s\n' changed-session > "$FAKE_HERDR_CASE/session"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed a changed session"
  fi
  assert_file_present "$FAKE_HERDR_CASE/tab-alive" "failed checks preserve tab"
  printf '%s\n' session-1 > "$FAKE_HERDR_CASE/session"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed without a current quota error"
  fi
  printf '%s\n' "You've hit your usage limit" > "$FAKE_HERDR_CASE/visible"
  node() { cat >/dev/null; printf '%s' "${FAKE_QUOTA_OUTPUT:-}"; }
  export -f node
  for invalid in '' 'null' '{}' '[]' '{"code":"OTHER"}' 'partial'; do
    if HERDR_AXI_NODE=node FAKE_QUOTA_OUTPUT="$invalid" bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
      fail "handoff accepted invalid quota protocol: $invalid"
    fi
    assert_eq 0 "$(call_count '^tab close')" "invalid quota preserves tab"
  done
  unset -f node
  printf '%s\n' "You've hit your usage limit" 'Do you want to proceed?' '❯ 1. Yes' '  2. No' > "$FAKE_HERDR_CASE/visible"
  printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed a permission dialog with retained quota text"
  fi
  assert_eq 0 "$(call_count '^tab close')" "dialog preserves tab"
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "You've hit your usage limit" > "$FAKE_HERDR_CASE/visible"
  write_current_completion_proof
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed while current completion proof awaited collection"
  fi
  assert_eq 0 "$(call_count '^tab close')" "pending proof preserves tab"
  remove_current_completion_proof
  : > "$FAKE_HERDR_CASE/start-on-read"
  if bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null 2>&1; then
    fail "handoff closed worker that resumed during quota read"
  fi
  printf '%s\n' unknown > "$FAKE_HERDR_CASE/status"
  if bash "$orchestrator_script" close worker >/dev/null 2>&1; then
    fail "normal close bypassed missing completion"
  fi
  bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "handoff closes recorded tab"
  assert_eq "" "$(receipt_read_field 8)" "handoff never fabricates completion"
  assert_eq closed "$(receipt_read_field 9)" "handoff tombstone"
  assert_eq handoff "$(receipt_read_field 11)" "handoff reason"
  bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null
  assert_eq 1 "$(call_count '^tab close')" "retry never closes twice"
)

test_quota_hook_records_error_without_completion_or_owner_input() (
  setup_case quota-hook
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  herdr_receipt_lock_acquire "$HERDR_MONITOR_RECEIPT"
  herdr_receipt_rearm_locked "$HERDR_MONITOR_RECEIPT" quota testgen
  herdr_receipt_lock_release
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "You've hit your limit · resets later" > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook settled '{}'
  assert_eq error "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "quota is error, never settled"
  assert_eq QUOTA_EXHAUSTED "$(jq -r '.quota.code' "${HERDR_MONITOR_RECEIPT}.inbox")" "quota diagnostic"
  assert_eq testgen "$(jq -r '.generation' "${HERDR_MONITOR_RECEIPT}.inbox")" "generation bound"
  assert_eq "" "$(receipt_read_field 8)" "no fabricated completion proof"
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "never inject owner input"
  printf '%s\n' unknown > "$FAKE_HERDR_CASE/status"
  HERDR_MONITOR_INBOX=1 run_hook quota '{}'
  assert_eq suppressed "$(receipt_read_field 4)" "duplicate quota suppressed"
  printf '%s\n' 'ordinary output, not quota' > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook quota '{}'
  assert_eq QUOTA_EXHAUSTED "$(jq -r '.quota.code' "${HERDR_MONITOR_RECEIPT}.inbox")" "no-quota probe cannot overwrite evidence"

  setup_case quota-after-completion
  write_complete_transcript
  HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
  saved_inbox=$(< "${HERDR_MONITOR_RECEIPT}.inbox")
  printf '%s\n' "You've hit your limit" > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook error '{}'
  assert_eq "$saved_inbox" "$(< "${HERDR_MONITOR_RECEIPT}.inbox")" "completed result survives later quota"
  assert_eq completed-task-quota "$(receipt_read_field 11)" "completed quota suppression reason"
)

test_cancel_monitor_orphan_requires_checkpoint_and_preserves_foreign_panes() (
  setup_case cancel-monitor-orphan
  source "$receipt_script"
  mkdir -p "$(dirname -- "$HERDR_MONITOR_RECEIPT")"
  herdr_receipt_lock_acquire "$HERDR_MONITOR_RECEIPT"
  herdr_receipt_rearm_locked "$HERDR_MONITOR_RECEIPT" cancel testgen
  herdr_receipt_lock_release
  write_worker_registry worker ws testgen
  export HERDR_AXI_MANAGED_TASK=1
  run_file="$FAKE_HERDR_CASE/run.json"
  if bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel closed without checkpoint"
  fi
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"cancelling",cancellation:{from:{name:"worker",pane:"pane-1",tab:"tab-1",generation:"testgen",session:"session-1",receipt:$receipt},evidence:"User authorized stop; saved partial state",output:"partial result"}}]}' > "$run_file"
  printf '%s\n' changed-session > "$FAKE_HERDR_CASE/session"
  if bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel closed changed session"
  fi
  printf '%s\n' session-1 > "$FAKE_HERDR_CASE/session"
  : > "$FAKE_HERDR_CASE/agent-get-fail"
  if bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel treated unreadable live pane as absent"
  fi
  rm -f "$FAKE_HERDR_CASE/pane-1-alive"
  : > "$FAKE_HERDR_CASE/extra-pane"
  if bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel closed foreign pane in monitor-only tab"
  fi
  rm -f "$FAKE_HERDR_CASE/extra-pane"
  if HERDR_AXI_OWNER_TAB=tab-1 bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null 2>&1; then
    fail "cancel closed owner tab"
  fi
  assert_eq 0 "$(call_count '^tab close')" "failed validations never close"
  bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "cancel closes orphan tab"
  assert_file_absent "$FAKE_HERDR_CASE/monitor-1-alive" "cancel closes monitor"
  assert_file_absent "$HERDR_RECEIPT_ROOT/ws/worker.json" "cancel removes registry"
  assert_eq "" "$(receipt_read_field 8)" "cancel never fabricates proof"
  assert_eq cancelled "$(receipt_read_field 11)" "cancel tombstone reason"
  bash "$orchestrator_script" close worker --cancel "$run_file" >/dev/null
  assert_eq 1 "$(call_count '^tab close')" "cancel retry idempotent"
  run_hook lost '{}'
  assert_eq 0 "$(file_value "$FAKE_HERDR_CASE/prompt-attempts")" "intentional closure suppresses lost notification"
)

test_quota_with_pending_proof_preserves_completed_report() (
  for kind in copilot claude codex; do
    setup_case "quota-pending-proof-$kind"
    printf '%s\n' "$kind" > "$FAKE_HERDR_CASE/kind"
    case "$kind" in
      copilot) write_complete_transcript ;;
      claude) write_claude_transcript >/dev/null; arm_completion_generation ;;
      codex) write_codex_transcript >/dev/null; arm_completion_generation ;;
    esac
    printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
    printf '%s\n' "You've hit your usage limit" > "$FAKE_HERDR_CASE/visible"
    HERDR_MONITOR_INBOX=1 run_hook error '{}'
    assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "$kind proof wins before first settlement"
    assert_eq generation:generation-one "$(receipt_read_field 8)" "$kind proof committed"
    assert_eq QUOTA_EXHAUSTED "$(jq -r '.quota.code' "${HERDR_MONITOR_RECEIPT}.inbox")" "$kind quota retained separately"
    saved=$(< "${HERDR_MONITOR_RECEIPT}.inbox")
    [[ "$saved" == *'"summary":"complete"'* || "$saved" == *'"summary":"intermediate"'* ]] || fail "$kind report replaced by quota"
    HERDR_MONITOR_INBOX=1 run_hook settled '{}'
    assert_eq "$saved" "$(< "${HERDR_MONITOR_RECEIPT}.inbox")" "$kind retry preserves result"
  done
  setup_case quota-proof-empty-native-report
  printf '%s\n' '{"type":"session.task_complete","data":{"summary":""}}' > "$(transcript_path)"
  arm_completion_generation
  printf '%s\n' idle > "$FAKE_HERDR_CASE/status"
  printf '%s\n' 'VISIBLE_RESULT: checks passed' 'You have exceeded your monthly quota' > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook error '{}'
  assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "empty native report still settles with proof"
  [[ "$(jq -r '.detail' "${HERDR_MONITOR_RECEIPT}.inbox")" == *VISIBLE_RESULT* ]] || fail "quota discarded visible fallback report"
  for invalid in absent stale malformed unfinished; do
    setup_case "quota-invalid-proof-$invalid"
    write_complete_transcript
    case "$invalid" in
      absent) remove_current_completion_proof ;;
      stale) printf '%s\n' old-generation > "${HERDR_MONITOR_RECEIPT}.proof.generation-one" ;;
      malformed) printf '%s' generation-one > "${HERDR_MONITOR_RECEIPT}.proof.generation-one" ;;
      unfinished) append_user_message ;;
    esac
    printf '%s\n' "You have exceeded your monthly quota" > "$FAKE_HERDR_CASE/visible"
    HERDR_MONITOR_INBOX=1 run_hook settled '{}'
    assert_eq error "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "$invalid proof cannot defeat quota"
    assert_eq "" "$(receipt_read_field 8)" "$invalid proof cannot complete"
  done
)

test_monitor_signal_during_waiter_registration() (
  setup_case signal-during-registration
  printf '%s\n' working > "$FAKE_HERDR_CASE/status"
  # Scheduling fault injection, not a source-text assertion: interrupt the real
  # monitor's helper after spawning its backend but before recording its PID.
  cat > "$FAKE_HERDR_CASE/schedule.bash" <<'EOF'
set -T
trap '
  if [[ "$BASH_COMMAND" == "wait_command_pid=\$!" && ! -e "$FAKE_HERDR_CASE/registration-pid" ]]; then
    trap - DEBUG
    backend_pid=$!
    helper_pid=$(ps -o ppid= -p "$backend_pid" | tr -d " ")
    printf "%s\n" "$backend_pid" > "$FAKE_HERDR_CASE/registration-pid"
    kill -TERM "$helper_pid"
  fi
' DEBUG
EOF
  BASH_ENV="$FAKE_HERDR_CASE/schedule.bash" bash "$monitor_script" worker worker orch "$HERDR_MONITOR_RECEIPT" "$hook_script" > "$FAKE_HERDR_CASE/output" 2>&1 &
  monitor_pid=$!
  trap 'kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true; if [[ -s "$FAKE_HERDR_CASE/registration-pid" ]]; then kill "$(< "$FAKE_HERDR_CASE/registration-pid")" 2>/dev/null || true; fi' EXIT
  wait_for_file "$FAKE_HERDR_CASE/registration-pid" || fail "registration signal never injected"
  sleep 0.2
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  assert_no_fake_waiters "signal during PID registration"
  trap - EXIT
)

test_hook_renders_backend_output_without_holding_receipt_lock() (
  jq() {
    if [[ "$*" == *events.jsonl* ]]; then
      : > "$FAKE_HERDR_CASE/transcript-scanned"
      if [[ -e "${HERDR_MONITOR_RECEIPT}.lock" ]]; then : > "$FAKE_HERDR_CASE/locked-transcript-scan"; fi
    fi
    command jq "$@"
  }
  export -f jq
  setup_case locked-scan-negative-control
  write_complete_transcript
  (
    # shellcheck source=herdr-receipt.sh
    source "$receipt_script"
    herdr_receipt_lock_acquire "$HERDR_MONITOR_RECEIPT"
    jq -s . "$(transcript_path)" >/dev/null
    assert_file_present "$FAKE_HERDR_CASE/locked-transcript-scan" "negative control detects a real locked scan"
    herdr_receipt_lock_release
  )
  for event in settled input error lost quota; do
    setup_case "unlocked-render-$event"
    write_complete_transcript
    : > "$FAKE_HERDR_CASE/check-unlocked-reads"
    if [[ "$event" == quota ]]; then printf '%s\n' 'You have exceeded your monthly quota' > "$FAKE_HERDR_CASE/visible"; event=error; fi
    HERDR_MONITOR_INBOX=1 run_hook "$event" '{}'
    assert_file_present "${HERDR_MONITOR_RECEIPT}.inbox" "$event delivered"
    assert_file_absent "$FAKE_HERDR_CASE/locked-backend-reads" "$event backend reads outside critical section"
    assert_file_present "$FAKE_HERDR_CASE/transcript-scanned" "$event transcript scan exercised"
    assert_file_absent "$FAKE_HERDR_CASE/locked-transcript-scan" "$event transcript scans outside critical section"
  done
)

test_quota_protocol_failures_preserve_reports_and_diagnose_node() (
  node() { cat >/dev/null; printf '%s' "${FAKE_QUOTA_OUTPUT:-}"; }
  export -f node
  for invalid in '' 'null' '{}' '[]' 'partial'; do
    setup_case "quota-protocol-${#invalid}-$RANDOM"
    write_complete_transcript
    HERDR_AXI_NODE=node FAKE_QUOTA_OUTPUT="$invalid" HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
    assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "invalid optional quota cannot lose report"
    assert_eq 'native completion' "$(jq -r '.summary' "${HERDR_MONITOR_RECEIPT}.inbox")" "report preserved"
  done
  unset -f node
  setup_case missing-node-diagnostic
  export HERDR_MONITOR_RESULT_FILE="$TMPDIR/result"
  if HERDR_AXI_NODE=/missing-herdr-node bash "$hook_script" quota '{}' 2> "$TMPDIR/error"; then fail "missing node silently succeeded"; fi
  assert_eq $'error\tmissing-node' "$(< "$HERDR_MONITOR_RESULT_FILE")" "machine-readable missing node"
  [[ "$(< "$TMPDIR/error")" == *'missing dependency: node'* ]] || fail "node diagnosis absent"
  write_complete_transcript
  HERDR_AXI_NODE="$(command -v node)" HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
  assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "pinned node restores collection"
)

test_unknown_readiness_preserves_generation_bound_completion() (
  for status in unknown __empty__ working blocked; do
    setup_case "completion-state-$status"
    write_complete_transcript
    printf '%s\n' "$status" > "$FAKE_HERDR_CASE/status"
    HERDR_MONITOR_INBOX=1 run_hook settled "$(payload)"
    if [[ "$status" == working || "$status" == blocked ]]; then
      assert_file_absent "${HERDR_MONITOR_RECEIPT}.inbox" "active/UI state cannot settle"
    else
      assert_eq settled "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "unknown readiness does not discard proof"
    fi
  done
  setup_case input-wins-over-quota
  printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "You've hit your limit" > "$FAKE_HERDR_CASE/visible"
  HERDR_MONITOR_INBOX=1 run_hook input '{"message":"Permission required"}'
  assert_eq input "$(jq -r '.event' "${HERDR_MONITOR_RECEIPT}.inbox")" "native input event wins"
  assert_eq null "$(jq -r '.quota' "${HERDR_MONITOR_RECEIPT}.inbox")" "input is not quota"
)

test_created_stage_handoff_without_monitor_or_receipt() (
  setup_case created-handoff
  source "$receipt_script"
  write_worker_registry worker ws testgen
  registry="$HERDR_RECEIPT_ROOT/ws/worker.json"
  jq '.stage="created" | .monitor_pane=null' "$registry" > "$TMPDIR/registry"
  mv "$TMPDIR/registry" "$registry"
  rm "$FAKE_HERDR_CASE/monitor-1-alive"
  export HERDR_AXI_MANAGED_TASK=1
  run_file="$FAKE_HERDR_CASE/run.json"
  jq -nc --arg receipt "$HERDR_MONITOR_RECEIPT" '{schema:1,workspace:"ws",owner:{pane:"owner",tab:"owner-tab"},tasks:[{name:"worker",pane:"pane-1",state:"switching",handoffs:[{from:{name:"worker",kind:"copilot",pane:"pane-1",tab:"tab-1",generation:"testgen",session:"session-1",receipt:$receipt},to:{kind:"codex"},quota:{code:"QUOTA_EXHAUSTED"},output:"startup checkpoint"}]}]}' > "$run_file"
  printf '%s\n' blocked > "$FAKE_HERDR_CASE/status"
  printf '%s\n' "You've hit your session limit" > "$FAKE_HERDR_CASE/visible"
  bash "$orchestrator_script" close worker --handoff "$run_file" >/dev/null
  assert_file_absent "$FAKE_HERDR_CASE/tab-alive" "created tab retired"
  assert_eq 1 "$(call_count '^tab close')" "whole startup tab closed once"
)

tests=(
  test_split_monitor_preserves_delivery_mode
  test_quota_protocol_failures_preserve_reports_and_diagnose_node
  test_unknown_readiness_preserves_generation_bound_completion
  test_created_stage_handoff_without_monitor_or_receipt
  test_hook_renders_backend_output_without_holding_receipt_lock
  test_monitor_signal_during_waiter_registration
  test_quota_with_pending_proof_preserves_completed_report
  test_cancel_monitor_orphan_requires_checkpoint_and_preserves_foreign_panes
  test_quota_hook_records_error_without_completion_or_owner_input
  test_quota_handoff_requires_checkpoint_identity_and_paused_worker
  test_claude_report_survives_receipt_ack_but_not_new_task
  test_compact_completion_command_handles_quoted_paths
  test_idle_completion_is_collected
  test_blocked_startup_resumes_owned_pane
  test_blocked_startup_hook_keeps_cancellable_generation
  test_legacy_startup_cancel_repair_is_narrow
  test_claude_startup_requires_verified_auto_mode
  test_monitor_survives_quiet_intervals
  test_monitor_separates_readiness_completion_and_acceptance
  test_failed_native_waits_back_off_and_lost_terminates
  test_backoff_grows_not_just_below_a_loose_attempt_ceiling
  test_managed_inbox_never_prompts_owner
  test_prompt_ack_and_no_nested_agents
  test_close_owner_tab_is_refused
  test_concurrent_settled_once
  test_missing_transcripts_and_stale_copilot
  test_structural_completion_proof_for_all_agents
  test_no_completion_proof_preserves_generation
  test_terminal_dedup_across_nested_events
  test_close_tombstone_followup_and_rearm
  test_workspace_fallback_shared_by_all_callers
  test_workspace_resolution_hard_failure
  test_close_priority_and_close_failure
  test_registered_tab_close_and_idempotency
  test_monitor_only_legacy_tab_close
  test_close_ignores_inherited_paths
  test_close_verifies_resource_disappearance
  test_close_transient_probe_is_fail_closed
  test_close_generation_binding
  test_receipt_override_is_agent_bound
  test_lock_parallelism_and_subshell_identity
  test_lock_reaping_and_exact_identity
  test_transient_process_identity_is_fail_closed
  test_lock_lease_parent_identity_is_fail_closed
  test_sigkill_lock_and_claim_cleanup
  test_lock_timeout_machine_result
  test_delivery_failure_waits_for_transition
  test_hot_loop_negative_probe
  test_same_name_restart_and_new_cycle
  test_monitor_rearm_across_idle_and_fast_completion
  test_blocked_working_cycle_preserves_assignment_and_proof
  test_monitor_rearm_unknown_and_failure_are_not_new_assignments
  test_worker_prompt_failure_is_not_success
  test_prompt_delivery_for_all_agent_kinds
  test_event_bounded_pane_readiness
  test_signal_cleanup_fixture
)

for test_name in "${tests[@]}"; do
  if [[ -n "${HERDR_MONITOR_TEST_FILTER:-}" &&
    "$test_name" != "$HERDR_MONITOR_TEST_FILTER" ]]; then
    continue
  fi
  "$test_name"
  printf 'ok - %s\n' "$test_name"
done
