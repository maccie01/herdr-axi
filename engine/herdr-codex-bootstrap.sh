#!/bin/bash

# Codex may publish SessionStart only after its first user turn. This handshake
# is separately journaled input, never the assignment or its completion proof.
herdr_codex_bootstrap_identity() {
  local registry="$1" info="$2"
  jq -e --argjson info "$info" '
    $info.result.agent as $a |
    .stage == "created" and .name == $a.name and .agent_pane == $a.pane_id and
    .tab_id == $a.tab_id and .workspace_id == $a.workspace_id and $a.agent == "codex" and
    (.native_identity.terminal | type == "string" and length > 0) and
    .native_identity.terminal == $a.terminal_id and
    (.native_identity.session == null or .native_identity.session == $a.agent_session.value)
  ' "$registry" >/dev/null 2>&1
}

herdr_codex_bootstrap_observe() {
  local registry="$1" timeout="$2" deadline=$((SECONDS + $2))
  local pane receipt info session state nonce prompt generation temporary checkpoint=false status capture_status attempt=0
  local delays=(0.1 0.2 0.4 0.8 1)
  pane=$(jq -er '.agent_pane' "$registry") || return 2
  receipt=$(jq -er '.receipt_file' "$registry") || return 2
  while true; do
    info=$(herdr agent get "$pane" 2>/dev/null || true)
    if jq -e '.result.agent | type == "object"' <<<"$info" >/dev/null 2>&1; then
      if ! herdr_codex_bootstrap_identity "$registry" "$info"; then
        herdr_engine_error SESSION_IDENTITY_CHANGED "Codex startup identity changed; initialization and assignment were not resent" false
        return 1
      fi
      session=$(jq -r '.result.agent.agent_session.value // empty' <<<"$info")
      state=$(jq -r '.result.agent.agent_status // empty' <<<"$info")
      # An observed session may be recorded for cancellation, but cannot clear
      # an existing bootstrap barrier until its completed transcript is proved.
      if [[ -n "$session" ]]; then
        capture_status=0
        herdr_registry_capture_identity "$registry" || capture_status=$?
        if [[ "$capture_status" == 75 ]]; then
          if (( SECONDS >= deadline )); then break; fi
          sleep 1
          continue
        elif [[ "$capture_status" != 0 ]]; then
          herdr_engine_error SESSION_IDENTITY_CHANGED "Codex native identity could not be captured; no assignment sent" false
          return 1
        fi
        if ! jq -e '.bootstrap != null' "$registry" >/dev/null; then return 0; fi
        if [[ "$state" == idle || "$state" == done ]]; then
          status=0
          nonce=$(jq -er '.bootstrap.nonce' "$registry") || return 2
          prompt=$(jq -er '.bootstrap.prompt' "$registry") || return 2
          generation=$(jq -er '.generation' "$registry") || return 2
          "$HERDR_AXI_NODE" "$script_dir/../src/codex-bootstrap.mjs" "$registry" || status=$?
          if [[ "$status" == 0 ]]; then
            info=$(herdr agent get "$pane" 2>/dev/null || true)
            if ! jq -e '.result.agent | type == "object"' <<<"$info" >/dev/null 2>&1; then
              if (( SECONDS >= deadline )); then break; fi
              sleep 1
              continue
            fi
            herdr_codex_bootstrap_identity "$registry" "$info" || return 2
            jq -e --arg session "$session" '.result.agent |
              .agent_session.value == $session and (.agent_status == "idle" or .agent_status == "done")' <<<"$info" >/dev/null || return 2
            herdr_receipt_lock_acquire "$receipt" || return 2
            temporary=$(mktemp "$registry.bootstrap.XXXXXXXX") || { herdr_receipt_lock_release; return 2; }
            if ! jq --arg session "$session" --arg nonce "$nonce" --arg prompt "$prompt" --arg generation "$generation" '
              if .stage == "created" and .generation == $generation and .bootstrap.schema == 1 and
                .bootstrap.nonce == $nonce and .bootstrap.prompt == $prompt and .native_identity.session == $session then
                .bootstrap.state="settled" | .bootstrap.session=$session
              else error("initialization checkpoint changed") end' "$registry" > "$temporary"; then
              rm -f "$temporary"; herdr_receipt_lock_release; return 2
            fi
            mv -f "$temporary" "$registry" || { rm -f "$temporary"; herdr_receipt_lock_release; return 2; }
            herdr_receipt_lock_release
            return 0
          elif [[ "$status" != 1 ]]; then
            herdr_engine_error CODEX_BOOTSTRAP_PENDING "Initialization evidence is invalid; inspect or cancel the owned worker. No assignment sent and no initialization retry." false
            return 1
          fi
        fi
      elif [[ "$state" == idle || "$state" == done ]]; then
        # Persist sending before input. A crash on either side of the backend
        # call must leave an observe-only checkpoint, never replayable input.
        herdr_receipt_lock_acquire "$receipt" || return 2
        checkpoint=false
        if ! jq -e '.bootstrap != null' "$registry" >/dev/null; then
          nonce=$(uuidgen | tr '[:upper:]' '[:lower:]')
          prompt="Initialization handshake only. Do not use tools, read or change files, start agents, or perform any task. Reply exactly HERDR_AXI_READY_${nonce} and then stop."
          temporary=$(mktemp "$registry.bootstrap.XXXXXXXX") || { herdr_receipt_lock_release; return 2; }
          if ! jq --arg nonce "$nonce" --arg prompt "$prompt" '
            if .stage == "created" and .native_identity.session == null and .bootstrap == null then
              .bootstrap={schema:1,nonce:$nonce,prompt:$prompt,state:"sending"}
            else error("initialization checkpoint changed") end' "$registry" > "$temporary"; then
            rm -f "$temporary"; herdr_receipt_lock_release; return 2
          fi
          mv -f "$temporary" "$registry" || { rm -f "$temporary"; herdr_receipt_lock_release; return 2; }
          checkpoint=true
        fi
        herdr_receipt_lock_release
        if [[ "$checkpoint" == true ]]; then
          info=$(herdr agent get "$pane") || return 2
          herdr_codex_bootstrap_identity "$registry" "$info" || return 2
          jq -e '.result.agent | (.agent_session.value == null or .agent_session.value == "") and
            (.agent_status == "idle" or .agent_status == "done")' <<<"$info" >/dev/null || return 2
          # Backend acknowledgement is activity evidence only. The completed
          # native nonce turn below is required even when this call succeeds.
          herdr agent prompt "$pane" "$prompt" --wait --until working --until blocked \
            --timeout 15000 >/dev/null 2>&1 || true
        fi
      fi
    fi
    (( SECONDS < deadline )) || break
    sleep "${delays[$attempt]}"
    if (( attempt < 4 )); then attempt=$((attempt + 1)); fi
  done
  herdr_engine_error CODEX_BOOTSTRAP_PENDING "Initialization has not been verified; actual assignment not submitted. Recover to observe its existing nonce turn, or cancel. Initialization input is never resent." false
  return 1
}

# Storage, parsing and revalidation failures still leave a durable startup
# checkpoint. Keep their public outcome explicit instead of a bare shell exit.
herdr_codex_bootstrap() {
  local result=0
  herdr_codex_bootstrap_observe "$@" || result=$?
  if [[ "$result" == 2 ]]; then
    herdr_engine_error CODEX_BOOTSTRAP_PENDING "Initialization checkpoint could not be verified; actual assignment not submitted. Inspect or cancel; initialization input is never resent." false
    return 1
  fi
  return "$result"
}
