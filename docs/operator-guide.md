# Operator guide

- Quickstart and visual overview: [README](../README.md).

Low-context fleet supervision for [herdr](https://herdr.dev): Claude, Codex and
Copilot workers, owned by one orchestrator. Compact TOON output, precomputed
status, bounded task queues and pane-safe control.

## Install

From this private repository; GitHub access required:

```sh
git clone https://github.com/maccie01/herdr-axi.git
cd herdr-axi
npm ci
npm link
herdr-axi --version
```

Requirements: Node.js ≥20, a live Herdr session, authenticated worker CLIs on
`PATH`; Bash, `jq`, `rg`, `uuidgen` and standard Unix utilities for the engine.
`npm link` exposes this checkout globally. Keep Node and the global npm bin
directory on every agent's inherited `PATH`; shell startup files must preserve it.
Managed workers also receive the package's bin directory and `HERDR_AXI_BIN` fallback.
Set `HERDR_BIN` to select a specific Herdr binary. No global agent instruction
files are changed.

## Start a managed run

Run from the **orchestrator's own Herdr pane**. Pass the task inline: bounded
scope, acceptance criteria, required checks. No project task document needed.
Start directly with `run init`: no fleet, config, environment or layout preflight.
It resolves the owner, loads policy and returns worker roles plus queue syntax.
For a read-only investigation, choose an `access: read` role and `--area .`.

```sh
herdr-axi run init --project /path/to/project
export HERDR_AXI_RUN='/path/returned/by/init'
herdr-axi run phase build
herdr-axi run queue parser --role implementer --cwd /path/to/worktree \
  --area src/parser --prompt 'Fix parser edge cases; run parser tests; report checks.'
herdr-axi run next
```

`next` reserves available slots and starts eligible workers concurrently; matching
accepted workers can be reused. Worker tabs: `<task-id> · <kind>`, 75% agent / 25%
monitor by default. Keep `HERDR_AXI_RUN` in subsequent calls.
Long assignments: `--prompt-file /external/task.txt` instead of `--prompt`.

**While workers run, continue independent work.** Use `run inbox` for results,
`read` for a specific diagnosis—not repeated inbox/read/status polling.

| Situation | Next action |
| --- | --- |
| Independent work available | Continue it |
| Harness supports background jobs with guaranteed completion delivery | Arm **one** `herdr-axi watch --timeout-ms 1800000`; retain its handle; handle the notification, then re-arm if needed |
| No verified callback; worker result now a dependency | Blocking `herdr-axi watch` |
| `reason:timeout` | No relevant change; not completion |
| `reason:attention` or `reason:state-change` | Act on the returned state/help |

**Notification limit:** managed end hooks currently save durable inbox receipts;
they do **not** push into the orchestrator conversation. A shell PID, detached `&`
or Herdr toast does not guarantee an agent wakeup. `watch` defaults to 30 seconds;
`run watch` is an equivalent alias. One active watcher per run; duplicates fail
with `WATCH_ACTIVE`. Watch collects late completion proofs and includes review reports—no separate
inbox fetch needed. Act on returned help, then continue independent work.

**Subscription/session exhausted:** `fleet`, `run inbox`, `watch` and visible `read`
recognize explicit quota errors, including Copilot's monthly-quota message even
when its terminal reports `idle`. A tracked `watch` returns attention plus switch
commands; it does not require a completion hook. No automatic provider/billing change.
Managed hooks also record quota errors as generation-bound inbox errors, including
when no completion proof exists. Detection is wording-based, not a subscription API:
monthly quota, session limit, and “You've hit/reached your [usage/session/weekly/monthly]
limit”. Ordinary retryable rate limits are excluded.

```sh
herdr-axi run switch w1:pP --kind codex --model gpt-5.6-sol --effort high \
  --summary 'Partial implementation; build and review still pending.'
herdr-axi run next
```

Alternatively select `--role <configured-backup-role>` with the same read/write
access. Check that no tools/background jobs remain active. `switch` checkpoints
the original task, bounded terminal history, session identity and Git status before
retiring the old owned tab—**without accepting unfinished work**. Same task, dirty
worktree, dependencies and lease; no WIP commit, stash, reset or new run. Replacement
gets the checkpoint and verifies remaining work; full model context is not restored.
Failed switch: `run switch <task-id>` resumes the saved target. If the original worker
resumed, `run switch <task-id> --cancel` retains it; unavailable/changed identities
fail closed. Four switches/task maximum. Ordinary rate-limit retries are not quota.
Native `unknown` is allowed only with a current quota error; the engine checks it
again before closure. `working` is never closed. Agent and monitor panes must both
be verified absent before the replacement is queued. Retired monitor hints are
removed along with the retired runtime registry. Registry identity stays in the
checkpoint; tombstone and reports stay until `run finish` archives and prunes them.
Native provider sessions, detached jobs and external worktrees are not deleted.
Valid current-generation proof plus native settlement takes precedence over a quota
banner, even before the first hook records completion; the result stays reviewable.
After a completed replacement, same-worker revisions omit the old terminal handoff
tail; a fresh or different parked replacement after worker loss receives the checkpoint again.

### Orchestrator exhausted

Use an **explicitly authorized replacement agent in a separate tab of the same
workspace**. Select the original `HERDR_AXI_RUN`; do not initialize another run:

```sh
herdr-axi run takeover --from w1:pOWNER \
  --evidence 'Authorized handover; remaining work and known background jobs.'
herdr-axi run inbox
```

Takeover requires the old owner's exact identity plus a current quota error, or
verified absence of its pane. Active CLI controls/launchers block transfer; ordinary
controls still run concurrently. Saves a bounded owner checkpoint and ownership
history; keeps tasks, phase, acceptance, receipts and leases. Previous owner loses
CLI control. Neither owner tab is closed, and external jobs are not stopped—inspect
them before overlapping work. Managed workers cannot promote themselves.

No automatic replacement launch, billing change or universal app wakeup. Existing
workers continue recording receipts independently; the replacement reads their inbox.
This is an explicit recovery path, not unattended supervisor failover.

When a result needs review (replace `w1:pP` with the returned worker pane):

```sh
herdr-axi run inbox
herdr-axi read w1:pP                     # only if the summary is insufficient
# Review the actual changes and required checks, then choose:
herdr-axi run accept w1:pP --evidence 'review and test results'
# OR: herdr-axi run revise w1:pP --prompt 'Fix the failing edge case; rerun parser tests.'
```

Acceptance is explicit—not inferred from an idle terminal. Continue with `run next`
or change phase. At the end, `run close <pane>` for each accepted worker, then
`run finish`. Only recorded worker tabs are closed; the owner's tab is excluded.

**Stop unfinished work:** no acceptance or completion proof needed:

```sh
herdr-axi run cancel w1:pP --evidence 'Authorized stop; partial files saved; no background jobs.'
```

Explicitly stops even working agents. Saves a bounded terminal checkpoint and Git
status, closes the **whole owned tab—agent and monitor**, then releases the task's
slot and lease. Also handles a missing agent pane with its monitor still present;
changed identities or extra panes fail closed. No fake acceptance. If interrupted,
repeat `run cancel <task-id>`; checkpoint and reservation remain until verified closure.
Missing agent: terminal capture unavailable, disclosed; existing inbox retained.
Files, native sessions and detached jobs stay untouched. **Cancel/close first; only
then review and remove external worktrees with Git, without force.** Deleting a
worktree does not close its panes. New monitors use the durable run directory as cwd.

## Scope and scheduling

- Address **pane IDs** (`w1:pP`), never titles. Selected runs scope fleet/read/wait
  to owned workers; control checks owner and recorded worker identity.
- No selected run, or `agents --all` / `fleet --all`: **global discovery, not ownership**.
  A listed idle agent is not permission to assign work.
- Delegate through `run queue/next/revise`, not raw `herdr agent` commands or manual
  pane splits. Raw Herdr remains for authorized workspace/worktree/session operations
  outside this wrapper.
- **One writer per canonical worktree**, across runs—even with disjoint `--area`
  values. Separate worktrees for parallel writers. Read-only roles reserve their
  worktree too by default. `--area` is a scope instruction, not a sandbox.
- `--area` is relative to `--cwd`, not the Git root. Use `.` for the entire cwd;
  queue returns the resolved paths before startup.
- `sharedReadWorktree: true`: optional read/write overlap **within one run**;
  instruction-only read access, not enforced isolation. Final verification should
  depend on accepted writer tasks via `--after task-id,task-id`.

**Worktree busy:** a reader is not sandboxed; a subtree is not an isolated worktree.
Do not close or dispatch to the blocking pane. Continue independent work, or move
the queued task: `run move <task-id> --cwd <existing-separate-worktree>`.
Role, prompt, phase, dependencies and relative area stay intact; `next` rechecks
conflicts. Check absolute paths in the preserved prompt before starting.
The conflict response also offers executable Git snapshot commands; these require
permission to change Git metadata. **HEAD only**:
dirty/untracked work is excluded. Not suitable for reviewing in-flight changes.
External worktrees remain yours to remove with Git after worker closure; no force.
Retry `next` only after resolving the constraint, not after another status/read.

| Phase | Default active-task cap |
| --- | ---: |
| `explore` | 4 |
| `build` | 3 |
| `integrate` | 2 |
| `verify` | 2 |
| `fix` | 1 |

Choose phases explicitly: broad independent work first, narrower integration/fixes
later. Override with `run phase <phase> --cap N` (1–16). Starting, blocked, unknown,
lost and unaccepted work retain slots. Narrowing never kills outstanding work;
surplus accepted workers may be retired. Queued tasks keep their phase; accepted
dependencies unlock independently, without a batch barrier. Limit: 128 tasks/run.
The worker pool is also capped: close unused accepted workers if their kind or
policy prevents reuse and occupies a needed slot.

## Command reference

`herdr-axi run --help`: short workflow. `herdr-axi run <action> --help`: one step
only (for example `run queue --help`). `herdr-axi run --help --full`: all run actions.
Other commands: `herdr-axi <command> --help`. There is no standalone `start` command.

| Command | Purpose |
| --- | --- |
| `herdr-axi` / `fleet` | Owned run status; global discovery without a selected run |
| `agents [--state STATE] [--kind KIND]` | Pane IDs, names, kinds and states |
| `run inbox` | Results and attention; includes needed status, summaries ≤600 characters/worker |
| `read <pane>` | Compact visible text; 60 lines / 8000 Unicode characters |
| `read <pane> --raw` | Preserve layout for diagrams, tables and approval menus |
| `read <pane> --full` | Available history; ≤2000 lines, no default character cap |
| `wait <pane> --until idle` | Wait for idle **or done**; report actual `reached` state |
| `dispatch <pane> "task"` | Authorized unmanaged agent: submit and await a post-submit transition |
| `dispatch <pane> --keys down enter` | Explicit UI input; inspect and authorize the dialog first |

Read flags combine: `--full --raw`; `--lines N` / `--chars N` set limits.
Clipping is disclosed. Compact reads remove padding, border-only rows and excess
blank lines, preserving code indentation; `--compact` is a compatibility alias.
History can be unavailable while an agent is working or blocked; prefer visible
reads, or request a file for output beyond retrievable history.

`dispatch` rejects working agents (`AGENT_BUSY`) and managed task prompts
(`MANAGED_DISPATCH`). `--no-wait` confirms **submission only**; an immediate separate
`wait` can match pre-start idle. After a timeout or `PROMPT_STALLED`, inspect before
retrying—never blindly resend.

Output: TOON, bounded diagnostics and next-step hints. Unknown flags fail loudly.
Exit codes: **0** success, **1** error, **2** unknown command.

## Readiness is not completion

| Signal | Meaning |
| --- | --- |
| Agent `working` | Busy |
| Agent `blocked` | Input needed; inspect with `read --raw` |
| Agent `done` → `idle` | Herdr readiness transition; not a retraction of task completion |
| Agent `unknown` | No reliable readiness signal; never completion evidence |
| Monitor `task: review` | Current-generation completion proof; retained across `done` → `idle` |
| Monitor `task: awaiting-proof` | Settled agent without completion proof |
| Task `accepted` | Orchestrator reviewed and explicitly accepted the result |

Herdr state detection can misclassify dialogs; settled agents may still have
background tools running. Check deliverables separately. Trust/approval dialogs
are **never automatically approved**. Failed startup includes a bounded dialog
preview (24 lines / 2400 characters); expand only when insufficient. Updates are
not installed automatically. IPC permission errors identify the execution sandbox,
not a missing server; request permission for the same command instead of restarting Herdr.

| Recovery case | Action |
| --- | --- |
| Startup blocked / `delivery:not_submitted` | `read <pane> --raw`; authorize explicit keys if appropriate; once ready, `run recover <task-id>` |
| Uncertain submission or lost worker | Inspect first; `run recover <pane-or-task-id>` never blindly resends. Requeue requires verified absence of all recorded resources |
| Stop unfinished task / orphan monitor tab | `run cancel <pane-or-task-id> --evidence "authorized stop; partial state/background jobs reviewed"`; not `accept` or worktree deletion |
| Changed/unreadable identity | Control fails closed; diagnostics remain visible. Never adopt a replacement occupant |
| Missing/corrupt result | Retry `run inbox`; if unrecoverable, `run accept <pane> --evidence "review" --result-file FILE` preserves a reviewed replacement (1–3500 characters), still requiring proof and settlement |
| Leftover worktree reservation | `run leases` lists exact files; `run recover <accepted-or-cancelled-task-id>` repairs own terminal-task leases, including archived runs |
| Dead transaction holder | `run unlock` handles only `run.lock`, **not** worktree leases |

Never delete locks or unverifiable leases to force progress. A `committed:true`
response with `maintenance` means state was saved but follow-up cleanup needs attention.
New control markers include process start identity: recycled PIDs do not pin
takeover or archive cleanup. Legacy/unknown live identities remain fail-closed;
errors name the marker and inspection commands. Without `ps`, dead-PID markers
remain reclaimable, but live/recycled identities require explicit inspection.

## Project policy

Track one [`.herdr-axi.json`](../.herdr-axi.json) at the Git worktree root. `run init`
snapshots it; `run config` shows worker roles and current limits (first eight roles,
with an overflow count). `run config --full` shows the complete effective policy,
including native review contracts and owner settings. No config call is required
before queueing. Edits apply to **new runs**.

| Setting | Default / behavior |
| --- | --- |
| `roles.<name>` | `kind`, `model`, `effort`, `access: read\|write` |
| Built-in roles | Codex `gpt-5.6-sol`/high orchestrator; Copilot `gpt-5.6-sol`/high implementer; Claude `opus`/high verifier |
| `roles.<name>.subagents` | Optional `[{role, max, when}]`; read-only leaf reviewers; parent integrates results |
| `nativeSubagentLimit` | 4 reserved native children across pending tasks; separate from primary slots |
| `roles.<name>.contextWindowTokens` | Optional known input-window size; required for Claude/Copilot percentage warnings |
| `phases` | Caps above; explicit workload choices, not inferred project maturity |
| `sharedReadWorktree` | `false` |
| `agentRatio` | `0.75` agent / `0.25` monitor |
| `context` | `warnPercent: 70`, `criticalPercent: 85` |
| `retention` | `detailDays: 30`, `summaryDays: 180` |

The checked-in example pins the verifier to `claude-opus-5` and allows one optional
native verifier per implementer. Model/effort support depends on the installed
runtime; report unavailable contracts rather than silently substituting. The
orchestrator role cannot change an already-running owner's model.

Native children: no recursion or extra Herdr tabs. Child limits and read-only access
are agent instructions, **not an OS security boundary**.

Context and quota share a fair two-probe terminal budget; failed probes rotate too.
Context uses Codex's explicit remaining-context footer or Claude/Copilot's latest
input tokens with a configured window—not cost or cumulative usage. Missing data:
`contextUnknown`; failed/unverified/older-than-120s readings: `contextLastKnown` and
`contextStale`. Only fresh warnings need action. Bounded probes and transcript tails;
warnings never automatically interrupt work.

## History without repository clutter

Private run records live outside Git:
`~/.local/state/herdr-axi/projects/<hash>/runs/<id>`. Override the store with
`HERDR_AXI_STATE_HOME`; `run init --dir PATH` requires an external location.
Records contain prompts and review evidence—keep them private.

Workers receive concise TOON reporting instructions: files, checks, decisions/why,
blockers. No repository plans, progress logs or duplicate reports unless explicitly
requested as deliverables.

| Command | Retained evidence / cleanup |
| --- | --- |
| `run history` | Bounded task and decision summaries |
| `run history --task ID` | Prompt/revision detail; archived history also works outside Herdr |
| `run history --all` | Latest eight managed runs for the selected project |
| `run finish` | Requires accepted/cancelled tasks and closed workers; compresses detail, preserves results/inboxes, removes known runtime files |
| `run gc` | Expires completed managed detail after 30 days, summaries after 180; also runs on init/finish |

Active/locked runs, foreign files and explicit `--dir` records are not age-deleted.
Recovered absent workers retain their identity for inbox archival and runtime cleanup.
Unresolved leases preserve recovery records. Expired detail needs a backup to
recover; increase retention for longer audits.

## Development

```sh
npm test
bash engine/test-herdr-monitor.sh
```

Dependency-free `node:test` regressions plus Bash engine tests; both isolate their
fake backend from the live fleet. Bash lock-identity checks need process inspection
(`ps`), which restrictive sandboxes may block. Historical live evidence and known
limits: [LIVE-TEST.md](../LIVE-TEST.md).

Implementation: [`src/`](../src/) for CLI/run policy; [`engine/`](../engine/) for worker
lifecycle, generation-bound receipts and verified closure. Built with
[`axi-sdk-js`](https://github.com/kunchenguid/axi).

[MIT license](../LICENSE).
