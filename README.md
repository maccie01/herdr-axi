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

## Engine

`engine/` holds the bash supervision layer — orchestrator, worker, lifecycle
monitor, hook notifier, and receipt library — with its own test suite
(`engine/test-herdr-monitor.sh`, 30 cases). The CLI is a front-end; the engine
remains the source of truth for receipts, generation binding, and close
verification.

```sh
cd engine && HERDR_ENV=1 ./test-herdr-monitor.sh
```

## Prior art

- [firstmate](https://github.com/kunchenguid/firstmate) — agent-crew distro; its
  `docs/herdr-backend.md` is the reference for herdr submit and liveness mechanics.
- [axi-sdk-js](https://github.com/kunchenguid/axi) — the SDK this is built on.

## License

MIT
