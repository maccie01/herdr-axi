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
herdr-axi watch                        # selected run: bounded wait for changes
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

## Owned, phased orchestration

Initialize once from the orchestrator's pane, then keep `HERDR_AXI_RUN` in its
shell environment. The directory is a private run record, not a project-global
singleton; two orchestrators in the same workspace can use different runs.

```sh
herdr-axi run init --project /path/to/project
export HERDR_AXI_RUN=<returned-external-run-directory>
herdr-axi run queue parser --role implementer --cwd /path/to/worktree \
  --area src/parser --prompt-file /path/to/parser-task.txt
herdr-axi run next
herdr-axi watch
herdr-axi run inbox
herdr-axi read <returned-pane-id>
herdr-axi run accept <returned-pane-id> --evidence "review and test results"
herdr-axi run phase integrate
```

`init` resolves the caller via `HERDR_PANE_ID` or `herdr pane current --current`.
An optional `--owner` must match that caller. Focus is never used. Run mutations
verify owner identity; reads/waits/keys resolve only owned workers. Pane, tab,
workspace, backend name, terminal and available session IDs prevent accidentally
operating on a replaced occupant. The owner and its tab are excluded from control.
`agents --all` / `fleet --all` are explicit global listings, not permission to
dispatch outside the run. Without a selected run, the original manual fleet
commands remain available; initialize a run before orchestrating.

| Phase | Default simultaneous assignments |
| --- | ---: |
| explore | 4 |
| build | 3 |
| integrate | 2 |
| verify | 2 |
| fix | 1 |

Adjust with `run phase <phase> --cap N` (1–16). These are explicit workload
choices, not an automatic estimate of project maturity. Start wide only for
independent, bounded assignments; narrow as integration and fixes converge.
Tiny tasks are usually faster locally. Put scope, acceptance criteria and required
checks in each prompt. `--area` is one write subtree relative to `--cwd`. Writers
serialize across the entire canonical Git worktree, even for disjoint areas or
different subdirectories. Cross-run writer leases enforce the same rule. Use
separate worktrees for parallel work. By default read-only roles also reserve
their worktree: an instruction is not a sandbox. `sharedReadWorktree: true` opts
into instruction-only verifier overlap, accepting the risk of accidental writes; final
verification should depend on the writer's acceptance (`--after`). Existing
unmanaged agents in the same workspace/worktree conservatively block new writers.
The area is scheduling metadata and a worker instruction, not a filesystem sandbox.

`next` atomically reserves capacity, then starts eligible workers concurrently.
Startup, blocked/unknown/lost work and finished-but-unaccepted results occupy slots.
`--after task-id,task-id` requires explicit acceptance of those dependencies.
Independent tasks can advance without a global batch barrier. Queued tasks keep
their phase; return to that phase or cancel/requeue explicitly. Runs hold at most
128 task records; status previews at most eight queued IDs when no work is active.

Accepted workers are reused by kind, cwd and role/model policy. The pool also has a cap: close unused
accepted workers when a different kind needs their slot. Narrowing a phase retires
surplus accepted workers, but refuses to narrow below outstanding work. It never
kills work to satisfy a cap. `run revise <pane> --prompt-file <fix-task>` rejects a
finished result and gives its bounded fix to the same worker, keeping the slot.
Native subagents are disabled unless a role explicitly allows bounded read-only
leaf reviewers. They consume a separate reservation budget, not primary review
slots; parents integrate results. No recursive delegation or extra Herdr tabs.
Managed worker environments reject nested `run init`. Native child limits and
read-only role access are instructions, not runtime-enforced resource/sandbox limits.
If a runtime cannot select the exact child model/effort, report unavailable rather
than substituting. Raw/native tools can bypass these conventions;
the wrapper is an orchestration guardrail, not a security boundary.

Completion hooks write a generation-bound inbox instead of typing into the owner.
`run inbox` pulls only the latest assistant result (at most 600 characters/worker)
and reconciles late proofs when hooks preceded idle/session detection. Events stay
visible until acceptance. `watch` returns on a change or actionable state, or after
30 seconds with `changed:false`; it does not claim the task completed. Repeat only
while work remains. Empty finished runs report `complete:true`.

Managed prompts go through `queue`/`next` or `revise`, preserving receipt generations
and budgets. `dispatch --keys` remains available for inspected dialogs. Startup
trust dialogs remain open; inspect with `read --raw`, explicitly answer only an
authorized dialog, then `run recover <task-id>` resumes that same startup. No
dialog is automatically approved. Startup acknowledges a post-submit transition
within 15 seconds instead of waiting for the whole task to finish.

A blocked startup returns `blocked`, `submitted:false` and pane-specific read/recovery
commands. Fleet/watch report `delivery:not_submitted`; live `blocked` takes priority
even while the launcher is still `starting`. After explicit approval and readiness,
recover the same worker. A trust dialog is detected, not automatically accepted.

Worker tabs use readable `<task-id> · <kind>` labels, updated on worker reuse.
Internal unique agent IDs remain unchanged. Cosmetic rename failures are reported
separately and never turn acknowledged work into uncertain delivery.

