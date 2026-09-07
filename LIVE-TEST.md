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

## Follow-up: owned, phased orchestration

Scratch root: `/private/tmp/herdr-axi-phases.hR3i0I`; active test record `run2/`.
Owner resolved with `herdr pane current --current`: `w1B:p2`, tab `w1B:t2`.

| Kind | Successful pane / tab | Evidence | Cleanup |
| --- | --- | --- | --- |
| Claude | `w1B:pC` / `w1B:tC` | Branch `axi-phase-test`; exact `hello\n`, 6 bytes | Accepted; retired when phase narrowed to fix |
| Copilot | `w1B:pE` / `w1B:tE` | Same branch and exact bytes | Accepted; retired when phase narrowed to fix |
| Codex | `w1B:pH` / `w1B:tF` | Same initial result; reused for exact `hello\nworld\n`, 12 bytes | Accepted; verified close |

All file contents verified independently with `od`; branches checked with Git.
The reused Codex worker rejected a concurrent prompt with `AGENT_BUSY` and its
idle wait returned `reached: done`. Three workers narrowed to one, without a new
tab for the follow-up. Final run: `complete:true`, zero occupied/queued/parked.
Final workspace topology: original `w1B:t1` and owner `w1B:t2` only.
Monitor panes `w1B:pF`, `w1B:pG`, `w1B:pJ` closed with their worker tabs.

Live failures and repairs:

- Themed shell prompts failed the engine's `$#%>` readiness regex: replaced by
  native agent-start availability checks and bounded busy retries.
- Codex 0.153.2 rejected `--approve-for-me` with `--sandbox`: removed the redundant
  sandbox flag; automatic review still selects workspace-write.
- All fresh scratch folders needed trust approval: retained startup dialogs,
  inspected through `read --raw`, explicitly answered only for our directories,
  then resumed the same owned agents without creating replacement tabs.
- Hooks sometimes ran before final idle/session metadata: generation proofs
  existed but receipts were suppressed. Added idle collection and pull-based
  late-proof reconciliation. Initial Claude/Copilot receipts were manually
  collected in inbox-only diagnostic mode; Codex and its follow-up were collected
  through `run inbox`. Neither path typed into the owner.
- Old three-message summaries mixed previous and current assignments: reduced
  native transcript summaries to the latest assistant result.

Failed-start recorded tabs `w1B:t9`, `w1B:tA`, `w1B:tB`, `w1B:tD` were rolled back
and verified absent before retry. The initial three glyph-check failures preceded
early registry persistence; those pre-agent tabs were rolled back too. Ownership
is now recorded immediately after tab creation, before agent startup.

Final automated checks: **30/30 JavaScript**, **36/36 Bash**, `git diff --check`.
New coverage includes concurrent slot reservation, overlapping write areas,
accepted dependencies, worker reuse, revision generations, phase retirement,
startup recovery, ambiguous submission, lost workers, lock recovery, owner-tab
protection, extra unregistered panes, inbox isolation and persistent quiet waits.
No runtime dependency added. Package dry-run included both new run modules;
used a scratch npm cache after the sandbox rejected the default cache write.
Global CLI resolved from `/private/tmp` with the new run help available.

Limits: no large-real-fleet throughput benchmark or full production workload.
Exact races and stale identities remain deterministic fake-backend tests. Mid-wait
death was live-tested in the earlier pass above, not repeated during this run.
Write-area and no-subagent rules are orchestration guardrails, not OS enforcement.
Run selection requires `HERDR_AXI_RUN`; manual unscoped commands retain their
original global behavior. Missing ownership records and unknown identities fail
closed rather than guessing cleanup targets.

Local review surfaces are ignored under `.lavish/`; durable validation evidence stays here.

## Project policy, native reviewers and clean state (same live pass)

Scratch project: `/private/tmp/herdr-axi-config.sz3ESI/project`, branch
`axi-config-test`. Runtime store outside Git, under the scratch root's `state/`.

| Check | Evidence |
| --- | --- |
| 75/25 split | Layout-only `w1B:pM` / `w1B:pN`: 41 / 12 usable rows; tab `w1B:tH` closed |
| Configured implementer | Copilot Sol/high, `w1B:pP`, tab `w1B:tJ`, monitor `w1B:pR` |
| Native reviewer | Actual Copilot `task` call: `model=claude-opus-5`, `reasoning_effort=high`, `agent_type=general-purpose`; no extra Herdr tab |
| Worktree collision | Second writer targeting a different file remained queued; cancelled after test |
| Parallel read-only verifier | Claude Opus 5/high, `w1B:pQ`, tab `w1B:tK`, monitor `w1B:pS`; later revised for final byte/hash verification |
| No doc clutter | Only expected `.herdr-axi.json` and `hello.txt` in Git status; no plans/state/report files |
| Final Codex check | Sol/high, `w1B:pT`, tab `w1B:tM`; branch, six-byte file, shortened proof verified |
| Context warning | Native `Context 95% left` → 5% used, critical under test-only 1%/2% thresholds; weekly 81% ignored |
| Lifecycle cleanup | All owned worker/monitor tabs closed; original `w1B:t1` and owner `w1B:t2` remained |
| Run cleanup | `run finish`: 10 generated runtime files removed; only `run.json` and `detail.json.gz` remained |
| Retrospective | Archived run listed by `history --all`; task prompts, revisions, reviews and available results preserved |

Additional live bug: Claude sometimes emits its structured result before the
proof command, then a short receipt acknowledgement afterward. Latest-message-only
summaries lost the actual result. The hook now prefers the structured report within
the current user turn; a regression rejects previous-task leakage. Oversized inbox
results disclose truncation; detailed result capture remains private and bounded.

Configuration validates unknown keys, roles, read-only leaf delegation, native
budgets, phase caps, layout, context and retention. Run records snapshot the policy;
the existing orchestrator is never restarted or silently switched to a model.
Worktree writer leases span runs; accepted results release leases. Crash ambiguity
fails closed. Worker PATH includes the packaged CLI shim, with an absolute fallback.

Final suites: **36 JavaScript**, **38 Bash** behavioral checks. New coverage:
same-worktree writers versus verifiers, model/effort delivery, shared writer leases,
native budgets/config rejection, nested-owner rejection, bounded cached context
probes, warning wakeup, archive immutability, known-file pruning and aged retention
(active/locked/foreign/symlink data preserved). No new runtime dependencies.

Limits: native child/read-only contracts are agent instructions, not OS enforcement.
Claude/Copilot percentages require configured known context windows; absent data
remains unknown. No large-fleet throughput or multi-month real-time retention test.
The retention checks use deterministic aged fixtures. No global agent instruction
files changed; no npm publish, remote push, or unrelated pane input/closure.

## Follow-up: startup attention and tab labels (5 September 2026)

