# herdr-axi

Agent-ergonomic CLI for [herdr](https://herdr.dev) fleet supervision and orchestration,
built on the [AXI](https://github.com/kunchenguid/axi) principles.

Wraps the `herdr` CLI with TOON output, pre-computed fleet aggregates, structured
errors with exit codes, and next-step suggestions — so an agent supervising a fleet
spends tokens on decisions, not on parsing.

## Install

```sh
npm install -g herdr-axi
```

Requires `herdr` on PATH and a live herdr session. Set `HERDR_BIN` to point at a
specific binary.

For a local checkout, install dependencies with `npm install`, then run `npm link`
from the repository. This exposes the checkout through the global npm bin
directory; subsequent edits are immediately available from any working directory.
Keep the directory containing both Node and `herdr-axi` on the PATH inherited by
agent processes (on this Mac: `/opt/homebrew/bin`). Verify from another directory:

```sh
command -v herdr-axi
herdr-axi --version
herdr-axi read --help
```

Agents should use the CLI's `--help` for the short workflow and `<command> --help`
for details. The existing Claude/Codex instructions and Copilot session-start hook
already direct agents here. No per-project copy or global instruction rewrite is
needed. A process with a custom PATH excluding the npm bin directory must have
its launch environment corrected; a global install cannot override that PATH.

## Use

```sh
herdr-axi                              # live fleet state — no args needed
herdr-axi agents --state blocked       # filter by state or --kind
herdr-axi fleet                        # counts + blocked/working/idle in one call
herdr-axi read w1:pP --lines 40        # visible output, truncated, --full to expand
herdr-axi read w1:pP --raw            # exact viewport layout, within output limits
herdr-axi read w1:pP --full --raw     # available history with layout preserved
herdr-axi dispatch w1:pP "run tests"   # submit and wait until settled
herdr-axi dispatch w1:pP --keys enter # explicit UI input after inspecting a dialog
herdr-axi wait w1:pP --until idle      # block on a state transition
herdr-axi watch                        # bash supervision engine (receipts, lifecycle)
```

**Agents are addressed by pane id** (`w1:pP`), not by name. Names are terminal
titles containing spaces; every suggestion this CLI emits is a runnable command.

## Design notes

| AXI principle | Here |
| --- | --- |
| Content first | bare `herdr-axi` prints fleet state, not help |
| Minimal schemas | 4 fields per agent, not the 15 herdr returns |
| Pre-computed aggregates | `fleet` answers "what needs me?" in one call |
| Structured errors | `UNKNOWN_AGENT`, `AGENT_BUSY`, `INVALID_STATE`, `UNKNOWN_FLAG`; exit 0/1/2 |
| Fail loud | unknown flags are an error, never a silent no-op |
| Truncation | `read` defaults to 60 lines / 8000 characters; `--full` expands |
| Contextual disclosure | every result ends in runnable next steps |

`dispatch` refuses an agent that is already working rather than interleaving prompts.

`dispatch` uses Herdr's native prompt wait, which requires a lifecycle change after
submission. `--no-wait` confirms submission only: an immediate standalone `wait`
can still match the state from before work started. Do not automatically resubmit
after a timeout or `PROMPT_STALLED`; read the pane first.

`wait --until idle` accepts both `idle` and `done`: Herdr uses `done` for unseen
background completion. The result reports the actual state in `reached` and the
requested state in `requested`. `blocked` requires input; `unknown` is not evidence
of completion. State detection comes from Herdr and can misclassify UI screens
(for example, a Codex folder-trust dialog reported as idle). A settled agent may
still have background tools running; verify task results separately.

Normal prompts cannot answer approval menus. Inspect controls with `read --raw`;
after deciding the action is authorized, `dispatch <pane> --keys down enter` sends those
explicit keys and returns immediately. It never automatically approves a dialog.

`read` returns the last 60 visible lines (or `--lines N`), capped at 8000 Unicode
characters (or `--chars N`), and discloses each limit that clipped output.
`--full` requests available unwrapped history, capped at 2000 lines with a limit
notice when exceeded, and removes the default character cap. Herdr may need to
scroll an idle alternate-screen agent to retrieve history; while it is working
or blocked, use a normal visible read with a larger `--chars N` if needed.
Explicit `--lines` and `--chars` apply with `--full` too; history never exceeds
2000 lines. Truncation hints preserve `--raw` and avoid history reads when a
larger visible read suffices.
Unrecoverable history requires asking the agent to write its response to a file.
All reads honor `HERDR_BIN` and surface backend failures.

Reads compact by default: border-only rows, right padding, and repeated blank
lines are removed. Text and code indentation remain; diagram borders and terminal
layout may change. Use `--raw` for diagrams, tables, or approval-menu layout.
Raw preserves padding and blank rows within the selected line/character limits;
it does not mean unlimited output or ANSI escape sequences.
`--full --raw` also preserves soft wraps; compact history uses unwrapped rows.
Compaction precedes the character cap, so padding does not consume the budget.

| Read | Formatting | Source |
| --- | --- | --- |
| `read <pane>` | Compact | Visible viewport |
| `read <pane> --raw` | Preserved layout | Visible viewport |
| `read <pane> --full` | Compact | Available history |
| `read <pane> --full --raw` | Preserved layout | Available history |

`--compact` remains a compatibility alias for the default. Combining it with
`--raw` is an error. Boolean flags take no value (`--raw=false` is rejected).
When compaction removes all content, the result says layout-only and suggests
`--raw`, rather than claiming the pane was empty.

Bare `herdr-axi` and `fleet` show pane IDs by state, including `done` and `unknown`.
Use `agents` for titles and kinds. Fleet and agent listings suggest one action,
prioritizing blocked, unknown, done, working, then idle.

Dispatch receipts include `pane`, `submitted`, and (when awaited) `state`; they
do not echo the task or title. Wait receipts include `pane`, `requested`, and
`reached`, without duplicating the observed state. These are output-schema changes
from the initial release; consumers of `task`, `dispatched`, `agent`, or wait's
`state` should use the command input and pane ID instead.

Measured UTF-8 output bytes on fixed fake-backend inputs (not token counts):

| Output | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| 13-agent fleet | 532 | 287 | 46% |
| Submission of a 10,000-character task | 10,188 | 133 | 99% |
| Padded terminal, compact formatting¹ | 10,360 | 460 | 96% |
| Settled wait | 142 | 82 | 42% |

¹ Measured when compact formatting was opt-in; it is now the default.

## Engine

`engine/` holds the bash supervision layer — orchestrator, worker, lifecycle
monitor, hook notifier, and receipt library — with its own test suite
(`engine/test-herdr-monitor.sh`, 30 cases). The CLI is a front-end; the engine
remains the source of truth for receipts, generation binding, and close
verification.

```sh
cd engine && HERDR_ENV=1 ./test-herdr-monitor.sh
```

The dependency-free JavaScript regressions run with `npm test` (`node:test`).
Both suites isolate their fake backend from the live fleet. The bash suite needs
process inspection (`ps`) for its lock-identity tests; restrictive sandboxes may
cause those checks to fail closed.

## Prior art

- [firstmate](https://github.com/kunchenguid/firstmate) — agent-crew distro; its
  `docs/herdr-backend.md` is the reference for herdr submit and liveness mechanics.
- [axi-sdk-js](https://github.com/kunchenguid/axi) — the SDK this is built on.

## License

MIT
