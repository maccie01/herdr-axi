#!/bin/bash

HERDR_RECEIPT_SCHEMA="herdr-receipt/3"
herdr_receipt_lock_path=""
herdr_receipt_lock_inode=""
herdr_receipt_lock_claim=""
herdr_receipt_lock_lease_pid=""
herdr_receipt_temp_file=""
HERDR_RECEIPT_WORKSPACE_ID=""
HERDR_RECEIPT_ROOT_DIR=""
HERDR_RECEIPT_REGISTRY_DIR=""
HERDR_RECEIPT_FILE=""

herdr_process_start() {
  ps -p "$1" -o lstart= 2>/dev/null | awk '{$1=$1; print}'
}

herdr_new_generation() {
  local generation_file generation
  generation_file=$(mktemp "${TMPDIR:-/tmp}/herdr-generation.XXXXXXXX") || return 1
  generation="${generation_file##*.}"
  rm -f "$generation_file"
  [[ -n "$generation" ]] || return 1
  printf '%s\n' "$generation"
}

herdr_completion_file() {
  local receipt_file="$1"
  local generation="$2"
  [[ -n "$receipt_file" && -n "$generation" ]] || return 1
  printf '%s.proof.%s\n' "$receipt_file" "$generation"
}

herdr_append_completion_instruction() {
  local task="$1"
  local receipt_file="$2"
  local generation="$3"
  local completion_file completion_tmp_q completion_file_q generation_q
  completion_file=$(herdr_completion_file "$receipt_file" "$generation") || return 1
  printf -v completion_tmp_q '%q' "${completion_file}.tmp"
  printf -v completion_file_q '%q' "$completion_file"
  printf -v generation_q '%q' "$generation"
  printf '%s\n\n%s\n%s\n' \
    "$task" \
    "Struktureller Abschlussbeleg: Erst nachdem der gesamte Auftrag, alle verlangten Prüfungen und alle verlangten Ausgabedateien vollständig abgeschlossen sind, führe exakt diesen Befehl aus. Erzeuge den Beleg niemals für eine Zwischenantwort oder während Hintergrundarbeit läuft." \
    "umask 077; printf '%s\\n' $generation_q > $completion_tmp_q && mv -f $completion_tmp_q $completion_file_q"
}

herdr_start_lock_lease() {
  /bin/sh -c '
    parent_pid=$PPID
    parent_start=""
    identity_tick=0
    while kill -0 "$parent_pid" 2>/dev/null; do
      if [ "$identity_tick" -eq 0 ]; then
        current_start=$(ps -p "$parent_pid" -o lstart= 2>/dev/null)
        if [ -n "$current_start" ]; then
          if [ -z "$parent_start" ]; then
            parent_start=$current_start
          elif [ "$current_start" != "$parent_start" ]; then
            exit 0
          fi
        fi
      fi
      identity_tick=$(( (identity_tick + 1) % 20 ))
      sleep 0.05
    done
  ' &
  herdr_receipt_lock_lease_pid=$!
}

herdr_stop_lock_lease() {
  if [[ -n "$herdr_receipt_lock_lease_pid" ]]; then
    if kill -0 "$herdr_receipt_lock_lease_pid" 2>/dev/null; then
      kill "$herdr_receipt_lock_lease_pid" 2>/dev/null || true
    fi
    wait "$herdr_receipt_lock_lease_pid" 2>/dev/null || true
    herdr_receipt_lock_lease_pid=""
  fi
}

herdr_path_inode() {
  stat -f '%d:%i' "$1" 2>/dev/null
}

herdr_remove_exact_file() {
  local path="$1"
  local expected_inode="$2"
  local current_inode inode_number
  current_inode=$(herdr_path_inode "$path" || true)
  [[ -n "$current_inode" && "$current_inode" == "$expected_inode" ]] || return 0
  inode_number="${expected_inode#*:}"
  find "$path" -prune -inum "$inode_number" -exec rm -f {} \; 2>/dev/null || true
}