The reported TLP run's recorded event showed `agent_not_ready` after four seconds;
startup resumed roughly eight minutes later. Detection worked, but the returned
`uncertain` error lacked clear startup-specific actions. During an in-flight
launcher, `starting` also masked native `blocked` in fleet/watch.

- Startup result: `blocked`, `submitted:false`, exact pane read/recovery hints.
- Fleet/watch: native blocked takes priority; current registry stage distinguishes
  unsubmitted startup from resumed submission. No automatic approval or resend.
- Tab label: task ID + kind; stable private IDs retained. Reuse updates the label;
  rename errors cannot corrupt delivery state or trigger duplicate prompts.
- Live scratch: `/private/tmp/herdr-axi-startup.QaJ15B`, pane `w1B:pW`, tab `w1B:tN`.
  Native label `trust-check · claude`; trust dialog detected; watch returned blocked
  immediately. No trust keys or work prompt sent. Owned tab closed, disappearance
  checked, test cancelled and run archived. TLP panes/records were read-only.
- Regression suites: 38 JavaScript / 38 Bash checks; early-registry startup,
  recovery, tab-label creation/reuse and cosmetic-failure delivery isolation.

## Adversarial review follow-up (5 September 2026)

| Finding | Verification / change |
| --- | --- |
| Lease survives failed transaction | Injected failure at run.json publication. Acquisition rollback under the lock; same queued task can reclaim its unlaunched lease after a crash. Release only after durable state; accepted/cancelled recovery repairs residual leases. |
| Identity drift breaks fleet | Replaced saved session identity. Fleet/home/watch/inbox degrade to `lost`; capacity retained, no control of replacement. Parked drift blocks its worktree, not unrelated selections. Malformed early registries also degrade. |
| Failed waits hot-loop | Forced immediate wait failures and repeated notification errors. Exponential backoff 1–30s; real transitions reset it. Quiet supervision persists; a failed terminal lost notification cannot retry forever. |
| Worker publication loses a lock race | Held run.lock after prompt delivery; publication retried without resend. Injected persistent publication failure: `record_pending`, discoverable registry, explicit recover, exactly one prompt. |
| Read-only concurrency lacks enforcement | Confirmed instruction-only, not an OS sandbox. Default worktree reservation now includes read roles; separate worktrees retain parallelism. `sharedReadWorktree:true` explicitly accepts instruction-only overlap. No incompatible native flags added. |
| One collect failure breaks inbox | Forced engine subprocess failure and corrupt inbox JSON. Healthy events remain visible with bounded per-worker errors. |
| Large-fleet context coverage | Simulated 16 workers / 30s polling. Two terminal probes/call retained; stale warnings include age, stale readings remain unknown. Local transcript tails no longer compete for terminal probe budget. |
| Verbose names | Agent projection prefers bounded stable backend name, not command-line terminal title. Readable task tab labels from the previous fix retained. |
| Parallel suite failure | Confirmed inbox-before-receipt assertion race, not shared fixture deletion. Wait for receipt acknowledgement. Explicit fake HERDR_BIN also prevents inherited overrides escaping test isolation. |
| HERDR_BIN waiter cleanup | Parallel stress exposed an intermediate shell-function process: killing it could orphan the actual native waiter. Monitor now invokes/tracks the backend executable directly. JS fake agent records also publish atomically across concurrent startups. |
| Lock cleanup masks error | force removal; regression preserves original error if lock already absent. |

Trust approval remains explicit. Startup reporting was already fixed in `3cfa10f`;
no blanket auto-approval added. Empty successful JSON-command output was not
reproduced against the installed backend; prior live key-dispatch tests succeeded.
Strict JSON validation retained (plain terminal reads already allow empty output).

This pass uses deterministic fault injection, not new live coding agents or user
pane mutations. No production outages, session replacements or worktree conflicts
were induced. No global instruction edits, push or publication.

Validation: 47/47 JavaScript tests; two simultaneously started Bash suites,
39/39 each after the waiter fix. Bash/Node syntax and `git diff --check` clean.

## Second adversarial pass — baseline `2561a65` (5 September 2026)

Fault injection only. No new provider agents; no production pane, tab, run or
global instruction mutations. Prior live-provider observations above are not
claimed as revalidation of this patch.

| Review IDs | Verified failure / correction / regression |
| --- | --- |
| 1, 2, 8 | Post-commit exceptions misreported committed work; corrupt releases threw parser errors; archived lease repair absent. Separate committed maintenance diagnostics, typed `LEASE_UNVERIFIED`, exact-path `run leases`, offline terminal-task recovery, finish repair and GC provenance protection. Empty, partial, null and wrong-shaped leases tested; unknown owners never deleted. |
| 3 | Non-ready parked workers caused opaque queue deferrals. `parkedAttention`, exact blocking pane and read help; unrelated work still advances. Accepted does not authorize closing/reusing a now-working or replaced session. |
| 4 | Real startup has a registry before its native agent row. Fake tab-create now creates only a shell; explicit startup gate verifies `starting` and a genuinely waiting watch. |
| 5, 13, 15 | Failed probes replaced evidence; candidate filtering erased unverified panes; stale warnings caused immediate watch returns. Separate attempt/measurement timestamps; retained last-known evidence; exclusive fresh/stale/unknown categories. Failed Codex/Claude/Copilot probes, generation changes, unverified candidates, 16-worker cadence and waiting watch tested. Two terminal probes/call retained. |
| 6, 11 | Display reparsed full run.json; failed parsing downgraded valid local proof. Tiny atomic task hints after transactions, shell-only display reads. Corrupt coordinator JSON and malformed hints cannot erase receipt evidence; accepted/reused generations remain distinct. No claimed reproduction of the review's GB/hour estimate. |
| 7 | Broad observational catch hid malformed registries and I/O failures. Bounded ownership diagnostics with pane IDs; candidates remain read-only diagnostic suggestions, never adopted control authority. Wrong receipt path and injected EIO tested. |
| 9 | Terminal lost-hook failure exited successfully without delivery. Three attempts with bounded backoff, nonzero exhaustion and durable inbox diagnostic; transient lock-timeout succeeds on attempt three. |
| 10 | Acceptance discarded unreadable reports. Missing/corrupt/wrong-generation reports now block acceptance. Explicit reviewed replacement file possible, provenance marked; completion proof still mandatory. Archive retains raw owned inboxes as well as task results. Qualification: compressed detail already existed before this pass; run.json was not literally the only archive. |
| 12 | Opt-in readers bypassed the cross-run lease protocol. Every participant now registered; shared holders only within one owner run, serialized by its existing short lock. Other runs excluded regardless of config; visible foreign-workspace workers also block. No new global lock or cross-run sharing protocol; separate worktrees remain parallel. |
| 14 | Cosmetic rename preceded durable publication and checked the old identity. Publication first, new verified session, 750ms per cosmetic backend call. Slow rename and session-rotation regressions verify this ordering. |

