#!/bin/bash

# Called before allocation. These globals are the worker's normalized budgets.
herdr_startup_config() {
  local variable value
  for variable in HERDR_START_READY_TIMEOUT_SECONDS HERDR_SESSION_READY_TIMEOUT_SECONDS HERDR_MONITOR_READY_TIMEOUT_SECONDS; do
    value="${!variable:-}"
    case "$variable" in
      HERDR_START_READY_TIMEOUT_SECONDS) value="${value:-12}" ;;
      *) value="${value:-10}" ;;
    esac
    # Nine decimal digits bound arithmetic safely on supported 64-bit Bash,
    # without imposing a shorter operational startup policy. Never eval input.
    if [[ ! "$value" =~ ^[1-9][0-9]{0,8}$ ]]; then
      herdr_engine_error INVALID_CONFIG "$variable must be an integer from 1 to 999999999" false
      return 2
    fi
    case "$variable" in
      HERDR_START_READY_TIMEOUT_SECONDS) start_ready_timeout_seconds="$value" ;;
      HERDR_SESSION_READY_TIMEOUT_SECONDS) session_ready_timeout_seconds="$value" ;;
      HERDR_MONITOR_READY_TIMEOUT_SECONDS) monitor_ready_timeout_seconds="$value" ;;
    esac
  done
  bootstrap_timeout_seconds="${HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS:-60}"
  if [[ ! "$bootstrap_timeout_seconds" =~ ^[1-9][0-9]{0,2}$ ]] || (( bootstrap_timeout_seconds > 300 )); then
    herdr_engine_error INVALID_CONFIG "HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS must be an integer from 1 to 300" false
    return 2
  fi
}
