# Adversarial review: Herdr 0.9 compatibility and integration expansion

Date: 2026-09-12  
Branch: `refactor/herdr-0.9-compat`  
Reviewed head: `d9ee3cc` (`fix: fence Herdr integration session identity`)  
Comparison base: `main` / `6e6ded1`  
Scope at reviewed head: 40 files, +3108/-200

## Executive verdict

The branch is internally ready for review: no known P0 or P1 defect remains in
herdr-axi, 215/215 Node tests and 70/70 shell lifecycle tests pass, the package
manifest is valid, and a generic OpenCode worker completed the full managed
lifecycle against live Herdr 0.9.0.

It is not yet honest to call the expanded provider matrix fully proven. Live
Claude trust blocking behaved correctly, but Codex and Cursor exposed Herdr 0.9
startup/prompt-delivery ambiguity, Pi was blocked by its configured model
endpoint, and the Copilot attempt was invalidated by a harness-owned session
loss. herdr-axi now contains these cases instead of accepting or resending work,
but successful end-to-end execution still needs to be repeated after the Herdr
delivery behavior is fixed or clarified.

Release recommendation:

- **Merge/review candidate:** yes. Automated safety and state-machine evidence is
  complete for the current diff.
- **Publish as “fully verified across all Herdr integrations”:** no.
- **Publish as a fail-closed Herdr 0.9 compatibility release:** only after one
  fresh successful core-provider E2E (prefer Codex or Cursor) confirms that task
  text reaches the intended native session. No tag, push, or npm publish was
  performed during this review.

## What changed

The refactor now uses Herdr 0.9 as the authority for runtime integration
availability and lifecycle signals while retaining herdr-axi's stronger
orchestration invariants:

- Herdr client/server version and protocol compatibility are probed and stored.
- Endpoint generation and event capabilities are represented explicitly.
- Herdr socket events, filesystem receipts, and timer reconciliation share one
  deduplicated wake path; events are hints, never proof of completion.
- Installed integrations are parsed from `herdr integration status`; future
  syntactically valid kinds can be used without a baked-in allowlist.
- Claude, Codex, Copilot, and Cursor retain explicit model/permission policy.
  Generic integrations use their native CLI configuration and reject
  `--model`/`--effort` instead of silently discarding them.
- Integration availability is checked at init, queue, switch, selection, and
  immediately before native launch.
- Submission now requires a stable, non-null native session for every provider.
- Automatic completion requires the same registered terminal/session identity,
  current generation proof, and a bounded provider-specific report source.
- Configured roles whose integration is missing remain visible as warnings and
  in `run config`; they are not silently dropped.
- Direct provider switches require an explicit model for core providers. Direct
  queue defaults and same-role configuration remain intact.
- Bundled Claude/Copilot hooks and Codex notify support remain packaged until
  Herdr core lifecycle delivery has stronger live transition/input/error/proof
  evidence.

Relevant branch commits, oldest compatibility change first:

- `decd1aa` — adapt orchestration contracts for Herdr 0.9
- `3301d28` — align delivery and protocol semantics
- `935167a` — integrate Herdr 0.9 event capabilities
- `08259c6` — stop dual-role test files from re-running their own suite
- `0ee5297` — align monitor fixtures with Herdr 0.9
- `6bf41ce` — derive workers from Herdr integrations
- `f5fb386` — define the managed-worktree isolation contract
- `d9ee3cc` — fence native session identity and close adversarial findings

## Fork-bomb incident and correction

### Root cause

`test/runs.test.mjs` was both a Node test suite and the fake `herdr` executable
used by that suite. It selected its role from a positive verb allowlist. The
Herdr 0.9 refactor added `run init -> herdr status --json`; because `status` was
not in the allowlist, the fake binary fell through into the entire suite.

Each suite created a fixture, the fixture invoked `run init`, and `run init`
invoked the same file as `herdr status`. Every parent blocked in `spawnSync`, so
the chain added one child at a time. The observed run reached 4,148 processes in
39 seconds, alternating between the PATH-provided Node and the Homebrew Node.

### Fix

Commit `08259c6` decides the role by argument count. Any invocation with CLI
arguments is the fake binary; an unknown fake command exits 2 and names the file
and command. It can no longer fall through into the test suite. The same
dual-role correction was applied to all three affected files, even though only
the first one participated in the incident.

The historical post-fix four-file watchdog run lasted 1,300 seconds, peaked at
15 processes, and never tripped its guard. The fresh final suites in this review
also completed normally.

## Adversarial findings and disposition

### Resolved: submission without a stable native session

The first review found that generic integrations and Cursor could proceed with
only a terminal identity. A terminal is insufficient replacement protection:
unrelated startup activity could satisfy a prompt wait and a different native
session could occupy the pane.