Mutation checks in a disposable copy: post-commit throw, premature startup `lost`,
failed-probe overwrite and constant retry delay each fail their targeted regression.
The backoff test asserts requested delays `1,2,4,8,16,30,30`, not a loose attempt
ceiling. The original checkout remained unmutated during these checks.

Compatibility limits: existing monitor processes do not hot-reload; legacy active
opt-in readers that never recorded leases cannot be retroactively registered
without inspecting their owners. New runs use the corrected protocol. Trust
approval and instruction-only verifier access remain explicit, not security sandboxes.

### Agent guidance follow-up

Screenshot reproduced a documentation escape route: top-level help explicitly
suggested raw `herdr agent start --help` for startup/layout, while discovery could
suggest dispatching an arbitrary idle pane. Removed both recommendations. Bare
home, agents and global fleet now label `global-discovery; ownership not implied`
and direct new delegation to `run init → queue → next`. Startup/layout belongs
to `run next`; worker contracts forbid raw startup and manual worker-pane splits.
Regression covers empty/idle discovery, help without backend reads, and no unsafe
dispatch/start suggestions. Explicitly authorized unmanaged control remains available;
the wrapper cannot prohibit direct use of another executable. No global instructions
or existing agent sessions changed. Global CLI symlink resolves to this checkout.

Final validation: `npm test` 57/57; `bash engine/test-herdr-monitor.sh` 41/41
in one standalone run and both simultaneous runs. Four intentional mutations
rejected. Bash/Node syntax and `git diff --check` clean. Temporary mutation copy
removed; no live-agent cleanup required because none were started in this pass.

## Empty-inbox polling loop (5 September 2026)

Reproduced the reported `inbox → read working pane → inbox` guidance against the
fake backend. Empty working inboxes now return pending counts and independent-work
guidance, without suggesting another read/inbox. Existing reports lead to review
and acceptance/revision; working reads identify themselves as diagnostics, not results.
Quiet watch timeouts remain under 400 bytes and use `reason:timeout`; actionable
states use `reason:attention/state-change`. Historical telemetry changes do not
wake watch; new warning levels and generation-bound completion still do.

