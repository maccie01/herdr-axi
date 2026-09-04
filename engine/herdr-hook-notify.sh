#!/bin/bash
set -euo pipefail

event_kind="${1:-}"
[[ "$event_kind" == "settled" || "$event_kind" == "input" || "$event_kind" == "error" || "$event_kind" == "lost" ]] || exit 0
[[ "${HERDR_ENV:-}" == "1" && "${HERDR_MONITOR_ENABLED:-}" == "1" ]] || exit 0
if [[ "${HERDR_MONITOR_RENDER_ONLY:-}" != "1" && -z "${HERDR_MONITOR_ORCHESTRATOR:-}" ]]; then
  exit 0
fi

for dependency in herdr jq awk tail head find mktemp cksum dirname sleep ln stat ps wc; do
  command -v "$dependency" >/dev/null || exit 0
done

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=herdr-receipt.sh
source "$script_dir/herdr-receipt.sh"

payload_file=$(mktemp "${TMPDIR:-/tmp}/herdr-hook-notify.XXXXXX") || exit 0
cleanup() {
  rm -f "$payload_file"
  herdr_receipt_lock_release
}
trap cleanup EXIT HUP INT TERM
if [[ -n "${2:-}" ]]; then
  printf '%s' "$2" > "$payload_file"
else
  cat > "$payload_file" 2>/dev/null || true
fi

write_result() {
  local outcome="$1"
  local reason="$2"
  local result_file="${HERDR_MONITOR_RESULT_FILE:-}"
  local result_tmp
  [[ -n "$result_file" ]] || return 0
  mkdir -p "$(dirname -- "$result_file")"
  result_tmp=$(mktemp "${result_file}.tmp.XXXXXX") || return 0
  printf '%s\t%s\n' "$outcome" "$reason" > "$result_tmp"
  mv -f "$result_tmp" "$result_file"
}

agent_name="${HERDR_MONITOR_AGENT:-${HERDR_PANE_ID:-}}"
[[ -n "$agent_name" ]] || {
  write_result error missing-agent
  exit 0
}
agent_label="${HERDR_MONITOR_LABEL:-$agent_name}"

payload_value() {
  local expression="$1"
  jq -r "$expression // empty" "$payload_file" 2>/dev/null || true
}

visible_tail() {
  herdr agent read "$agent_name" --source visible --lines 100 2>/dev/null |
    awk '
      NF {
        lines[++count] = $0
      }
      END {
        start = count > 18 ? count - 17 : 1
        for (i = start; i <= count; i++) print lines[i]
      }
    ' |
    tail -c 3000
}

transcript_backend=""
transcript_path=""
transcript_session=""
transcript_resolution="none"
live_status=""

