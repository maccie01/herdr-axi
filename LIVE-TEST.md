# Live test — 2026-09-04

Baseline: `5f2a681`; globally installed CLI symlinked to this checkout.
Scratch repository: `/private/tmp/herdr-axi-live.l79XLB`; branch `axi-live-test`.

## Owned resources

| Kind | Pane | Tab | Cleanup |
| --- | --- | --- | --- |
| Claude | `w1B:p3` | `w1B:t3` | Tab closed during wait |
| Codex | `w1B:p4` | `w1B:t4` | Agent exited with Ctrl+D during wait; tab closed |
| Copilot | `w1B:p5` | `w1B:t5` | Agent stopped with tab closure |

Original fleet: 13 agents. Final fleet: same 13 pane IDs. No input or closure
directed at any original pane. All agent interaction through `herdr-axi`;
raw Herdr used for startup, tab creation, closure, and topology verification.

## Live checks

| Check | Claude | Codex | Copilot |
| --- | --- | --- | --- |
| Initial folder trust | `blocked` | **Incorrectly `idle`** | `blocked` |
| Exact branch output | `axi-live-test` | `axi-live-test` | `axi-live-test` |
| `--no-wait` submission | Returned before completion | Returned before completion | Returned before completion |
| `wait --until working` | Passed | Passed | Passed |
| Second prompt while working | `AGENT_BUSY` | `AGENT_BUSY` | `AGENT_BUSY` |
| 100 ms completion wait | `TIMEOUT` | `TIMEOUT` | `TIMEOUT` |
| Scratch file contents | `hello`, `finished` | `hello`, `finished` | `hello`, `finished` |
| Background settlement | `done`; shell could still run | `done` | `done`; approval answered first |
| Repeated guarded dispatch | New marker verified | New marker verified | New 90-line response verified |
| Visible / full history | 55 / 73 lines | 55 / 66 lines | 57 / 141 lines |
| `--lines 5` | 5 lines + truncation hint | 5 lines + truncation hint | 5 lines + truncation hint |

Copilot long-response check: 49 numbered labels visible; all 90 recovered by
`--full`. Full-history reads while Copilot was blocked or working failed upstream;
visible reads remained usable. Both mid-wait disappearance checks returned
`UNKNOWN_AGENT`, exit 1, rather than waiting out the deadline.

## Fixes

| Fault | Change |
| --- | --- |
| Unsupported backend `--timeout-ms`; comma-joined wait states | Native `--timeout`; repeated state flags |
| Syntax error mislabeled `TIMEOUT`; stderr JSON left encoded | Decode error envelopes and distinguish error codes |
| Separate prompt and wait could match pre-submission idle | Native `agent prompt --wait` transition tracking |
| Idle-only wait missed background `done` | Idle wait accepts `done`; reports actual reached state |
| Post-wait polling could observe a different transition | Use native result's agent snapshot |
| Read bypassed `HERDR_BIN` and ignored failures | Shared backend adapter, including text mode |
| Backend pre-truncation hid truncation metadata | Request one extra line; bound returned output |
| Full read still used only the viewport | Available unwrapped history; disclosed 2000-line cap |
| Blocked menus suggested unusable text dispatch | Explicit `dispatch --keys`; inspect before answering |
| Suggestions used titles with spaces; names accepted as targets | Pane-only targeting and suggestions |
| Done/unknown agents absent from fleet buckets | Both states exposed with next steps |
| Invalid numeric options reached backend or submission | Positive integer validation before input |

No engine changes; no dependencies added. Explicit key dispatch used only for
scratch-folder trust, the displayed scratch write/sleep approval, and test-agent exit.

## Verification and limits

- `npm test`: 16/16 dependency-free `node:test` regressions.
- `bash engine/test-herdr-monitor.sh`: 30/30, real Herdr excluded from test PATH.
- Initial sandboxed bash run: lock-identity failure; unrestricted process inspection
  allowed the unchanged suite to pass.
- `git diff --check`: passed.
- Persistent Codex `unknown`: not reproduced live; fail-closed completion behavior
  covered by fake-backend regression. No title heuristics added to override Herdr.
- Startup Codex trust-screen misclassification: observed upstream limitation,
  documented; inspected and answered explicitly through the wrapper.
- Stale-idle dispatch race: guarded native flow exercised live; exact scheduling
  race not forced. Regression asserts a single transition-aware prompt call and
  no separate completion wait. `--no-wait` deliberately offers no settlement proof.
- Agent settlement: no guarantee that background tools or the requested task
  finished. Scratch outputs verified separately.
- 2000-line cap, malformed backend data, and stalled-prompt errors: synthetic
  regressions; no need to force those conditions in the shared server.
- No live `watch` orchestration or server termination; existing engine behavior
  validated through its isolated suite.
- No npm publication, remote push, or edits to global agent instruction files.
