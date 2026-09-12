#!/bin/bash

[[ -z "${HERDR_NATIVE_IDENTITY_LOADED:-}" ]] || return 0
HERDR_NATIVE_IDENTITY_LOADED=1

herdr_registry_identity_matches() {
  local file="$1" metadata="$2" generation="${3:-}"
  jq -e --argjson metadata "$metadata" --arg generation "$generation" '
    ($metadata.result.agent) as $a |
    ($generation == "" or .generation == $generation) and
    .name == $a.name and .agent_pane == $a.pane_id and
    .tab_id == $a.tab_id and .workspace_id == $a.workspace_id and
    (.native_identity.terminal | type == "string" and length > 0) and
    (.native_identity.session | type == "string" and length > 0) and
    .native_identity.terminal == $a.terminal_id and
    .native_identity.session == $a.agent_session.value' "$file" >/dev/null 2>&1
}

# Native identity survives a coordinator publication failure in the existing
# registry. Session rotation is permitted only around our own start/prompt.
herdr_registry_capture_identity() {
  local file="$1" rotate="${2:-false}" pane info temporary
  pane=$(jq -er '.agent_pane' "$file") || return 1
  info=$(herdr agent get "$pane") || return 75
  jq -e '.result.agent | type == "object"' <<<"$info" >/dev/null 2>&1 || return 75
  temporary=$(mktemp "${file}.tmp.XXXXXXXX") || return 1
  if ! jq --argjson info "$info" --argjson rotate "$rotate" '
    $info.result.agent as $a |
    {terminal: ($a.terminal_id // null), session: ($a.agent_session.value | if . == "" then null else . end)} as $identity |
    if $a.pane_id == .agent_pane and $a.tab_id == .tab_id and
      $a.workspace_id == .workspace_id and $a.name == .name and
      (($identity.terminal | type) == "string" and ($identity.terminal | length) > 0 or
       ($identity.session | type) == "string" and ($identity.session | length) > 0) and
      (.native_identity.terminal == null or .native_identity.terminal == $identity.terminal) and
      ($rotate or .native_identity.session == null or .native_identity.session == $identity.session)
    then .native_identity = $identity
    else error("worker native identity unavailable or changed") end' "$file" > "$temporary"; then
    rm -f "$temporary"
    return 76
  fi
  if ! mv -f "$temporary" "$file"; then rm -f "$temporary"; return 1; fi
}

herdr_registry_wait_session() {
  local file="$1" timeout="$2" deadline=$((SECONDS + $2)) status attempt=0
  local delays=(0.1 0.2 0.4 0.8 1)
  while true; do
    status=0
    herdr_registry_capture_identity "$file" || status=$?
    case "$status" in
      0)
        if jq -e '.native_identity.session | type == "string" and length > 0' "$file" >/dev/null; then
          return 0
        fi ;;
      75) ;; # Observation failed: bounded retry, with no task submission.
      76)
        herdr_engine_error SESSION_IDENTITY_CHANGED "Worker identity changed while waiting for its native session" false
        return 1 ;;
      *)
        herdr_engine_error SESSION_START_UNVERIFIED "Cannot persist observed worker identity" false
        return 1 ;;
    esac
    (( SECONDS < deadline )) || break
    sleep "${delays[$attempt]}"
    if (( attempt < 4 )); then attempt=$((attempt + 1)); fi
  done
  herdr_engine_error SESSION_START_UNVERIFIED "Herdr did not report a verifiable native session within ${timeout}s; task not submitted. Inspect startup and recover or cancel the owned task." false
  return 1
}