`d9ee3cc` adds a universal pre-submission fence. After Herdr reports native
startup, herdr-axi polls identity for a bounded period (10 seconds by default).
If no non-empty session is reported, it exits with
`SESSION_START_UNVERIFIED`, sends no task, creates no monitor, and leaves the
owned tab at stage `created` for inspection/cancellation. Completion independently
requires the same non-null session and rejects terminal, session, or generation
replacement.

### Resolved: unavailable configured roles disappeared

An unknown or unavailable role kind could be omitted from worker choices without
explaining why, potentially making a direct fallback look like the intended
configuration. Init now warns with `role:kind`; compact/full config expose
`unavailableRoles`; a missing direct kind is rejected before availability is
checked. Dynamic future integration kinds remain valid configuration and become
launchable only when Herdr reports them installed.

### Resolved: implicit model substitution on direct switch

`run switch --kind <core>` used to inherit a provider default when no model was
given. It now requires `--model`. This does not break intentional defaults for a
direct queue, nor a switch to a configured role whose model is already explicit.

### Resolved: misleading install advice

Herdr's launchable agent kinds and installable integration targets are not the
same set. Errors no longer manufacture commands such as
`herdr integration install undefined` or recommend an invalid target. They point
to `herdr integration status` and `herdr integration install --help`.

### Resolved: completion-gate duplication and misleading relaxation

The Cursor and generic-integration identity checks in
`engine/herdr-hook-notify.sh` were byte-equivalent and have been collapsed. The
dead generic exception to the non-empty-session gate was removed. The resulting
condition states the real rule directly: visible-output fallback is permitted
only for the exact registered session in an idle/done state with current proof.

### Intentionally retained: provider hooks

The upstream proposal removed bundled Claude/Copilot hooks and Codex notify
configuration. Herdr 0.9 integrations publish useful session/lifecycle state,
but current live evidence does not yet prove that rapid completion, blocked
input, error, and proof-bearing settlement cannot be lost. Removal is deferred;
the package dry-run confirms the assets remain included.

## Automated verification

Fresh verification was run against the exact implementation and fixture contents
recorded in `d9ee3cc`:

| Check | Result |
| --- | --- |
| `npm test` | **215/215 passed**, 0 failed, 258.1 s |
| `bash engine/test-herdr-monitor.sh` | **70/70 passed**, 0 failed |
| Focused late-proof regression set | **8/8 passed** |
| Focused session reuse/recovery set | **6/6 passed** |
| `node --check` for `src/*.mjs`, `test/*.mjs`, `bin/*.mjs` | passed |
| `bash -n` for every shell file under `engine/` | passed |
| `git diff --check` before commit | passed |
| `npm pack --dry-run --json --cache /private/tmp/herdr-axi-npm-cache` | passed; 32 entries, 114,409-byte tarball, 390,446 bytes unpacked |

The lower-level shell suite specifically covers blocked trust startup, missing
integration before allocation, missing native session before submission,
terminal/session/generation replacement, monitor readiness, prompt rejection and
recovery, completion proof, deduplication, lock/process identity, owner-tab
protection, lost workers, rearm, and every configured provider kind.

The final package contains the integration parser, runtime engine, retained
provider hooks, operator guide, impact analysis, roadmap, and managed-worktree
contract. Test files and review artifacts are not packaged.

## Live Herdr 0.9 E2E evidence

Environment observed in both disposable runs:

- client `0.9.0`, server `0.9.0`
- protocol `22`, endpoint protocol generation `1`
- `live_handoff`, `surface_interest`, and `health_check` available
- installed integrations: Pi, Claude, Codex, Copilot, OpenCode, Hermes, Cursor

### OpenCode — successful full managed lifecycle

Run `59f4d1e1`, task `live-opencode`, native session
`ses_f69ec9f56ffeQljrFOr2LDiBFh`:

1. queue and allocation succeeded;
2. Herdr startup returned a stable session;
3. event, filesystem, and timer wake paths reconciled;
4. the worker wrote the exact generation-bound completion proof;
5. herdr-axi collected a bounded result;
6. the result was independently reviewed and accepted;
7. the owned tab was closed and later verified absent.

The task was read-only and reported a clean disposable repository. This proves
the new generic integration path end to end, not merely its parser or fixture.

### Pi — fail-closed on provider endpoint failure

Run `59f4d1e1`, task `live-pi`: Pi started with a stable session but repeatedly
failed to connect to its configured LM Studio endpoint. No generation proof was
created. herdr-axi reported missing proof, did not accept the result, and the
owned worker was explicitly cancelled and verified absent. This is an external
provider configuration failure, not proof of a Pi success path.

### Claude — trust block correctly prevented submission