An ambiguous submission remains `uncertain`; inspect it before `run recover
<pane-or-task-id>`. Recovery never blindly resends an uncertain prompt. A crashed
launcher can be recovered after its process exits. If the recorded tab and all
recorded panes are verified absent, recovery requeues the task; `next` is still a
separate action. If a lost worker's tab remains, inspect it and explicitly clean
up only its recorded resources first. Missing registry or unreadable resource
identity fails closed. `run unlock` releases only a dead process's short transaction
lock; an interrupted unlock itself requires inspecting `run.unlock` manually.
Status degrades identity drift to `lost` and keeps its slot reserved; unrelated
workers remain observable. Control never adopts a replacement session automatically.
Inbox collection errors are isolated per worker and bounded to eight diagnostics.

Failed queue transactions roll back acquired leases; an interrupted reservation
can be reclaimed only by its same queued task. Lease release follows durable state
publication. `run recover <accepted-or-cancelled-task>` repairs a leftover lease
without touching panes. Worker publication retries a busy transaction for up to
five seconds, never rerunning startup or prompting. Persistent failures return
`delivery:record_pending` and recovery instructions; the registry remains discoverable.

`run close <pane>` requires acceptance and the matching generation's completion
proof. The engine verifies tab/pane identity, refuses extra unregistered panes,
closes the recorded tab, then verifies disappearance. Workspace-wide close and
name-based public control are deliberately absent. A saved run may contain prompts
and review evidence; keep its directory private.

### Project policy, context and clean history

Track one `.herdr-axi.json` at the Git worktree root. `run init --project PATH`
loads it once; `run config` shows the effective snapshot. Changes apply to new
runs, never silently change an active worker. This repository includes an example
policy: Codex Sol/high orchestrator, Copilot Sol/high implementer, Claude Opus 5/high
verifier, optional one native verifier per implementer. Model strings pass through
to the selected CLI; availability/authentication remains runtime-specific. The
orchestrator setting describes how to launch an owner; it cannot change an
already-running owner's model. `--kind` remains an explicit legacy worker option.

| Config key | Meaning / default |
| --- | --- |
| `roles.<name>` | `kind`, `model`, `effort`, `access: read\|write` |
| `roles.<name>.subagents` | Optional `[{role, max, when}]`; read-only leaf roles only |
| `roles.<name>.contextWindowTokens` | Optional known input-window size; never guessed |
| `nativeSubagentLimit` | Maximum reserved native children across pending tasks; 4 |
| `sharedReadWorktree` | `false`; explicit instruction-only read/write overlap opt-in |
| `phases` | Primary caps: explore 4, build 3, integrate 2, verify 2, fix 1 |
| `agentRatio` | Original agent pane share, 0.75; lower monitor pane 0.25 |
| `context` | `warnPercent: 70`, `criticalPercent: 85` |
| `retention` | `detailDays: 30`, `summaryDays: 180` |

Context warnings use Codex's explicit `Context N% left` footer or the latest
Claude/Copilot input-token count divided by a configured window. No cost, weekly
quota, or cumulative token totals. Missing telemetry is `contextUnknown`, never
healthy zero. Probes: at most two terminal reads per status call, 1s each, 15s shared
cache; local transcript tails do not consume that backend budget. No background
daemon or per-poll full transcript scan. Native transcripts
are bounded to their last 128KB and require matching available session metadata.
After 120s, readings count as unknown/stale. Previous warnings remain visible with
`stale:true` and `ageSeconds`; `contextStale` exposes coverage lag in large/slowly
polled fleets. No stale value is presented as a fresh health measurement.
Warnings advise a safe checkpoint/review/replacement, never interrupt or kill work.

Run state defaults outside Git: `~/.local/state/herdr-axi/projects/<hash>/runs/<id>`.
Override the private store with `HERDR_AXI_STATE_HOME`; use `--dir` only for an
explicit external location. Prompts, generation receipts, revisions and decisions
stay there. Workers receive concise TOON output instructions, no repository plans,
progress logs or state documents unless explicitly requested as deliverables.

`run history` returns at most eight task summaries and eight lifecycle events;
`--task ID` adds bounded prompt/revision detail; `--all` lists the project's latest
eight managed runs. Acceptance retains evidence, latest result and available Git
HEAD (not a claim that uncommitted changes were committed).
Archived history works outside Herdr too; select the external run directory with
`HERDR_AXI_RUN`. No live orchestrator or worker process required.

After acceptance and closing all workers, `run finish` compresses full run detail,
keeps a compact summary and removes known runtime files. Unknown files are retained.
Finished runs become read-only. Automatic collection on init/finish (or `run gc`)
expires only managed completed archives: details after 30 days, summaries after
180 days; configure longer retention when needed. Expired detail is not recoverable
without a backup. Active runs, locks, foreign files and explicit `--dir` records are
never age-deleted. This is task provenance, not a permanent transcript/audit vault.
Writer leases deliberately fail closed after an unrecorded crash: inspect the run
and actual workers before manual lease recovery; never erase locks to force progress.

Worker tabs receive the package's CLI directory on `PATH` plus `HERDR_AXI_BIN`
as an absolute fallback. Global npm installation still exposes `herdr-axi` from
any directory; custom shell startup files must not discard that PATH. No global
Claude/Codex/Copilot instruction files are modified.

The old `watch <engine args>` passthrough is replaced by bounded run monitoring.
The Bash scripts remain lower-level implementation/compatibility surfaces; use
`run` for ownership, budgets, phased scheduling and safe pane-ID commands.

## Engine internals

`engine/` holds the bash supervision layer — orchestrator, worker, lifecycle
monitor, hook notifier, and receipt library — with its own test suite
(`engine/test-herdr-monitor.sh`). The CLI is a front-end; the engine
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
