#!/usr/bin/env node
import { runAxiCli, AxiError } from "axi-sdk-js";
import { home, agents, fleetCmd, read, wait, dispatch, watch, run } from "../src/commands.mjs";
import { guide } from "../src/guide.mjs";

const HELP = `Start: herdr-axi run init --project <path>; next tool call: returned export + queue --start together.
Optional TOON help: herdr-axi guide "start opus" | "quota switch" | "stop worker"; no keywords = full compact workflow. Alias: --skill.
Commands: guide, run, watch, agents, fleet, read, dispatch, wait. Bare herdr-axi: fleet + next action.
Target owned pane IDs (w1:pP), never titles or self. Global discovery != ownership. One writer/worktree.
Running: independent work; one notification-backed watch if supported, otherwise block only when dependent. No repeated inbox/read polls.
Review returned reports -> accept/revise -> close accepted tabs -> finish. Unfinished stop: run cancel --help.
Do not create worker panes or call raw herdr agent start/prompt. run next owns startup, layout and limits.
read: compact; --raw layout; --full history. Inspect dialogs; no automatic trust approval.
Details only when needed: herdr-axi run <action> --help; or guide with 2-3 intent keywords.`;

const RUN_HELP = {
  init: `herdr-axi run init [--project <path>] [--dir <external-run-dir>] [--owner <pane>]
  Start directly from the owner pane; no fleet/config/layout preflight. Owner auto-detected, never focus.
  Loads nearest .herdr-axi.json through Git root; returns worker roles, queue syntax and HERDR_AXI_RUN export.
  External state by default: ~/.local/state/herdr-axi (override HERDR_AXI_STATE_HOME). Does not start workers.`,
  config: `herdr-axi run config [--full]
  Default: worker roles and current limits. --full: complete effective snapshot, including owner, native review contracts, context and retention.
  Already loaded at init; no config preflight needed before queue.`,
  queue: `herdr-axi run queue TASK --role ROLE --cwd WORKTREE --area AREA --prompt "task; checks" [--after ID,ID] [--start]
  --prompt-file FILE instead of --prompt; exactly one. 128 tasks/run.
  Runtime override: --kind claude --model claude-opus-5 --effort high; role access/native limits retained. No config edit/new run.
  Legacy --kind claude|codex|copilot without --role: write access, no native children.
  --area relative to --cwd; . = whole tree, not isolation. Read-only: choose access:read role from init.
  --start schedules ALL eligible queued tasks within caps; follow returned help, do not call next again.
  Batch: omit --start, queue tasks, then run next once. No config/layout preflight.`,
  move: `herdr-axi run move <queued-task-id> --cwd <existing-worktree> [--area <relative-path>]
  Preserve prompt, role, dependencies and phase; relocate the relative area. Queued tasks without resources only.
  No copy or startup; next rechecks conflicts. Check absolute paths in the preserved prompt.
  Worktree busy: even read roles reserve; --area/subdirectories do not isolate. Never close an unowned blocker.
  Use a separate worktree, or continue local work. next provides optional Git HEAD snapshot commands: excludes dirty/untracked changes.
  Remove externally created worktrees with Git only after owned worker closure; no force.`,
  next: `herdr-axi run next
  Reserve free slots; concurrent starts; reuse matching kind/cwd/policy. One writer per worktree.
  Separate worktrees for parallel work; sharedReadWorktree opts into instruction-only verifier overlap within this run only.
  Final verification needs an accepted writer dependency.
  Pending/unknown/unreviewed work occupies slots. Native leaf reviewers have a separate bounded budget.`,
  status: `herdr-axi run status
  Owned task states, capacity and context warnings. Inbox already includes needed status; do not call both to check progress.`,
  inbox: `herdr-axi run inbox
  Owned fleet, context warnings, summaries <=600 chars/worker. Collection/ownership errors remain visible.
  Inbox already includes needed status. Empty while working: independent work or watch, not repeated inbox/read.`,
  watch: `herdr-axi run watch [--timeout-ms N]
  Alias of herdr-axi watch. One active watcher/run. Review results included; act on returned help, do not fetch inbox again.
  Continue independent work with a harness-native tracked background watch; no detached shell or duplicate polling.`,
  takeover: `herdr-axi run takeover --from <current-owner-pane> --evidence "authorization; remaining work"
  Run from the explicitly authorized replacement agent in the SAME workspace; select the EXISTING HERDR_AXI_RUN.
  Previous owner must have a current quota error or its pane be verified absent. Never takes over a working/changed occupant.
  No active CLI controls/launchers. Same tasks, phase, leases and results; bounded owner checkpoint saved before transfer.
  Old owner loses CLI control, but external jobs are NOT stopped. Neither old nor new owner tab is closed.
  Workers cannot take over their supervisor. No new run, automatic agent launch or billing change.
  Then run inbox once; continue independent work or arm one tracked watch.`,
  accept: `herdr-axi run accept <pane> --evidence "review and checks" [--result-file FILE]
  Current generation proof + settlement + saved result + explicit review. No silent report loss.
  Missing/corrupt inbox: retry inbox, or supply a reviewed replacement (1..3500 chars); recorded as coordinator-replacement.`,
  revise: `herdr-axi run revise <pane> --prompt "<fix and checks>"  # or --prompt-file <file>
  Same worker/slot; retain revision history. Max eight revisions, then explicitly re-scope.`,
  phase: `herdr-axi run phase explore|build|integrate|verify|fix [--cap 1..16]
  Defaults 4/3/2/2/1. Never narrow below outstanding work; retire surplus accepted workers.
  Queued tasks keep their phase; return to it or cancel/requeue explicitly.`,
  close: `herdr-axi run close <pane>
  Accepted owned workers only; whole tab including monitor. Never the owner tab.
  Unfinished work: run cancel <pane> --evidence "authorized stop; partial state/background jobs reviewed".`,
  switch: `herdr-axi run switch <pane-or-task-id> --kind claude|codex|copilot --model <model> [--effort high] [--summary "partial work / pending checks"]
  Or --role <configured-worker-role>; same read/write access, different provider.
  Quota/session limit only; live identity + current quota error required, including native unknown. Never working.
  Check no tools/background jobs are still running; tab closure is not proof that detached jobs stopped.
  Save original task + bounded terminal checkpoint + Git status; retire owned agent+monitor tab WITHOUT acceptance.
  Preserve dirty/untracked files, dependencies, phase and worktree lease. No commits, stash, reset or new run.
  Retired monitor hints removed; receipts/checkpoints retained for retry/history, archived and pruned by run finish.
  Native sessions and external worktrees are not deleted. Then run next; replacement verifies files and checkpoint.
  Interrupted switch: repeat run switch <task-id> without flags. Checkpoint/lease retained, no duplicate startup.
  Old worker resumed: run switch <task-id> --cancel, only while its original identity/resources still exist.
  Detection is automatic in fleet/inbox/watch; provider/cost change requires this explicit command.`,
  cancel: `herdr-axi run cancel <pane-or-task-id> [--evidence "authorized stop; partial state/background jobs reviewed"]
  Queued tasks: remove from queue. Started tasks: evidence required (1..4000 chars); explicitly stops even working agents.
  Save bounded terminal checkpoint + Git status, then close the owned TAB (agent + monitor), without acceptance.
  Also handles missing agent panes with a registered monitor remaining. Identity/topology drift fails closed.
  Never deletes worktrees, commits, stashes or stops detached jobs. Review those separately.
  Interrupted cancellation: repeat run cancel <task-id>; checkpoint/lease/slot remain until closure is verified.
  Close/cancel tabs BEFORE removing external worktrees; never use worktree remove --force to clear panes.`,
  recover: `herdr-axi run recover <pane-or-task-id>
  Inspect first. Resume approved startup, acknowledge uncertain submission without resend,
  or requeue only after all registered resources are verified absent. To stop unfinished work + monitor: run cancel --help.
  Accepted/cancelled tasks: repair their leftover lease only, even archived/offline.`,
  leases: `herdr-axi run leases
  Exact lease paths, owner and holder tasks. Unknown ownership requires inspection, never automatic deletion.`,
  unlock: `herdr-axi run unlock
  Remove only run.lock for a verified dead transaction holder. Does not release worktree leases.`,
  finish: `herdr-axi run finish
  Accepted/cancelled tasks + closed workers required. Archive detail; prune known runtime files.`,
  history: `herdr-axi run history [--task <task-id> | --all]
  Compact task/review/decision trail; --all lists latest eight managed runs for this project.`,
  gc: `herdr-axi run gc
  Expire finished managed records only: detail 30d, summary 180d by default. Also runs on init/finish.
  Active, locked, unknown files and explicit --dir runs never age-delete automatically.`,
};

