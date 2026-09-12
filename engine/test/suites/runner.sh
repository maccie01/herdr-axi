#!/bin/bash

test_runner_resolves_dependencies_from_incoming_path() (
  setup_case runner-incoming-path
  wrappers="$TMPDIR/wrappers"
  mkdir -p "$wrappers"
  export HERDR_PATH_PROBE="$TMPDIR/dependencies-used"
  export HERDR_PATH_REAL_RG="$(command -v rg)"
  export HERDR_PATH_REAL_JQ="$(command -v jq)"
  export HERDR_PATH_REAL_NODE="$(command -v node)"
  for dependency in rg jq node; do
    case "$dependency" in rg) variable=HERDR_PATH_REAL_RG ;; jq) variable=HERDR_PATH_REAL_JQ ;; node) variable=HERDR_PATH_REAL_NODE ;; esac
    printf '#!/bin/bash\nprintf "%%s\\n" %s >> "$HERDR_PATH_PROBE"\nexec "$%s" "$@"\n' "$dependency" "$variable" > "$wrappers/$dependency"
    chmod +x "$wrappers/$dependency"
  done
  unset HERDR_AXI_NODE
  for wrapper_path in "$wrappers" wrappers; do
    rm -f "$HERDR_PATH_PROBE"
    (cd "$TMPDIR"; PATH="$wrapper_path:$PATH" HERDR_MONITOR_TEST_FILTER=test_worker_provider_defaults_and_explicit_overrides \
      bash "$test_script") > "$TMPDIR/nested-output" 2> "$TMPDIR/nested-error" || fail "nested public runner failed with PATH=$wrapper_path"
    for dependency in rg jq node; do
      rg -qx "$dependency" "$HERDR_PATH_PROBE" || fail "incoming PATH $dependency wrapper was bypassed"
    done
  done
)