resolve_native_transcript() {
  local metadata explicit_path expected_path agent_kind
  metadata=$(herdr agent get "$agent_name" 2>/dev/null || true)
  transcript_session=$(printf '%s\n' "$metadata" |
    jq -r '.result.agent.agent_session.value // empty' 2>/dev/null || true)
  agent_kind=$(printf '%s\n' "$metadata" |
    jq -r '.result.agent.agent // empty' 2>/dev/null || true)
  live_status=$(printf '%s\n' "$metadata" |
    jq -r '.result.agent.agent_status // empty' 2>/dev/null || true)
  explicit_path=$(payload_value '.transcriptPath // .transcript_path')

  if [[ -n "$explicit_path" ]]; then
    case "$explicit_path" in
      "${HOME}"/.copilot/session-state/*/events.jsonl) transcript_backend=copilot ;;
      "${HOME}"/.claude/projects/*.jsonl) transcript_backend=claude ;;
      "${HOME}"/.codex/sessions/*.jsonl) transcript_backend=codex ;;
      *) transcript_backend="" ;;
    esac
    if [[ -n "$transcript_backend" ]]; then
      if [[ "$transcript_backend" == "copilot" && -n "$transcript_session" ]]; then
        expected_path="${HOME}/.copilot/session-state/${transcript_session}/events.jsonl"
        if [[ "$explicit_path" != "$expected_path" ]]; then
          transcript_path="$explicit_path"
          transcript_resolution=stale
          return 0
        fi
      fi
      if [[ -r "$explicit_path" ]]; then
        transcript_path="$explicit_path"
        transcript_resolution=resolved
        return 0
      fi
    fi
  fi

  [[ -n "$transcript_session" ]] || return 0
  case "$agent_kind" in
    copilot)
      transcript_backend=copilot
      transcript_path="${HOME}/.copilot/session-state/${transcript_session}/events.jsonl"
      ;;
    claude)
      transcript_backend=claude
      transcript_path=$(find "${HOME}/.claude/projects" -type f \
        -name "${transcript_session}.jsonl" -print -quit 2>/dev/null || true)
      ;;
    codex)
      transcript_backend=codex
      transcript_path=$(find "${HOME}/.codex/sessions" -type f \
        -name "*${transcript_session}.jsonl" -print -quit 2>/dev/null || true)
      ;;
    *) transcript_backend="" ;;
  esac
  if [[ -n "$transcript_path" && -r "$transcript_path" ]]; then
    transcript_resolution=resolved
  else
    transcript_path=""
  fi
}

native_transcript_tail() {
  local backend="$1"
  local path="$2"
  [[ -n "$backend" && -r "$path" ]] || return 0
  case "$backend" in
    copilot)
      tail -n 500 "$path" 2>/dev/null |
        jq -r '
          if .type == "session.task_complete" then .data.summary
          elif .type == "assistant.message" then .data.content
          else empty
          end
          | select(type == "string" and length > 0)
          | gsub("[[:space:]]+"; " ")
          | .[0:3500]
        ' 2>/dev/null |
        tail -n 1
      ;;
    claude)
      tail -n 500 "$path" 2>/dev/null |
        jq -sr '
          reduce .[] as $e ({last:"",report:""};
            if $e.type == "user" and
              (($e.message.content | type) == "string" or
               any($e.message.content[]?; .type == "text")) then {last:"",report:""}
            elif $e.type == "assistant" and $e.message.role == "assistant" then
              ([$e.message.content[]? | select(.type == "text") | .text] | join("\n")) as $text |
              if ($text | length) > 0 then .last = $text |
                if ($text | test("(?m)^\\s*task:")) then .report = $text else . end
              else . end
            else . end) |
          (if .report != "" then .report else .last end) | .[0:3500]
        ' 2>/dev/null
      ;;
    codex)
      tail -n 500 "$path" 2>/dev/null |
        jq -r 'select(.type == "response_item" and .payload.type == "message" and .payload.role == "assistant") | [.payload.content[]? | .text // empty] | join(" ") | select(length > 0) | gsub("[[:space:]]+"; " ") | .[0:3500]' 2>/dev/null |
        tail -n 1
      ;;
  esac
}

copilot_task_complete() {
  local path="$1"
  local last_event
  [[ -r "$path" ]] || return 1
  last_event=$(jq -r \
    'select(.type == "user.message" or .type == "session.task_complete") | .type' \
    "$path" 2>/dev/null | tail -n 1)
  [[ "$last_event" == "session.task_complete" ]]
}

completion_ordinal() {
  local backend="$1"
  local path="$2"
  case "$backend" in
    copilot)
      jq -r 'select(.type == "session.task_complete") | 1' "$path" 2>/dev/null |
        wc -l | awk '{$1=$1; print}'
      ;;
    claude)
      jq -r 'select(.type == "assistant" and .message.role == "assistant") | 1' \
        "$path" 2>/dev/null | wc -l | awk '{$1=$1; print}'
      ;;
    codex)
      jq -r 'select(.type == "response_item" and .payload.type == "message" and .payload.role == "assistant") | 1' \
        "$path" 2>/dev/null | wc -l | awk '{$1=$1; print}'
      ;;
    *) printf '%s\n' 0 ;;
  esac
}

resolve_native_transcript
suppression_reason=""

# Copilot emits errorOccurred for failed subagent/tool calls during a live turn.
if [[ "$event_kind" == "error" ]]; then
  live_status=$(herdr agent get "$agent_name" 2>/dev/null |
    jq -r '.result.agent.agent_status // empty' 2>/dev/null || true)
  if [[ "$live_status" == "working" ]]; then
    suppression_reason=transient-worker-error
  fi
fi

detail=""
if [[ "$event_kind" == "settled" ]]; then
  detail=$(payload_value '.last_assistant_message // .lastAssistantMessage // .["last-assistant-message"]')
  if [[ -z "$detail" ]]; then
    detail=$(native_transcript_tail "$transcript_backend" "$transcript_path" || true)
  fi
fi
if [[ -z "$detail" ]]; then
  detail=$(visible_tail || true)
fi

title=$(payload_value '.title')
hook_message=$(payload_value '.message')
if [[ "$event_kind" == "input" && -n "$hook_message" ]]; then
  if [[ -n "$title" ]]; then
    detail="${title}: ${hook_message}"$'\n'"${detail}"
  else
    detail="${hook_message}"$'\n'"${detail}"
  fi
fi
if [[ "$event_kind" == "error" && -n "$hook_message" ]]; then
  detail="${hook_message}"$'\n'"${detail}"
fi
detail=$(printf '%s\n' "$detail" | head -c 3500)

case "$event_kind" in
  settled) headline="[HERDR-MONITOR] ${agent_label} (${agent_name}) ist fertig." ;;
  input) headline="[HERDR-MONITOR] ${agent_label} (${agent_name}) braucht Eingabe oder Freigabe." ;;
  error) headline="[HERDR-MONITOR] ${agent_label} (${agent_name}) wurde mit einem Fehler angehalten." ;;
  lost) headline="[HERDR-MONITOR] ${agent_label} (${agent_name}) ist nicht mehr erreichbar." ;;
esac

message="$headline"
if [[ -n "$detail" ]]; then
  message+=$'\n\nLetzte Agentenausgabe:\n'
  message+="$detail"
fi

if [[ "$event_kind" == "settled" ]]; then
  fingerprint=""
elif [[ "$transcript_resolution" == "resolved" ]]; then
  ordinal=$(completion_ordinal "$transcript_backend" "$transcript_path" || true)
  if [[ -n "$ordinal" && "$ordinal" != "0" ]]; then
    fingerprint="${transcript_backend}:${transcript_session}:${ordinal}"
  else
    fingerprint=$(printf '%s\n' "$event_kind" "$message" | cksum |
      awk '{print $1 ":" $2}')
  fi
else
  fingerprint=$(printf '%s\n' "$event_kind" "$message" | cksum |
    awk '{print $1 ":" $2}')
fi

if [[ "${HERDR_MONITOR_RENDER_ONLY:-}" == "1" ]]; then
  printf '%s\n' "$message"
  exit 0
fi

if ! herdr_receipt_resolve "$agent_name" "" "$agent_name"; then
  write_result error workspace-unresolved
  exit 0
fi
receipt_file="$HERDR_RECEIPT_FILE"

if ! herdr_receipt_lock_acquire "$receipt_file"; then
  write_result error lock-timeout
  exit 0
fi

receipt_exists=false
receipt_read_status=0
if herdr_receipt_read "$receipt_file"; then
  receipt_exists=true
else
  receipt_read_status=$?
fi
if (( receipt_read_status == 2 )); then
  write_result error unknown-receipt-schema
  exit 0
fi
if [[ "$receipt_exists" != "true" ]]; then
  receipt_cycle=1
  receipt_delivered_event=""
  receipt_delivered_fingerprint=""
  receipt_settled_fingerprint=""
  receipt_terminal=open
  receipt_generation=""
fi

if [[ "$event_kind" == "settled" && -n "$receipt_generation" ]]; then
  fingerprint="generation:${receipt_generation}"
fi

if [[ "$event_kind" == "settled" && -n "$receipt_settled_fingerprint" &&
  "$receipt_settled_fingerprint" == "$fingerprint" ]]; then
  suppression_reason=duplicate-settled
fi

if [[ "$event_kind" == "settled" && -z "$suppression_reason" ]]; then
  completion_file=""
  completion_value=""
  completion_size=""
  if [[ -n "$receipt_generation" ]]; then
    completion_file=$(herdr_completion_file "$receipt_file" "$receipt_generation" || true)
  fi
  if [[ -r "$completion_file" ]]; then
    { IFS= read -r completion_value < "$completion_file"; } 2>/dev/null || true
    completion_size=$(wc -c < "$completion_file" 2>/dev/null |
      awk '{$1=$1; print}')
  fi
  expected_size=$((${#receipt_generation} + 1))
  if [[ -z "$receipt_generation" ||
    "$transcript_resolution" != "resolved" ||
    -z "$transcript_session" ||
    "$live_status" == "working" ||
    "$live_status" == "blocked" ||
    "$completion_value" != "$receipt_generation" ||
    "$completion_size" != "$expected_size" ]]; then
    suppression_reason=no-completion-proof
  elif [[ "$transcript_backend" == "copilot" ]] &&
    ! copilot_task_complete "$transcript_path"; then
    suppression_reason=no-completion-proof
  fi
fi

if [[ -n "$suppression_reason" ]]; then
  herdr_receipt_write \
    "$receipt_file" "$receipt_cycle" "$event_kind" suppressed "$fingerprint" \
    "$receipt_delivered_event" "$receipt_delivered_fingerprint" \
    "$receipt_settled_fingerprint" "$receipt_terminal" "$receipt_generation" \
    "$suppression_reason"
  write_result suppressed "$suppression_reason"
  exit 0
fi

if [[ "$event_kind" == "settled" && "$receipt_terminal" == "closed" ]]; then
  suppression_reason=closed-tombstone
elif [[ "$receipt_delivered_event" == "$event_kind" &&
  "$receipt_delivered_fingerprint" == "$fingerprint" ]]; then
  suppression_reason=duplicate-event
fi

if [[ -n "$suppression_reason" ]]; then
  herdr_receipt_write \
    "$receipt_file" "$receipt_cycle" "$event_kind" suppressed "$fingerprint" \
    "$receipt_delivered_event" "$receipt_delivered_fingerprint" \
    "$receipt_settled_fingerprint" "$receipt_terminal" "$receipt_generation" \
    "$suppression_reason"
  write_result suppressed "$suppression_reason"
  exit 0
fi

delivered=false
if [[ "${HERDR_MONITOR_INBOX:-0}" == "1" ]]; then
  # One atomic, generation-bound inbox item per worker. The coordinator pulls
  # summaries in batches; hooks never type into its terminal.
  inbox_tmp=$(mktemp "${receipt_file}.inbox.tmp.XXXXXXXX")
  if jq -nc --arg event "$event_kind" --arg generation "$receipt_generation" \
    --arg summary "$detail" --arg fingerprint "$fingerprint" \
    '{event:$event,generation:$generation,fingerprint:$fingerprint,summary:($summary | .[0:600]),detail:($summary | .[0:3500]),truncated:($summary | length > 600)}' > "$inbox_tmp" &&
    mv -f "$inbox_tmp" "${receipt_file}.inbox"; then
    delivered=true
  else
    rm -f "$inbox_tmp"
  fi
else
  for _ in 1 2 3; do
    if herdr agent prompt "$HERDR_MONITOR_ORCHESTRATOR" "$message" >/dev/null 2>&1; then
      delivered=true
      break
    fi
  done
fi

if [[ "$delivered" == "true" ]]; then
  if [[ "$event_kind" == "settled" ]]; then
    receipt_settled_fingerprint="$fingerprint"
  fi
  herdr_receipt_write \
    "$receipt_file" "$receipt_cycle" "$event_kind" delivered "$fingerprint" \
    "$event_kind" "$fingerprint" "$receipt_settled_fingerprint" \
    "$receipt_terminal" "$receipt_generation" delivered
  if [[ "$event_kind" == "settled" && -n "${completion_file:-}" ]]; then
    rm -f "$completion_file"
  fi
  write_result delivered delivered
else
  herdr_receipt_write \
    "$receipt_file" "$receipt_cycle" "$event_kind" error "$fingerprint" \
    "$receipt_delivered_event" "$receipt_delivered_fingerprint" \
    "$receipt_settled_fingerprint" "$receipt_terminal" "$receipt_generation" \
    prompt-failed
  write_result error prompt-failed
fi

# Native hooks keep stdout empty and always return success. The lifecycle
# monitor receives the machine-readable outcome through its private result file.
exit 0