const COMMAND_HELP = {
  guide: 'herdr-axi guide [keywords]  # alias: herdr-axi --skill\n  TOON: no keywords = full compact workflow; e.g. guide "start opus", guide "quota switch", guide "stop worker".\n  Local routing; precise recipes only; no backend/model call or action executed.',
  agents: "herdr-axi agents [--state working|blocked|idle|done|unknown] [--kind claude|codex|copilot] [--all]\n  Selected run by default; --all lists globally. Fields: name, kind, state, pane.\n  No selected run: discovery only, not ownership. New agents: herdr-axi run init, then run queue/next; never raw agent start.",
  fleet: "herdr-axi fleet [--all]\n  Selected run: owned tasks, review queue, capacity. --all: global discovery, not ownership.\n  New agents: herdr-axi run init, then run queue/next. Titles: herdr-axi agents.",
  read: "herdr-axi read <pane> [--raw] [--full] [--lines N] [--chars N]\n  Default: compact text; 60 visible lines, 8000 characters.\n  --raw preserves layout (diagrams, tables, approval menus); limits still apply.\n  --full reads history, still compact unless --raw; 2000-line cap, no default character cap. May require a settled agent.\n  --lines and --chars override defaults; --full never exceeds 2000 lines.\n  --compact remains a compatibility alias for the default; cannot combine with --raw.",
  dispatch: 'herdr-axi dispatch <pane> "<task>" [--no-wait] [--timeout-ms N]\n  Submit and wait for a post-submission settled state. Refuses a working agent.\n  --no-wait confirms submission only; a separate wait may match pre-start idle.\nherdr-axi dispatch <pane> --keys <key> [<key>...]\n  Send explicit UI keys (e.g. down enter) and return immediately. Inspect the dialog before answering; never automatically approve it.',
  wait: "herdr-axi wait <pane> --until <state> [--timeout-ms N]\n  Wait for a state (default idle, also matches background done). Reports actual reached state. Unknown is not completion. Settled state does not prove background work has finished.",
  watch: "herdr-axi watch [--timeout-ms N]  # alias: herdr-axi run watch\n  Owner only; one blocking wait/run, default 30s. Duplicate watcher: WATCH_ACTIVE. No prompt injection.\n  Use one watch --timeout-ms 1800000 in a harness-native tracked background job with completion delivery; then continue independent work.\n  Retain its handle; never start a duplicate. A detached PID/session ID/toast does not prove notification delivery.\n  Without callback support, do independent work first; block only when results are needed. No nohup or shell &.\n  reason:timeout = no relevant change, not completion. reason:owner-changed = stop old-owner supervision.\n  reason:attention/state-change = act on returned help; review reports included, no duplicate inbox fetch.\n  Telemetry timestamp/percentage churn alone does not wake watch; new warning levels do.",
  run: `herdr-axi run init --project <path>    # auto-detect owner; load policy; return roles
Export returned HERDR_AXI_RUN; keep it in subsequent calls.
herdr-axi run queue <task-id> --role <role> --cwd <worktree> --area <relative-path> --prompt "<task and checks>"
herdr-axi run next                     # reserve slots; start/reuse owned workers
Continue independent work. One notification-backed watch if supported; otherwise block only when dependent.
Results: run inbox -> review -> run accept <pane> --evidence "<checks>" OR run revise <pane> --prompt "<fix>".
Finish: run close <accepted-pane>, then run finish.
Stop unfinished work: run cancel <pane> --evidence "authorized stop; partial state/background jobs reviewed". Whole tab; no worktree deletion.
Limits: run switch --help (worker); run takeover --help (owner). watch and run watch are equivalent.
One writer/worktree; readers reserve too. Busy: run move --help. Never auto-approve dialogs.
No fleet/config/layout preflight. No raw worker startup. Phases explore/build/integrate/verify/fix: 4/3/2/2/1.
Details: herdr-axi run <action> --help. All actions: herdr-axi run --help --full.`,
};