herdr_lock_owner_state() {
  local owner_pid="$1"
  local owner_start="$2"
  local current_start
  if [[ ! "$owner_pid" =~ ^[0-9]+$ || -z "$owner_start" ]]; then
    printf '%s\n' dead
    return 0
  fi
  if ! kill -0 "$owner_pid" 2>/dev/null; then
    printf '%s\n' dead
    return 0
  fi
  current_start=$(herdr_process_start "$owner_pid" || true)
  if [[ -z "$current_start" ]]; then
    printf '%s\n' unknown
  elif [[ "$current_start" == "$owner_start" ]]; then
    printf '%s\n' live
  else
    printf '%s\n' reused
  fi
}

herdr_lock_owner_live() {
  local owner_state
  owner_state=$(herdr_lock_owner_state "$1" "$2")
  [[ "$owner_state" == "live" || "$owner_state" == "unknown" ]]
}

herdr_cleanup_orphan_claims() {
  local lock_path="$1"
  local claim claim_inode owner_pid owner_start owner_token
  for claim in "${lock_path}.claim."*; do
    [[ -f "$claim" ]] || continue
    owner_pid=""
    owner_start=""
    owner_token=""
    { IFS=$'\t' read -r owner_pid owner_start owner_token < "$claim"; } 2>/dev/null || true
    if ! herdr_lock_owner_live "$owner_pid" "$owner_start"; then
      claim_inode=$(herdr_path_inode "$claim" || true)
      [[ -z "$claim_inode" ]] || herdr_remove_exact_file "$claim" "$claim_inode"
    fi
  done
}

herdr_receipt_lock_acquire() {
  local receipt_file="$1"
  local lock_path="${receipt_file}.lock"
  local process_id process_start claim_staging claim_path claim_inode
  local owner_pid owner_start owner_token current_inode
  local observed_inode="" observed_count=0 attempts=0
  local max_attempts="${HERDR_RECEIPT_LOCK_ATTEMPTS:-500}"

  mkdir -p "$(dirname -- "$receipt_file")"
  herdr_cleanup_orphan_claims "$lock_path"
  herdr_start_lock_lease
  process_id="$herdr_receipt_lock_lease_pid"
  process_start=$(herdr_process_start "$process_id" || true)
  if [[ -z "$process_start" ]]; then
    herdr_stop_lock_lease
    return 1
  fi
  if ! claim_staging=$(mktemp "${lock_path}.candidate.XXXXXX"); then
    herdr_stop_lock_lease
    return 1
  fi
  claim_path="${lock_path}.claim.${claim_staging##*.}"
  printf '%s\t%s\t%s\n' "$process_id" "$process_start" "${claim_path##*.}" > "$claim_staging"
  if ! mv -f "$claim_staging" "$claim_path"; then
    rm -f "$claim_staging"
    herdr_stop_lock_lease
    return 1
  fi
  claim_inode=$(herdr_path_inode "$claim_path" || true)
  [[ -n "$claim_inode" ]] || {
    rm -f "$claim_path"
    herdr_stop_lock_lease
    return 1
  }
  herdr_receipt_lock_claim="$claim_path"

  while ! ln "$claim_path" "$lock_path" 2>/dev/null; do
    owner_pid=""
    owner_start=""
    owner_token=""
    { IFS=$'\t' read -r owner_pid owner_start owner_token < "$lock_path"; } 2>/dev/null || true
    if herdr_lock_owner_live "$owner_pid" "$owner_start"; then
      observed_inode=""
      observed_count=0
    else
      current_inode=$(herdr_path_inode "$lock_path" || true)
      if [[ -n "$current_inode" && "$current_inode" == "$observed_inode" ]]; then
        observed_count=$((observed_count + 1))
      else
        observed_inode="$current_inode"
        observed_count=1
      fi
      if (( observed_count >= 3 )) && [[ -n "$observed_inode" ]]; then
        herdr_remove_exact_file "$lock_path" "$observed_inode"
        observed_inode=""
        observed_count=0
      fi
    fi

    attempts=$((attempts + 1))
    if (( attempts >= max_attempts )); then
      herdr_remove_exact_file "$claim_path" "$claim_inode"
      herdr_receipt_lock_claim=""
      if [[ -n "$herdr_receipt_temp_file" ]]; then
        rm -f "$herdr_receipt_temp_file"
        herdr_receipt_temp_file=""
      fi
      herdr_stop_lock_lease
      return 1
    fi
    sleep 0.01
  done

  herdr_remove_exact_file "$claim_path" "$claim_inode"
  herdr_receipt_lock_claim=""
  herdr_receipt_lock_path="$lock_path"
  herdr_receipt_lock_inode="$claim_inode"
}

