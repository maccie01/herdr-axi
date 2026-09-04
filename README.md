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

## Use

```sh
herdr-axi                              # live fleet state — no args needed
herdr-axi agents --state blocked       # filter by state or --kind
herdr-axi fleet                        # counts + blocked/working/idle in one call
herdr-axi read w1:pP --lines 40        # visible output, truncated, --full to expand
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
| Truncation | `read` defaults to 60 lines with a size hint and `--full` |
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

Normal prompts cannot answer approval menus. After reading the controls and
deciding the action is authorized, `dispatch <pane> --keys down enter` sends those
explicit keys and returns immediately. It never automatically approves a dialog.

`read` returns the last 60 visible lines (or `--lines N`) and discloses truncation.
`--full` requests available unwrapped history, capped at 2000 lines with a limit
notice when exceeded. Herdr may need to scroll an idle alternate-screen agent to
retrieve history; while it is working or blocked, use a normal visible read.
Unrecoverable history requires asking the agent to write its response to a file.
All reads honor `HERDR_BIN` and surface backend failures.

`fleet` includes `done` and `unknown` panes as well as their counts, so neither
disappears from the next-step view.

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
