#!/bin/bash

[[ -z "${HERDR_ENGINE_COMMON_LOADED:-}" ]] || return 0
HERDR_ENGINE_COMMON_LOADED=1

# Honor the same backend override as the JS adapter, including child scripts.
if [[ -n "${HERDR_BIN:-}" ]]; then
  herdr() { command "$HERDR_BIN" "$@"; }
  export -f herdr
fi

herdr_engine_error() {
  local code="$1" message="$2" submitted="${3:-}"
  printf '%s: %s\n' "$code" "$message" >&2
  if [[ "${HERDR_AXI_ENGINE_PROTOCOL:-0}" == 1 ]]; then
    # fd 3 is the parent adapter's dedicated protocol pipe, never stderr.
    { jq -nc --arg code "$code" --arg message "$message" --arg submitted "$submitted" \
      '{schema:1,code:$code,message:$message} +
       (if $submitted == "true" then {submitted:true}
        elif $submitted == "false" then {submitted:false} else {} end)' >&3; } 2>/dev/null || true
  fi
}
