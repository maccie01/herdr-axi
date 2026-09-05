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