herdr_receipt_lock_release() {
  if [[ -n "$herdr_receipt_lock_path" && -n "$herdr_receipt_lock_inode" ]]; then
    herdr_remove_exact_file "$herdr_receipt_lock_path" "$herdr_receipt_lock_inode"
  fi
  if [[ -n "$herdr_receipt_lock_claim" ]]; then
    claim_inode=$(herdr_path_inode "$herdr_receipt_lock_claim" || true)
    [[ -z "$claim_inode" ]] ||
      herdr_remove_exact_file "$herdr_receipt_lock_claim" "$claim_inode"
  fi
  herdr_receipt_lock_path=""
  herdr_receipt_lock_inode=""
  herdr_receipt_lock_claim=""
  herdr_stop_lock_lease
}

herdr_receipt_resolve() {
  local agent_name="$1"
  local workspace_hint="${2:-}"
  local metadata_agent="${3:-$agent_name}"
  local workspace_id metadata root_dir

  workspace_id="$workspace_hint"
  if [[ -z "$workspace_id" && -n "$metadata_agent" ]]; then
    metadata=$(herdr agent get "$metadata_agent" 2>/dev/null || true)
    workspace_id=$(printf '%s\n' "$metadata" |
      jq -r '.result.agent.workspace_id // empty' 2>/dev/null || true)
  fi
  [[ -n "$workspace_id" ]] || workspace_id="${HERDR_WORKSPACE_ID:-}"
  [[ -n "$workspace_id" && -n "$agent_name" && -n "${HOME:-}" ]] || return 1

  root_dir="${HERDR_RECEIPT_ROOT:-${HOME}/.herdr-orchestrator}"
  HERDR_RECEIPT_WORKSPACE_ID="$workspace_id"
  HERDR_RECEIPT_ROOT_DIR="$root_dir"
  HERDR_RECEIPT_REGISTRY_DIR="$root_dir/$workspace_id"
  HERDR_RECEIPT_FILE="$HERDR_RECEIPT_REGISTRY_DIR/$agent_name.event"
  if [[ -n "${HERDR_MONITOR_RECEIPT:-}" &&
    "${HERDR_MONITOR_AGENT:-}" == "$agent_name" &&
    "${HERDR_MONITOR_RECEIPT##*/}" == "${agent_name}.event" &&
    "$(dirname -- "$HERDR_MONITOR_RECEIPT")" == "$HERDR_RECEIPT_REGISTRY_DIR" ]]; then
    HERDR_RECEIPT_FILE="$HERDR_MONITOR_RECEIPT"
  fi
  umask 077
  mkdir -p "$HERDR_RECEIPT_REGISTRY_DIR" "$(dirname -- "$HERDR_RECEIPT_FILE")"
}

herdr_receipt_read() {
  local receipt_file="$1"
  local receipt_line
  receipt_schema=""
  receipt_cycle="0"
  receipt_event=""
  receipt_outcome=""
  receipt_fingerprint=""
  receipt_delivered_event=""
  receipt_delivered_fingerprint=""
  receipt_settled_fingerprint=""
  receipt_terminal="open"
  receipt_generation=""
  receipt_reason=""
  [[ -r "$receipt_file" ]] || return 1
  { IFS= read -r receipt_line < "$receipt_file"; } 2>/dev/null || true
  receipt_line="${receipt_line//$'\t'/$'\034'}"
  {
    IFS=$'\034' read -r \
      receipt_schema receipt_cycle receipt_event receipt_outcome \
      receipt_fingerprint receipt_delivered_event receipt_delivered_fingerprint \
      receipt_settled_fingerprint receipt_terminal receipt_generation \
      receipt_reason <<< "$receipt_line"
  } 2>/dev/null || true
  [[ "$receipt_schema" == "$HERDR_RECEIPT_SCHEMA" ]] || return 2
}