Run `41c52e87`, task `smoke-claude`: the disposable folder was untrusted. Herdr
returned `agent_not_ready`; the worker remained at stage `created`, no monitor
or task submission was recorded, and cancellation closed the owned tab. This is
the desired safe behavior.

### Codex — Herdr prompt acknowledgement was not delivery proof

Run `41c52e87`, task `smoke-codex`: Herdr's prompt wait matched startup activity,
but the terminal remained at an empty Codex prompt with `0 in / 0 out`. No
completion proof appeared. herdr-axi did not accept completion and did not
blindly resend. The later universal stable-session fence reduces this exposure by
stopping before submission when Herdr has not exposed a session, but the Herdr
prompt acknowledgement/delivery mismatch still needs a successful live retest.

### Cursor — identified session, stalled prompt

Run `41c52e87`, task `smoke-cursor`: startup produced a stable Cursor session,
but `agent prompt` returned `agent_prompt_stalled`. After inspection, one
documented `run recover` was attempted; Cursor remained idle at an empty prompt
with no proof. No further resend occurred. The owned task was cancelled and the
tab was verified absent.

### Copilot — inconclusive harness artifact

Run `41c52e87`, task `smoke-copilot`: the test harness lost the ongoing launcher
session and the owned pane disappeared before submission. herdr-axi reconciled
the missing resource and cancelled the task. This result must not be counted as
either product success or product failure; repeat it with the launcher session
retained by the harness.

## Upstream branch assessment

The new upstream branch `jxn/fix/herdr-integrations` (tip `6408ce9`) was reviewed
against its old merge base `eb94ba9`. It should not be merged or cherry-picked as
a whole. Its integration-derivation idea was selectively adapted, while the
following semantics were rejected or corrected:

- silent deletion of generic `model`/`effort` flags;
- fallback from an unavailable writer to the first configured role, which could
  be read-only;
- direct core-provider switch without an explicit model;
- stale or missing integration visibility in config;
- unconditional removal of bundled lifecycle hooks before live parity evidence;
- textual conflicts in the monitor and dual-role test fixtures that could have
  restored the fork-bomb structure.

The upstream `jxn/dev` branch adds documentation already present in this branch;
there is no additional code worth cherry-picking. The result is a semantic port,
not a cherry-pick, and preserves the newer Herdr 0.9 event/protocol work.

## Managed worktree recommendation

Automatic isolation would materially improve parallel orchestration, but it
should be opt-in and stream-scoped rather than a default “one task, one worktree”
mechanism. The contract is documented in `docs/managed-worktrees.md`; it is not
implemented in this branch.

Recommended ownership split:

- **Herdr owns mechanics:** worktree/workspace create, open, inspect, and remove.
- **herdr-axi owns policy:** task-to-worktree binding, canonical identity,
  reader/writer leases, provenance, reuse, recovery, and cleanup eligibility.
- **Git remains identity authority:** canonical root/common-dir/head checks must
  agree before reuse or cleanup.

Recommended lifecycle:

1. `--isolate` creates or reuses one managed worktree for a logical task stream.
2. Related revisions and handoffs reuse that stream worktree when identity and
   lease checks still match.
3. Independent writers receive distinct worktrees, allowing real parallelism
   without file competition.
4. Readers share only when explicitly allowed by policy.
5. Cleanup is report-first and requires a terminal task state, no live agents or
   leases, a clean worktree, and exact recorded identity.

Never automate `--force`, trust bypass, stash, reset, merge, branch deletion, or
cleanup of an unverified path. A failed or ambiguous check leaves the worktree
intact and produces an operator action. Per-worker workspace identity should be
established before automatic creation; otherwise global workspace assumptions
can make correct worktrees appear foreign or make foreign workers appear owned.

The existing one-writer-per-canonical-worktree lease remains mandatory even
after isolation. Worktrees increase safe concurrency; they do not replace
ownership fencing.

## Remaining risks and next release gate

There are no known internal P0/P1 findings at `d9ee3cc`. Remaining material
risks are integration-level:

1. Herdr 0.9 startup readiness and prompt wait can diverge from actual task
   delivery for Codex and Cursor.
2. Copilot lacks a valid fresh E2E result because the harness lost its launcher
   session.
3. Pi's success path depends on repairing its external model endpoint.
4. Removing bundled provider hooks is not yet proven safe; rapid transition,
   blocked input, error, and completion-proof parity must be demonstrated live.
5. Managed worktrees are a recommended architecture direction, not shipped
   functionality.

Minimum next gate: repeat a disposable queue -> start -> stable session -> actual
prompt receipt -> generation proof -> inbox -> accept -> close sequence on Codex
or Cursor with the current `d9ee3cc` code and Herdr server. Record both the Herdr
session identity and visible task receipt. If that succeeds, the branch is a
reasonable fail-closed Herdr 0.9 release candidate; provider-wide claims still
require the remaining matrix.