const argv = process.argv.slice(2);
if (argv[0] === "--skill") argv[0] = "guide";
await runAxiCli({
  argv,
  initialize: () => {
    if (argv[0] === "start") throw new AxiError(
      "No standalone start: run init -> queue -> next. No manual pane/layout preflight.",
      "VALIDATION_ERROR", [...(process.env.HERDR_AXI_RUN ? [] : ["herdr-axi run init"]), "herdr-axi run queue --help"]);
  },
  version: "0.1.0",
  description: "Herdr fleet control: init -> returned queue --start. Optional TOON help: guide <intent keywords>. Owned pane IDs only.",
  topLevelHelp: HELP,
  getCommandHelp: (c) => {
    if (c === "run") {
      const action = argv[1];
      if (action && !action.startsWith("--")) return Object.hasOwn(RUN_HELP, action) ? `${RUN_HELP[action]}\nTOON help: herdr-axi guide <intent keywords>; e.g. "start opus".\n` : null;
      if (argv.includes("--full")) return Object.values(RUN_HELP).join("\n") + "\n";
    }
    return Object.hasOwn(COMMAND_HELP, c) ? `${COMMAND_HELP[c]}\nTOON help: herdr-axi guide "start opus" (or 2-3 intent keywords).\n` : null;
  },
  home: () => home(),
  commands: {
    __proto__: null,
    guide: (a) => {
      if (a.some((arg) => arg.startsWith("--"))) throw new AxiError("guide accepts intent keywords, not native flags", "INVALID_VALUE", ["herdr-axi guide"]);
      const result = guide(a);
      if (result.error) throw new AxiError(result.error, result.code, result.examples ?? ["herdr-axi guide"]);
      return result;
    },
    agents: (a) => agents(a),
    fleet: (a) => fleetCmd(a),
    read: (a) => read(a),
    dispatch: (a) => dispatch(a),
    wait: (a) => wait(a),
    watch: (a) => watch(a),
    run: (a) => run(a),
  },
});