Notification boundary, not a completed push integration: current managed hooks
write inboxes only. Installed `herdr notification show --help` exposes a UI toast,
not a target-agent context callback. Codex's documented `notify` is an outgoing
command receiving Codex events ([official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
No universal incoming-agent wakeup was established by these checks. Help now requires
one harness-native tracked background watch with confirmed completion delivery
before promising notification. No detached processes, UI-toast substitution, or
input injection into live orchestrators. A provider-specific wakeup integration
remains outstanding; it was not installed or live-verified in this pass.

Ponytail scope: existing watch and receipt paths reused; no new daemon, scheduler,
dependencies or persistent observation files. Production runs/agents untouched.
Validation: `npm test` 59/59; Bash monitor suite 41/41; added notification-contract
help assertions separately rerun green. Node syntax and `git diff --check` clean.

## Delegation discovery overhead (5 September 2026)

Two regressions reproduced before the fix: `run queue --help` returned every run
action; `init` returned neither worker-role choices nor queue syntax. Step-specific
help now avoids that round trip: queue help 3350 → 385 UTF-8 bytes; run overview
908 bytes. Full help/config remain explicit. Missing-run and accidental `start`
errors lead to setup/queue instead of another status error or a broad help chain.

Read-only live probe: globally linked `fleet`, exit 0, 55 ms, 370 output bytes.
Reported silent output not reproduced; empty fake-backend JSON returns an explicit
error. No live workers started, prompted or closed; no cached agent instructions
changed. Help/output tests do not prove an LLM will follow the workflow. Managed
push notification remains outstanding.

Validation: full JS suite 63/63, then four focused tests passed after final help
adjustments, including one new custom-role overflow regression (64 distinct tests
covered). Standalone Bash suite 41/41; Node syntax, README links/example syntax and
`git diff --check` passed. Sandbox runs failed process/receipt identity checks.
An unsandboxed parallel Bash run also failed `idle completion cleanup` (surviving
fake waiter); the isolated rerun passed. That intermittent cleanup failure remains
unresolved; no engine changes in this pass.

## Blocked delegation recovery (5 September 2026)

Reproduced an idle foreign pane blocking a read-only verifier. Exclusion stays:
read access and subdirectory scope are instructions, not isolation. `next` now
explains the conflict and offers a scoped recovery rather than a foreign-pane read.
Inline `queue/revise --prompt` avoids project task documents; queued `run move`
preserves role, prompt, phase and dependencies and records the relocation.

The regression executes the actual suggested shell commands against a real temporary
Git repository/worktree, including a quoted source path and subtree cwd. HEAD snapshot verified;
dirty/untracked source preserved; fake owned worker started/accepted/closed; worktree
removed without force. No real Herdr agents or production runs touched.
Additional coverage: ambiguous/oversized prompts, full parked pools, cancelled
dependencies, phase/cleanup guidance, wrong owner, corrupt/foreign leases and failed
publication. A new negative test exposed a pre-existing macOS `/var` → `/private/var`
alias bypass of state-directory exclusion; both paths are now canonicalized.

JS suite: 69/69; standalone Bash monitor suite: 41/41. Global executable exposes the new commands. No new dependencies,
daemon or runtime files in projects. LLM adherence and provider startup remain
unverified in this pass; automatic end-hook-to-orchestrator wakeup remains open.

## Subscription exhaustion and provider handoff (6 September 2026)

Read-only live confirmation: the reported Copilot pane was `idle` while displaying
`You have exceeded your monthly quota`. The updated global CLI now returns
`QUOTA_EXHAUSTED`, monthly scope and concrete configured-model switch commands.
No production pane was prompted, stopped or closed; no live provider replacement
was performed. Session-limit wording is covered by fixtures, not a live exhausted
Claude/Codex subscription.

`run switch` preserves task/prompt/worktree/dependencies and retains its lease.
Bounded private checkpoint before retirement: terminal tail (2000 lines / 32000
characters maximum), Git status, session identity and optional coordinator notes.
The old tab closes without completion/acceptance; `next` launches the replacement.
Full model context and detached background jobs are not automatically recovered;
the coordinator must check for active jobs and the replacement verifies the files.

Validation: JS 75/75; standalone Bash 42/42. Includes large output, wrong owner,
active/unknown workers, changed sessions, missing checkpoints, failures before and
after tab closure, safe retry/cancellation, archive retention, retained dirty files
and leases, and a watch started before quota exhaustion. Cached status does not
repeat the quota read. An intermediate Bash run encountered a script-read syntax
error during test-file editing; the final frozen-file full rerun passed.

Existing context cache and close/queue paths reused; no dependency, daemon, project
state document or automatic billing/provider switch. A tracked watch surfaces the
quota to its caller; universal unsolicited orchestrator wakeup remains unimplemented.

## Quota supervision, takeover and switch cleanup (6 September 2026)

This pass uses isolated fake-backend regressions, not exhausted live subscriptions.
No production run or pane was changed. The global executable's targeted help exposes
`run watch` and `run takeover`; no install or global instruction-file change needed.

- Shared JS/engine quota detector: monthly/session/weekly limits, hit/reached variants,
  Claude-style bare “You've hit your limit” and Codex-style bullet prefixes.
- Managed hooks persist quota errors without completion proof or owner-terminal input.
  Monitor probes native `unknown` as well; stable unknown can wait for the existing
  monitor interval (up to approximately 60 seconds), not guaranteed instant delivery.
- Worker switch: re-read quota and identity before closure, including unknown-state
  workers. A worker resuming during that read refuses closure. Runtime registry and
  disposable monitor hints removed; identity/checkpoint, tombstone and inbox retained.
  Late hooks on closed workers suppressed until a new generation is explicitly armed.
  A later quota cannot overwrite an already saved completed result. Failed replacement
  reservation rolls back new leases only, preserving the handoff's existing lease.
- Explicit same-workspace owner takeover: current quota or verified pane absence,
  bounded checkpoint, preserved task/lease state, old-owner CLI fencing. Concurrent
  controls block takeover without serializing ordinary controls. Dead transaction
  locks have a verified recovery path; unknown/live holders remain protected.
- `run watch` alias; one live watcher/run; review results included, avoiding another
  inbox fetch. Persisted quota evidence suggests a switch but cannot authorize a
  stale close: the switch always revalidates the visible error.
- Finished-run cleanup/retention removes verified dead watch/control metadata too;
  active runs, live PIDs, unverified files and symlinks remain protected.

Not verified: real Claude/Codex exhausted subscriptions, live owner/provider transfer,
or host-specific background notification delivery. No universal unsolicited wakeup,
automatic replacement launch or provider/billing change. Owner tabs, native sessions,
external worktrees and detached jobs are deliberately not killed/deleted. The CLI
fences its own controls, not arbitrary commands another process may still execute.

Final validation: `npm test` 87/87; standalone Bash suite 43/43; Node/Bash syntax
and `git diff --check` passed. Initial checks caught an incorrect test expectation
that the runtime registry survived closure, stale help wording, and an old assertion
that allowed late post-close input notifications; expectations/docs were reconciled
with the verified cleanup behavior. New failure-injection tests cover retained-lease
rollback, owner publication failure, live/dead locks, stale quota and watcher transfer.

## Explicit cancellation and orphan tabs (6 September 2026)

- Reproduced structurally: unfinished task → `close` rejects acceptance → raw
  worker-pane closure leaves monitor/tab → `recover` still sees resources.
- `run cancel <pane-or-task-id> --evidence "authorized stop; partial state"`:
  durable bounded checkpoint, verified whole-tab closure, then cancelled state and
  lease release. Never completion/acceptance, Git mutation or worktree removal.
- Retry tests: failed checkpoint leaves worker running; failed final publication
  retains cancellation/lease; retry recognizes the tombstone and never closes twice.
- Fixture topology now stores monitor panes independently of agents. Covers deleted
  worktree + missing worker + surviving monitor, extra panes, changed session/terminal,
  owner protection, active control, blocked startup without receipt, archive retention.
- New monitor cwd: receipt directory, not worker worktree. Managed engine calls also
  use the run directory. Existing live monitor shells are not modified retroactively.

Live smoke: isolated `/private/tmp/herdr-axi-cancel-live.e7QB04/project`, run sibling
`run`; Copilot worker `w1B:pY`, tab `w1B:tQ`, name `axi-073d86fe-922a2224`.
Copilot stopped at folder trust before submission; no approval sent. New `run cancel`
saved visible output, closed the exact owned tab and verified absence. `run finish`
archived the test and pruned three runtime files. No task output created, no other
agent/tab controlled. The bounded archive remains outside the repository.

Live limitation: startup trust prevented creating the monitor and executing the
scratch task. Monitor-only cleanup and active-worker cancellation were fixture-tested,
not live-tested. The user's pre-existing orphan tabs were intentionally untouched.

Final validation: Bash 44/44; JavaScript 93/93, including the stale-launcher-PID
regression. Node/Bash syntax and diff checks passed. No new dependency or scheduler;
existing close/receipt/archive paths reused.

## Adversarial fixes and orchestrator exercise (6 September 2026)

Baseline `d2f431f`; scratch `/private/tmp/herdr-axi-fix-live.fJ5Qz7`.
Actual Claude Opus 5/high adversarial review; separate Codex Sol/high orchestrator.
No live project tasks, global instruction edits, dependency additions or publication.

| Live scenario | Observed result |
| --- | --- |
| Queue overlapping writer | Deferred; cancelled without starting another worker |
| Start Codex + Copilot | Two distinct owned tabs; trust/startup handled explicitly |
| Cancel running Copilot | Whole tab, including monitor, gone; 1738 ms |
| Complete/reuse Codex | Exact `alpha\n`, then `second\n`; same worker, new generation |
| Watch → review → accept | Reports in both watch responses; zero separate inbox calls |
| Close/finish | Both worker tabs absent; run archived; no retained lease |

CLI trace: **25 completed calls, 14,680 output bytes**; watch 2, inbox 0,
bounded read 2, help 0, final status 1. No status/inbox polling loop.
Two CLI errors: sandbox permission denial and premature startup recovery.
One further approval rejection occurred before CLI execution. The child’s own
call-count estimate differed; `cli-calls.jsonl` is authoritative.

Workers: Copilot `w1B:p1B` / `w1B:tZ`, Codex `w1B:p1C` / `w1B:t0` (zero).
Standalone orchestrator `w1B:p19` / `w1B:tY` also closed after identity/topology checks.
Reviewer `w1B:p18` / `w1B:tX`: accepted review, whole tab closed, run archived.
All four test tabs independently verified absent; both runs lease-free.
Original owner `w1B:p2` / `w1B:t2` untouched. Scratch outputs retained under
`scenario-run/one`; native provider session history not deleted.

Regression coverage: pending proof versus quota for all three providers;
interrupted/resumed switch; handoff reuse; recovery archival; receipt-lock IPC;
signal during waiter registration; PID reuse; context/quota probe fairness;
late-proof watch reports; bounded startup diagnostics. Eleven new Node cases
and both original Bash proof/signal cases failed against the old product code.

Limits: no real subscription deliberately exhausted; provider quota variants,
owner takeover and interrupted switch cleanup fault-injected through isolated
backends. Trust/updater dialogs still require explicit authorized handling.
`no-mistakes` executable unavailable; independent Opus review and local validation
used instead. No claim of its pipeline or CI passing.

Final frozen-code validation: **Node 112/112; Bash 47/47**. Node/Bash syntax,
`git diff --check`, ShellCheck `--severity=error`: clean. Phase-order reuse also
exposed historical task selection masking the active task on the same pane;
shared lookup and monitor hints now prioritize active work, with explicit task
IDs preserving historical selection. No full transcript scan under the hook's
receipt lock; executable probes cover both quota and non-quota paths.
The probe itself has a negative control: a real receipt lock plus an intentional
transcript scan must be detected. Four focused Opus rounds reviewed the deltas;
the last test-probe defect was corrected and independently exercised.

## Adversarial follow-up — 2026-09-06 (isolated regressions, not a live run)

Baseline: `75a83d1`. No live worker, tab, subscription or global agent config changed
by these tests. Existing fake backends; dependency-free Node tests.

| Review IDs | Correction | Executable evidence |
| --- | --- | --- |
| 1 | Permission/trust UI and input hooks override retained quota text; historical quota no longer suggests a switch | Native banner + active selector through detector, inbox and switch; zero tab-close calls |
| 2–4 | Canonical CLI entrypoint; explicit JSON protocol validation in hook and final close guard | Relative/symlink invocation; empty-success, null, malformed and wrong-code parser outputs; saved report and protected tab |
| 5 | Initiating Node executable pinned into worker env and monitor command; missing dependency diagnosed | Actual launch arguments; missing-node machine result; restored collection with pinned executable |
| 6 | Explicit cancellation for failed startup without a registry; no inferred closure | Failed tab create; dead launcher; live orphan-engine refusal; cancellation then released lease and finish |
| 7 | Missing monitor/receipt allowed by `created` lifecycle stage, with checkpoint and identity guards intact | Startup quota handoff through both CLI and Bash close; entire recorded tab retired once |
| 8–9 | Lease release after durable archive/run publication; read-only cleanup failures propagated | Injected archive/run rename ENOSPC; foreign acquisition blocked; lock-removal EIO; original operation error preserved |
| 10–11 | Watch records bind PID/start identity; lease ownership uses canonical run directories, including old alias paths | Recycled watch PID; actual watch marker; symlink acquire/status/release and GC ownership check |
| 12–13 | Unchanged parked diagnostics do not repeatedly wake an active run; settled reports supersede transient monitor errors | Two waits time out; parked worker still visible/closable; valid report restores accept guidance |
| 14 | Registry failures isolated per target; corrupt worker cannot promote itself via self-filtered discovery | Independent keys, switch, live cancel and owner takeover cases; worker promotion refused |
| 15 | Valid generation proof can save a report with unknown/empty readiness; working/blocked still excluded | All four readiness variants through the real hook; acceptance settlement guard unchanged |

- Counterfactual: all **15 newly added Node cases fail** on unchanged baseline product code; only test files replaced in a detached temporary worktree.
- Bash counterfactuals: empty parser loses inbox; unknown readiness loses report; created-stage handoff rejected; empty-success close guard incorrectly retires the fixture tab.
- Parser fault consumes stdin before returning empty success: no accidental SIGPIPE fallback masking the regression.
- Shared cancel/switch retirement verification; no additional dependencies, daemon or polling loop.
- Remaining limits: quota detection uses terminal wording, not subscription APIs; no real allowance deliberately exhausted. Legacy watch markers without verifiable process identity remain protected. Corrupt target ownership never grants closure authority. Unregistered shell-only tabs require explicit inspection; no guessed cleanup.
- Final validation: **Node 127/127; Bash 50/50**; Bash syntax, ShellCheck `--severity=error`, `git diff --check` and 23 local documentation links clean. Temporary counterfactual worktree removed. No new external reviewer or CI run claimed.

## Agent ergonomics and event-driven waiting — 2026-09-07

- Baseline: `fab3e0f`; isolated fake backends; no live Herdr panes/tabs started or modified in this pass.
- Two bounded, read-only native Opus reviews; final waiting enhancement reviewed locally and tested without additional model calls.
- Shared launch guards and existing run lifecycle reused; no new dependency, scheduler service, project state document or model-based help router.

| Scenario | Verified result |
| --- | --- |
| Direct Opus delegation | Two frontend calls: `init`, then export + `queue --start`; one prompt; startup response <1,500 bytes; no fleet/layout/config/help preflight |
| Keyword help | `start opus`: 1,056 bytes; `wait notification`: 501 bytes; full guide: 2,924 bytes; queue help: 761 bytes; zero backend/model calls |
| Ambiguous/unknown intent | Bounded topic choices; no guessed cancellation, approval or dispatch |
| Model/mode choice | Role access/native-child limits retained; incompatible models rejected before allocation; missing/manual Claude startup footer prevents submission and remains cancellable |
| Nested config | Nearest complete config through worktree root; no project-identity change; invalid nearest file fails visibly |
| Startup/input hooks | Registered generation armed before native startup; narrow legacy blank-generation repair; true identity drift remains protected, with diagnostic rather than blind retry |
| Native state cycles | Assignment generation, proof file and consumed-proof fingerprint survive same-assignment rearm; explicit follow-up invalidates old evidence |
| Failed monitor rearm | Generation-bound error and nonzero exit; no invented assignment or silently lost supervision |
| Quiet wait | Three backend list probes over 8.5 seconds; persisted completion wakes the same call before the next 8-second fallback; report included, no second inbox call |
| Notification races/noise | Events before wait retained; consumed events do not repeat; telemetry/locks/temp writes ignored; missing filesystem notifications retain timer fallback |
| Cleanup | One watcher/run; duplicate refused; owned tab lifecycle and watch-record removal verified; unrelated panes protected |

- Focused validation: 43 helper/CLI tests, 7 startup/recovery tests, 13 watch/inbox tests; Bash **55/55**.
- Final frozen-product suite: **Node 149/149**, 205 seconds; no failures or skips. Global PATH entry resolves the updated guide correctly.
- Bash syntax, ShellCheck `--severity=error`, JavaScript syntax, whitespace checks and 23 local documentation links: clean.
- Limits: no real subscription exhausted or live worker workload benchmarked; provider/account availability still native-CLI authority. Claude mode checked at initial/resumed startup; other providers retain explicit native launch flags, not a claimed visual mode attestation. Persisted hooks/file events do not themselves wake an LLM: that requires a verified harness callback or an awaited foreground tool result. No self-modifying orchestration policy or automatic acceptance.

## Sonnet orchestrators — 7 September 2026

- Actual terminals, baseline `ed93278`; scratch `/private/tmp/herdr-axi-sonnet.OgpC9V`.
- Two fresh Sonnet/medium orchestrators; eight workers. All eight native worker transcripts confirm `claude-sonnet-5`; no native subagents, at most two concurrent workers per run.
- Initial prompts: outcome, scope, Sonnet/cap limit, explicit cancellation/review requirements and safety boundaries. No command sequence, minimum-call recipe or source-code access provided.
- Scenario A ran before fixes; B ran after the late-proof/isolation fixes; C was an explicitly coached cancellation follow-up in B's orchestrator. Different tasks, not a controlled speed comparison or proof of universal agent efficiency.

| Scenario | Tool calls / shell calls | Parsed AXI commands | Watch / inbox | Observed result |
| --- | ---: | ---: | ---: | --- |
| A: two JSON outputs, independent review, integration | 42 / 40 | 51 | 0 / 4 | Exact outputs and cleanup pass; four sequential workers, unnecessary help/reads/retries |
| B: parallel work, same-worker uppercase follow-up, independent review | 38 / 32 | 35 | 3 / 0 | Exact `HELLO\n`, reuse and cleanup pass; required cancellation **failed**: alternative accepted/closed instead |
| C: explicit cancellation-only follow-up | 9 / 8 | 7 | 1 / 0 | `cancelled` recorded, no acceptance, entire tab removed, input preserved, run archived; zero tool errors |

- Measurement: native Claude tool-use/result records, not agent self-estimates. Result bytes across all tool outputs: A 34,702; B 20,667; C 4,618. AXI commands parsed from shell inputs; not backend round-trip counts. Test PATH wrapper was superseded by native shell PATH; its missing trace is not treated as zero calls.
- Displayed orchestrator costs: A $0.97; B $0.99 before correction, $1.28 including C. Worker cost not included; no aggregate billing claim.
- **Wake verified:** B launched native Bash `run_in_background` watch, ended its active turn, received `task-notification` at `2026-09-06T22:34:19.227Z`, then resumed without parent input. Further watches also used native callbacks. This verifies that specific Claude harness path, not an unsolicited hook-to-any-agent channel.

| Finding | Correction / disposition |
| --- | --- |
| Existing proof not yet collected: accept failed until an extra inbox call | `accept` and `revise` collect the current proof once, then recheck live identity/settlement; preserved report, generation and evidence guards. Three `NOT_COMPLETE` responses in A; agent claimed four. B had none |
| Git snapshot recipe offered in non-Git scratch directory | Verify commit HEAD before suggesting Git commands; otherwise explain serialization or relocation to an existing independent directory |
| Managed settled wait directed agent to raw result reads | Next action now inbox; already-reviewed results can use accept directly with on-demand proof collection |
| `guide start sonnet` silently retained default worker choice | Explicit Sonnet recipe; contradictory Opus/Sonnet choices rejected |
| Close-before-accept suggested only cancellation | Review/inbox path surfaced alongside explicit abort; no automatic acceptance or deletion |
| Accepted result then revise caused avoidable failure | Help explicitly distinguishes pre-accept revision from a matching new task that can reuse an accepted worker |
| Shell export lost between tool calls | Init explicitly says repeat selected-run export in every fresh tool shell; no ambiguous automatic run selection |
| Optional task accepted/closed despite explicit cancellation request | Blind scenario marked failed, never retroactively rewritten. C proves explicit cancellation works; help distinguishes the states. Agent intent adherence remains an evaluation limitation |
| Native idle prompt suggestion mistaken for injected instruction | Agent correctly did not execute it, but added unnecessary report text. Native draft/suggestion chrome still visible in reads; no speculative filtering of terminal evidence |
| Excess help and premature task decomposition | Still observed: A six help calls + two guides; B eleven help calls. No claim that concise CLI help alone ensures efficient model choices |

- Regression validation: full Node **153/153**, Bash **55/55**; focused acceptance/revision/non-Git recovery **8/8**. Later wording refinements rechecked through the public CLI.
- Files independently checked: A `delivery.json` exact combined JSON; B `main/greeting.txt` six bytes `HELLO\n`; `alternative/input.txt` remains `welcome\n`.
- Cleanup verified against backend: workers `w1B:p1G/p1J/p1M/p1P/p1S/p1T/p1X/p1Z`; tabs `w1B:t12/t13/t14/t15/t17/t18/t19/t1A` all absent. Both orchestrator tabs `w1B:t11` and `w1B:t16` also absent. Original parent `w1B:p2` remains present.
- Three runs archived; all worker records closed; both test lease directories empty. Scratch fixtures/evidence retained outside the repository; native session transcripts not deleted. No live project or foreign agent modified; no worker commits, pushes or project state/plan documents.
- `no-mistakes`: existing official Go installation `~/go/bin/no-mistakes` v1.60.0 was missing from PATH. Added `/opt/homebrew/bin/no-mistakes` symlink; login-zsh/sh/version/help/doctor passed. No reinstall, upgrade, daemon reset, repo initialization or paid pipeline run.

## Deeper Sonnet failure drill — 7 September 2026

- Pushed baseline `9269418` to `origin/fix/quota-recovery-boundaries` before testing.
- Disposable project: `/private/tmp/herdr-axi-deep.Varl2o/project`; external state beside it. No real project changes or foreign pane control.
- One fresh Sonnet orchestrator, three Sonnet workers; outcome-only delegation prompt, no prescribed CLI sequence. Additional parent-operated run: two Sonnet workers for precise wait/recovery checks. Native transcripts confirm `claude-sonnet-5` for all five workers; medium effort; max two concurrent, no native children.

| Real scenario | Observed result |
| --- | --- |
| Parallel tiny writer + optional read-only investigation | Separate scratch directories; cap two respected |
| Revise before acceptance | Same writer, new generation; `total.json` independently asserted as `{count:3,sum:10,mean:10/3}` |
| Independent reviewer with full parked pool | Deferred with exact close hint; orchestrator retired the accepted writer, then started reviewer |
| Controlled worker-pane loss | Closed only settled test pane; monitor remained; live status reported lost |
| Explicit cancellation after loss | Orchestrator cancelled, not accepted; whole monitor tab removed, input preserved |
| Genuine busy / timeout errors | Parent dispatch refused with `AGENT_BUSY`; one-second state wait returned `TIMEOUT`, not completion |
| Visual terminal structure | Actual layout: 41 agent rows / 14 monitor rows, ratio 0.75; meaningful task labels |
| Startup render race in second run | Native ready before Auto footer; no prompt sent; inspected actual Auto footer and recovered same pane |
| Task-scoped watch, unrelated lost task | One-second timeout instead of immediate unrelated attention; lost task/lease retained |
| Late proof in task-scoped watch | First implementation incorrectly timed out despite proof; corrected and retested on same live worker: report collected, `review`, exact accept hint |
| Cleanup | All six created tabs absent; both runs archived; zero leases; only `run.json` + `detail.json.gz` remain per run |

- Blind orchestrator trace: **43 tool calls / 33 shell calls / 36 parsed explicit AXI commands / 25,785 tool-result bytes**; includes five help calls, four watches, five reads, two inbox calls, two global agent listings. Command parser counts only lines beginning `herdr-axi`; piped/batched failures can have outer shell exit zero. Confirmed intermediate errors: `UNKNOWN_AGENT`, `READ_UNAVAILABLE`.
- First/last tool timestamps: `2026-09-06T22:55:45.160Z` / `23:02:15.135Z`; includes waiting for parent cancellation authority. Not a controlled performance comparison with earlier scenarios. Extra discovery and redundant reads remain agent-behavior limitations, not a claimed solved efficiency score.

| Confirmed defect | Refinement / regression check |
| --- | --- |
| Lost task makes unrelated watch return immediately; inbox suggests global discovery | `watch --task TASK`; task-specific recovery/cancel hints; independent wait hint; existing one-watcher/ownership rules retained |
| New targeted wait initially missed late proof | Published proof wakes filesystem watcher; targeted wait collects late proof through existing inbox path; native idle without proof still waits |
| `revise` silently discards unreadable previous report | Reproduced failing test before fix; shared accept/revise report validation; prior generation/report/truncation retained; explicit reviewed replacement available |
| Missing selected run suggests repeating same failure | `RUN_INVALID`, restore existing run selection; no replacement-run recommendation |
| `agents working` silently lists all agents | Reject positional filters before backend call; explicit `--state`/`--kind` guidance |
| Native-ready / Auto-footer render gap | Four read checks, at most three 250ms backoffs for missing evidence only; wrong mode fails immediately; delayed-auto/delayed-manual and retry-budget assertions in Bash suite |

- Test-only identities: orchestrator `w1B:p21` / `w1B:t1B`; workers `w1B:p22,p24,p26,p28,p29`; tabs `w1B:t1C,t1D,t1E,t1F,t1G`. Only original tabs `w1B:t1,t2` remain; parent `w1B:p2` untouched.
- Limits: no real subscription exhausted; no fresh Codex/Copilot sessions in this drill; no claim of universal hook delivery. Native background completion and one lost-worker notification were observed. Startup retry tested deterministically after reproducing the real rendering gap; no forced manipulation of provider UI rendering.
- Code review: parent inspected implementation/error paths and reproduced report loss; separate Sonnet reviewer checked scenario output, not the package diff. Existing receipt/collection paths reused, no new dependencies, daemon or persistent polling state.
- Validation: `npm test` **158/158**; `bash engine/test-herdr-monitor.sh` **55/55**; final focused wait/proof/report tests **5/5**; syntax, whitespace and 24 local documentation links checked.

### Split-monitor routing follow-up — rounds F/G

- First refinement committed/pushed as `f5e1ba9`; two further one-worker Sonnet/medium runs, same disposable project. No native children or project writes.
- Executable regression: run the worker-generated monitor command without inherited inbox/receipt settings and with a wrong server workspace. Original code sent an owner prompt; mode-only correction then wrote outside the run. Both failures reproduced before the complete fix.
- Fix: explicitly pass inbox mode, receipt root and workspace into the split monitor, alongside the existing Node path. Preserve legacy notification mode; no extra polling or persistent state.

| Live round | Outcome |
| --- | --- |
| F, mode-only correction | Startup footer retry still insufficient; same-pane recovery worked. Completion report delivered, then intentional settled-agent loss wrote to global `.herdr-orchestrator` with empty generation. Failed 10-second run-inbox assertion retained as a failed test |
| G, complete routing correction | Fresh worker started without recovery. Settled report delivered; intentional agent-pane loss published `lost` with exact generation `kdRn6AAx` in the correct run in **1,764 ms** after close returned. No matching global receipt; no unsolicited owner prompt observed |

- F: `w1B:p2C` + monitor `w1B:p2D`, tab `w1B:t1H`; G: `w1B:p2E` + monitor `w1B:p2F`, tab `w1B:t1J`. Both cancelled without acceptance; managed cleanup closes the whole remaining monitor tab, preserves input and archives each run.
- Two misrouted F files moved recoverably to scratch `misrouted-evidence/`; no foreign runtime files removed. F/G ownership manifests retained beside earlier evidence.
- Remaining startup finding: three 250ms render backoffs reduce, but do not reliably eliminate, native-ready/Auto-footer races. Wrong mode still fails closed; no automatic trust approval.
- Validation after complete routing fix: Bash **56/56**, syntax and whitespace clean. Live tab list contains only original `w1B:t1,t2`; no test leases remain. The existing Node **158/158** run precedes this shell-only correction, not represented as a new rerun.

### Startup rendering follow-up — round H

- Routing correction committed/pushed separately as `7845db3`.
- Reproduced slow-footer failure before correction: first four reads contain no footer, fifth becomes Auto. Extend missing-evidence retries to six checks with 0.25/0.5/1/2/4s backoff, **7.75s total backoff maximum**; backend-call latency additional. Already-ready Auto requires one read; visible wrong mode fails immediately; unknown exhausts six reads without submission.
- Regression variants: immediate Auto/manual, missing footer, one-read-delayed Auto/manual, four-read-delayed Auto/manual; exactly one prompt only after verified Auto, no unnecessary monitor on refusal, resume retains the same checks.
- Two fresh parallel Sonnet/medium verifiers, separate scratch directories: both `running` on initial `queue --start`; no recovery, approval or repeated start. One `watch` returned both generation-bound reports. Parent independently checked `[2,3,5]` and exact `welcome\n`, then accepted both, closed both whole tabs and archived the run.
- Test identities: `w1B:p2G` / monitor `w1B:p2J` / tab `w1B:t1K`; `w1B:p2H` / monitor `w1B:p2K` / tab `w1B:t1M`. Final live tab list: only original `w1B:t1,t2`; zero test leases. This demonstrates two successful starts, not a guarantee across account policies or a controlled latency benchmark.
- Final cleanup audit found five additional global receipts belonging to recorded D/E test workers. Moved these plus the two F files recoverably into scratch `misrouted-evidence/`; foreign files/native histories untouched. Across D–H: one test orchestrator, nine workers, ten created tabs, five archived runs.
- Focused launch/wake tests: **5/5** with native filesystem notifications available. Restricted-sandbox run failed the filesystem-wake assertion; no test weakened or skipped to hide that environment limitation.
- Final engine rerun: **56/56**, including slow-footer and clean-environment monitor regressions; syntax/whitespace clean. JS changes remain covered by the earlier full **158/158** run. No no-mistakes pipeline claim: binary/doctor work, but this repository has no initialized gate and its daemon was stopped.

## Adversarial fixes and cross-kind live checks — 7 September 2026

- Baseline: `43c2e81`; scratch `/private/tmp/herdr-axi-fixes.HW5MfL`; parent `w1B:p2`; original tabs `w1B:t1,t2` protected.
- Three implementation agents with disjoint scopes; cross-reviews of identity and report consumers. No repository-editing worker tabs or foreign-agent control.
- Root-operated live rounds, not a blind-orchestrator efficiency benchmark. Round 4 encountered a real Copilot monthly quota; no induced exhaustion of Claude/Codex subscriptions.

| Round | Real behavior / independent checks | Outcome |
| --- | --- | --- |
| 1, two Sonnet/medium workers | Writer: `[2,3,5]` → count/sum; revision adds mean; reader: exact `welcome\n`; files independently asserted; old revision retrieved before/after archive | Task/proof/revision paths pass; monitor loss test fails at 20 seconds |
| 1, failure diagnosis | Both fresh monitor shells had Oh-my-zsh update prompts; `pane run` input consumed as dialog answers; no monitor process. Later raw diagnostic exposed `env` truncated to `nv` | Real startup defect; no claim that initial backend-routing fix alone passed |
| 2, two fresh Sonnet/medium verifiers | Split update prompts disabled; generation-bound monitor startup acknowledgement before submission; both start on first attempt, no trust/recovery loop | Both completion reports collected in one watch |
| 2, deliberate reader-pane loss | Only owned settled agent pane closed; filesystem watcher checks correct inbox/generation and original completion object | `lost` in **2,173 ms**; completion object unchanged; remaining monitor tab cancelled through AXI |
| 3, Codex/Sol medium | Update explicitly skipped, scratch trust explicitly approved; count/sum/mean checked; same-pane revision checks product 30; generation reports returned by targeted watch | Both turns pass; independent arithmetic assertion; accepted, whole tab closed |
| 3, Copilot/Sol medium | Startup appeared ready before folder-trust UI; initial prompt delivery uncertain; after inspected trust response, no task output and 0 AIC | Cancelled without guessing delivery or resending; no acceptance; separate definite-rejection regression required |
| 4, Copilot/Sol medium | Startup trust correctly reported as no submission; explicit current-session trust, same-pane recovery; actual monthly quota displayed | Earlier submitted prompt hid fresh quota; detector corrected, real inbox then reports monthly exhaustion and executable switch |
| 4, Copilot → Sonnet | Same task/worktree/checkpoint retained; old agent+monitor tab closed; Sonnet checks exact `welcome\n`, 8 bytes | Task result correct, proof refused as historical pasted instructions; no acceptance, whole replacement tab cancelled; handoff prompt refinement required |
| 5, corrected Copilot → Sonnet | One scoped watch returns real monthly quota and switch command; explicit switch preserves task/checkpoint; Sonnet receives current contract without historical terminal instructions | One scoped watch returns saved TOON result plus current-generation settlement; exact input bytes and durable receipt independently asserted; accepted and closed |

| Confirmed boundary | Fix / executable regression |
| --- | --- |
| Recovery adopts replacement native identity | Engine registry retains terminal/session atomically; uncertain and publication-failed recovery compare saved identity, never learn from replacement |
| Lost publication during legitimate followup | Engine-recorded generation lineage permits original-session recovery without resending; terminal drift still refused |
| Later input/lost event overwrites completion | Latest alert and generation-bound completion share one atomic inbox; legacy promotion, no carryover to a new generation |
| Acceptance advice uses wrong/unavailable report | Shared report validation before accept/revise and inbox advice; selected saved result returned once, not duplicated or replaced with current terminal text |
| Monitor inherits wrong backend / startup UI | Explicit backend/Node/receipt routing; shell updates disabled; bounded startup acknowledgement; unconfirmed topology cancellable, duplicate monitor refused |
| Invalid proof wakes watch repeatedly | Exact proof bytes; malformed/missing proof remains pending; invalid-proof diagnosis on timeout |
| Scoped watch hides context I/O errors | Existing error preserved without immediate repeated wake; newly occurring error changes watched state |
| Saved revision inaccessible after archive | `run history --task ID --revision N`; bounded offline detail, explicit expiry |
| Late dialog rejects prompt before input | Persist explicit backend `agent_blocked`; approved retry reuses pane/monitor with linked generation; ambiguous timeouts never replay |
| Rejected retry after failed publication skips a generation | Publish verified intermediate worker with recovery reservation before rearming; concurrent recovery submits once |
| Earlier submitted prompt masks fresh quota | Distinguish historical input from current consent; framed native error detection; unmarked multiline pasted errors remain ambiguous and refused |
| Quota alert recommends result acceptance | Acceptance note only when a validated saved completion exists |
| Old terminal instructions contaminate replacement assignment | Current contract first; explicit external receipt-only exception; bounded quoted checkpoint metadata, no old terminal/proof injection; full checkpoint retained |

- Round 1: worker panes `w1B:p2N,p2M`; monitors `p2P,p2Q`; tabs `w1B:t1P,t1N` closed; archived.
- Round 2: worker panes `w1B:p2S,p2R`; monitors `p2T,p2V`; tabs `w1B:t1R,t1Q` closed; archived.
- Round 3: worker panes `w1B:p2W,p2X`; monitors `p2Z,p2Y`; tabs `w1B:t1S,t1T` closed; archived.
- Round 4: Copilot `w1B:p20` / monitor `p31` / tab `t1V`; Sonnet `w1B:p32` / monitor `p33` / tab `t1W`; both closed; archived. Four runs contain only `run.json` + `detail.json.gz`; zero scratch leases.
- Round 5: Copilot `w1B:p34` / monitor `p35` / tab `t1X`; Sonnet `w1B:p36` / monitor `p37` / tab `t1Y`; both closed; archived. Temporary proof already consumed by hook when independently inspected; durable receipt and inbox fingerprint match generation `oS64w5xC`.
- Final cleanup audit: **10 workers/tabs closed, 5 runs archived, 0 leases**; only original `w1B:t1,t2` remain. No foreign pane input, worktree removal or native-session deletion.
- Integrated baseline before late-delivery refinement: Node **173/173**, Bash **61/61**; focused saved-report/monitor-error help **2/2**. Tests execute fake backends; no suite reaches the real fleet.
- Next integrated run: Node **177/177**, Bash **62/62**. Final live refinements additionally covered by quota **5/5**, handoff contract/lifecycle **4/4**, saved-report/quota-help **2/2**. Final stable full Node rerun: **180/180**, zero skipped/failed; targeted retired-checkpoint query executed against the real handoff record.
- Independent adversarial checks: identity/recovery **6/6**, quota **5/5**, delivered handoff prompt **1/1**; 3 concurrent recovery races, one submission each. Syntax/whitespace clean; **24** local documentation links resolve.
- Limits: Copilot cannot complete work while its actual monthly quota is exhausted; verified fallback instead. Claude/Codex quota variants remain deterministic tests, not live exhaustion. Ambiguous unmarked quota-like text after submitted input is deliberately not destructive-switch authority.
