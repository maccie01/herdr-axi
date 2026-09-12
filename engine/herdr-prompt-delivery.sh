#!/bin/bash

[[ -z "${HERDR_PROMPT_DELIVERY_LOADED:-}" ]] || return 0
HERDR_PROMPT_DELIVERY_LOADED=1

herdr_registry_delivery_stage() {
  local name="$1" generation="$2" stage="$3" error="${4:-}" file temporary
  [[ -n "$HERDR_RECEIPT_REGISTRY_DIR" ]] || return 0
  file="$HERDR_RECEIPT_REGISTRY_DIR/$name.json"
  [[ -e "$file" ]] || return 0 # Legacy unmanaged delivery has no registry.
  temporary=$(mktemp "${file}.tmp.XXXXXXXX") || return 1
  if ! jq --arg name "$name" --arg generation "$generation" --arg stage "$stage" --arg error "$error" '
    if .name == $name and .generation == $generation then
      .stage=$stage | if $error == "" then del(.delivery_error) else .delivery_error=$error end
    else error("delivery registry generation mismatch") end' "$file" > "$temporary"; then
    rm -f "$temporary"
    herdr_engine_error GENERATION_DRIFT "Delivery registry generation unavailable or changed: $name"
    return 1
  fi
  if ! mv -f "$temporary" "$file"; then rm -f "$temporary"; return 1; fi
}

herdr_deliver_prompt() {
  local agent_name="$1"
  local task="$2"
  local delivery_marker="$3"
  local prompt_json prompt_status=0 error_code
  HERDR_PROMPT_REJECTED=false
  herdr_registry_delivery_stage "$agent_name" "$delivery_marker" submitting || return 1

  # This call proves delivery activity, not task completion. Herdr 0.9 first
  # requires observed working/blocked activity for a non-working target; then
  # these exact targets let the transient activity satisfy the wait promptly.
  prompt_json=$(herdr agent prompt "$agent_name" "$task" --wait \
    --until working --until blocked \
    --timeout 15000 2>&1) ||
    prompt_status=$?
  if (( prompt_status == 0 )); then
    return 0
  fi

  error_code=$(printf '%s\n' "$prompt_json" |
    jq -r '.error.code // empty' 2>/dev/null || true)
  # Herdr's documented agent_blocked error rejects before sending ANY input.
  # A timeout/stalled prompt is different: never infer rejection from the screen.
  if [[ "$error_code" == "agent_blocked" ]]; then
    herdr_registry_delivery_stage "$agent_name" "$delivery_marker" rejected agent_blocked || return 1
    HERDR_PROMPT_REJECTED=true
    herdr_engine_error PROMPT_REJECTED "agent_blocked; no input sent. Resolve the dialog, then recover this task." false
    return 1
  fi
  if [[ "$error_code" != "agent_prompt_stalled" ]]; then
    herdr_engine_error PROMPT_DELIVERY_UNVERIFIED "herdr prompt failed: ${error_code:-unclassified}; delivery may have occurred"
    return 1
  fi

  # Herdr 0.9 delivers text and Enter as one ordered submission, so a stalled
  # prompt may still have arrived. Fail closed: no keys, no screen inference;
  # the registered tab stays up for manual inspection and recovery.
  herdr_registry_delivery_stage "$agent_name" "$delivery_marker" stalled agent_prompt_stalled || return 1
  herdr_engine_error PROMPT_STALLED "agent_prompt_stalled; no activity observed within the wait window, delivery not proven. Herdr 0.9 sends text and Enter as one submission, so the prompt may have arrived. Inspect manually (herdr-axi read <pane> --raw) and recover the task; no keys were sent."
  return 1
}