herdr_receipt_write() {
  local receipt_file="$1"
  local cycle="$2"
  local event_kind="$3"
  local outcome="$4"
  local fingerprint="$5"
  local delivered_event="$6"
  local delivered_fingerprint="$7"
  local settled_fingerprint="$8"
  local terminal_marker="$9"
  local generation="${10}"
  local reason="${11}"
  local temporary_file

  temporary_file=$(mktemp "${receipt_file}.tmp.XXXXXX") || return 1
  herdr_receipt_temp_file="$temporary_file"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$HERDR_RECEIPT_SCHEMA" "$cycle" "$event_kind" "$outcome" "$fingerprint" \
    "$delivered_event" "$delivered_fingerprint" "$settled_fingerprint" \
    "$terminal_marker" "$generation" "$reason" > "$temporary_file"
  if ! mv -f "$temporary_file" "$receipt_file"; then
    rm -f "$temporary_file"
    herdr_receipt_temp_file=""
    return 1
  fi
  herdr_receipt_temp_file=""
}

herdr_receipt_rearm_locked() {
  local receipt_file="$1"
  local reason="${2:-new-work}"
  local generation="${3:-}"
  local next_cycle=1
  local previous_completion=""
  if herdr_receipt_read "$receipt_file"; then
    if [[ -n "$receipt_generation" ]]; then
      previous_completion=$(herdr_completion_file "$receipt_file" "$receipt_generation" || true)
    fi
    if [[ "$receipt_cycle" =~ ^[0-9]+$ ]]; then
      next_cycle=$((receipt_cycle + 1))
    fi
  fi
  [[ -n "$generation" ]] || generation=$(herdr_new_generation)
  [[ -n "$generation" ]] || return 1
  [[ -z "$previous_completion" ]] || rm -f "$previous_completion"
  herdr_receipt_write \
    "$receipt_file" "$next_cycle" cycle armed "" "" "" "" open \
    "$generation" "$reason"
}

herdr_receipt_rearm() {
  local receipt_file="$1"
  local reason="${2:-new-work}"
  local generation="${3:-}"
  herdr_receipt_lock_acquire "$receipt_file" || return 1
  if ! herdr_receipt_rearm_locked "$receipt_file" "$reason" "$generation"; then
    herdr_receipt_lock_release
    return 1
  fi
  herdr_receipt_lock_release
}

herdr_receipt_rearm_if_unchanged() {
  local receipt_file="$1"
  local expected_cycle="$2"
  local expected_settled="$3"
  local reason="${4:-new-work}"
  local generation="${5:-}"
  herdr_receipt_lock_acquire "$receipt_file" || return 1
  if ! herdr_receipt_read "$receipt_file"; then
    herdr_receipt_lock_release
    return 1
  fi
  if [[ "$receipt_cycle" == "$expected_cycle" &&
    "$receipt_settled_fingerprint" == "$expected_settled" ]]; then
    if ! herdr_receipt_rearm_locked "$receipt_file" "$reason" "$generation"; then
      herdr_receipt_lock_release
      return 1
    fi
  fi
  herdr_receipt_lock_release
}

herdr_agent_status() {
  herdr agent get "$1" 2>/dev/null |
    jq -r '.result.agent.agent_status // empty' 2>/dev/null
}

herdr_deliver_prompt() {
  local agent_name="$1"
  local task="$2"
  local delivery_marker="$3"
  local prompt_json prompt_status=0 error_code visible state

  prompt_json=$(herdr agent prompt "$agent_name" "$task" --wait 2>&1) ||
    prompt_status=$?
  if (( prompt_status == 0 )); then
    return 0
  fi

  error_code=$(printf '%s\n' "$prompt_json" |
    jq -r '.error.code // empty' 2>/dev/null || true)
  [[ "$error_code" == "agent_prompt_stalled" ]] || return 1

  visible=$(herdr agent read "$agent_name" --source visible --lines 100 2>/dev/null || true)
  printf '%s\n' "$visible" | rg -Fq -- "$delivery_marker" || return 1

  state=$(herdr_agent_status "$agent_name" || true)
  case "$state" in
    working|blocked|done) return 0 ;;
    idle) ;;
    *) return 1 ;;
  esac

  herdr agent send-keys "$agent_name" enter >/dev/null || return 1
  herdr agent wait "$agent_name" \
    --until working \
    --until blocked \
    --until done \
    --timeout 6000 >/dev/null 2>&1 || return 1
  state=$(herdr_agent_status "$agent_name" || true)
  [[ "$state" == "working" || "$state" == "blocked" || "$state" == "done" ]]
}
