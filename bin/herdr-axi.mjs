#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { home, agents, fleetCmd, read, wait, dispatch, watch, run } from "../src/commands.mjs";

const HELP = `Run \`herdr-axi <command>\` - commands: agents, fleet, read, dispatch, wait, watch, run
Bare \`herdr-axi\`: fleet state + next action. Target pane IDs (w1:pP), never titles.
Starting/delegating agents: herdr-axi run init --project <path>; export returned HERDR_AXI_RUN.
Then run queue -> run next -> watch -> run inbox -> run accept/revise. Details: herdr-axi run --help.
While workers run: continue independent work. Arm ONE watch using a harness-native background job with completion notification, if supported.
Do not duplicate an active watch. A detached shell/PID/UI toast is not agent notification. Without callback support, block only when dependent.
Inbox is for results/attention, read for a specific diagnosis. Do not repeat status after inbox; it already includes needed state.
Do not create worker panes or call raw herdr agent start/prompt. run next owns startup, layout and limits.
Selected runs scope fleet/read/wait to owned workers; self is excluded. --all lists globally.
Without a selected run: global discovery, not ownership. Never assign work to an arbitrary listed idle agent.
Phase caps explore/build/integrate/verify/fix: 4/3/2/2/1. One writer/worktree; configured native reviewers only.
read <pane>: compact text; --raw for layout, --full for history (combinable).
dispatch <pane> "<task>": submit + wait. --no-wait confirms submission only.
wait <pane>: idle or background done; unknown never proves completion.
Inspect blocked input with read --raw before dispatch --keys; never auto-approve.
Details: herdr-axi <command> --help. Raw herdr only for authorized workspace/worktree/session operations not covered here.`;

const COMMAND_HELP = {
  agents: "herdr-axi agents [--state working|blocked|idle|done|unknown] [--kind claude|codex|copilot] [--all]\n  Selected run by default; --all lists globally. Fields: name, kind, state, pane.\n  No selected run: discovery only, not ownership. New agents: herdr-axi run init, then run queue/next; never raw agent start.",
  fleet: "herdr-axi fleet [--all]\n  Selected run: owned tasks, review queue, capacity. --all: global discovery, not ownership.\n  New agents: herdr-axi run init, then run queue/next. Titles: herdr-axi agents.",
  read: "herdr-axi read <pane> [--raw] [--full] [--lines N] [--chars N]\n  Default: compact text; 60 visible lines, 8000 characters.\n  --raw preserves layout (diagrams, tables, approval menus); limits still apply.\n  --full reads history, still compact unless --raw; 2000-line cap, no default character cap. May require a settled agent.\n  --lines and --chars override defaults; --full never exceeds 2000 lines.\n  --compact remains a compatibility alias for the default; cannot combine with --raw.",
  dispatch: 'herdr-axi dispatch <pane> "<task>" [--no-wait] [--timeout-ms N]\n  Submit and wait for a post-submission settled state. Refuses a working agent.\n  --no-wait confirms submission only; a separate wait may match pre-start idle.\nherdr-axi dispatch <pane> --keys <key> [<key>...]\n  Send explicit UI keys (e.g. down enter) and return immediately. Inspect the dialog before answering; never automatically approve it.',
  wait: "herdr-axi wait <pane> --until <state> [--timeout-ms N]\n  Wait for a state (default idle, also matches background done). Reports actual reached state. Unknown is not completion. Settled state does not prove background work has finished.",
  watch: "herdr-axi watch [--timeout-ms N]\n  Selected run: one blocking wait, up to 30s. No prompt injection.\n  Notification workflow: one watch --timeout-ms 1800000 in a harness-native tracked background job with completion delivery; then continue your own work.\n  Keep its job handle; never start a duplicate. A returned PID/session ID alone does not prove notification delivery.\n  Without callback support, do independent work first; block only when worker results are needed. No nohup, shell &, or fake notification promises.\n  reason:timeout = no relevant change, compact response; continue independent work or wait again if dependent.\n  reason:attention/state-change = act on the result/help, not another polling loop.\n  Telemetry timestamp/percentage churn alone does not wake watch; new warning levels do.",
  run: `herdr-axi run init [--project <path>] [--dir <external-run-dir>] [--owner <pane>]
  Required workflow for agent delegation. Never manually split a worker pane or call raw agent start/prompt/close.
  Load project-root .herdr-axi.json; snapshot roles/models/effort, caps, layout, context, retention.
  Default state: ~/.local/state/herdr-axi (override HERDR_AXI_STATE_HOME); never inside the project.
  Owner: HERDR_PANE_ID or pane current --current, never focus. Export returned HERDR_AXI_RUN.
herdr-axi run config
  Effective config. Orchestrator role is a launch contract; never restarts the current owner.
herdr-axi run queue <task-id> --role <role> --cwd <path> --area <relative-path> --prompt-file <path> [--after task-id,task-id]
  Legacy --kind claude|codex|copilot instead of --role. Explicit acceptance criteria. 128 tasks/run.
herdr-axi run next
  Reserve free slots; concurrent starts; reuse matching kind/cwd/policy. One writer per worktree.
  Separate worktrees for parallel work; sharedReadWorktree opts into instruction-only verifier overlap within this run only.
  Final verification needs an accepted writer dependency.
  Pending/unknown/unreviewed work occupies slots. Native leaf reviewers have a separate bounded budget.
herdr-axi run status | inbox
  Owned fleet only, context warnings, summaries <=600 chars/worker. Collection/ownership errors remain visible.
  Inbox already includes needed status. Empty while working: independent work or watch, not repeated inbox/read.
herdr-axi run accept <pane> --evidence "review and checks" [--result-file FILE]
  Current generation proof + settlement + saved result + explicit review. No silent report loss.
  Missing/corrupt inbox: retry inbox, or supply a reviewed replacement (1..3500 chars); recorded as coordinator-replacement.
herdr-axi run revise <pane> --prompt-file <fix-task>
  Same worker/slot; retain revision history. Max eight revisions, then explicitly re-scope.
herdr-axi run phase explore|build|integrate|verify|fix [--cap 1..16]
  Defaults 4/3/2/2/1. Never narrow below outstanding work; retire surplus accepted workers.
  Queued tasks keep their phase; return to it or cancel/requeue explicitly.
herdr-axi run close <pane>
  Accepted owned workers only; generation and topology checks. Never closes the owner tab.
herdr-axi run cancel <task-id>
  Queued tasks only.
herdr-axi run recover <pane-or-task-id>
  Inspect first. Resume approved startup, acknowledge uncertain submission without resend,
  or requeue only after all registered resources are verified absent. Accepted/cancelled tasks: repair their leftover lease only, even archived/offline.
herdr-axi run leases
  Exact lease paths, owner and holder tasks. Unknown ownership requires inspection, never automatic deletion.
herdr-axi run unlock
  Remove only run.lock for a verified dead transaction holder. Does not release worktree leases.
herdr-axi run finish
  Accepted/cancelled tasks + closed workers required. Archive detail; prune known runtime files.
herdr-axi run history [--task <task-id> | --all]
  Compact task/review/decision trail; --all lists latest eight managed runs for this project.
herdr-axi run gc
  Expire finished managed records only: detail 30d, summary 180d by default. Also runs on init/finish.
  Active, locked, unknown files and explicit --dir runs never age-delete automatically.`,
};

await runAxiCli({
  version: "0.1.0",
  description: "Herdr fleet control; target pane IDs. Reads compact by default: --raw for layout, --full for history. Use herdr-axi --help for workflow.",
  topLevelHelp: HELP,
  getCommandHelp: (c) => Object.hasOwn(COMMAND_HELP, c) ? `${COMMAND_HELP[c]}\n` : null,
  home: () => home(),
  commands: {
    __proto__: null,
    agents: (a) => agents(a),
    fleet: (a) => fleetCmd(a),
    read: (a) => read(a),
    dispatch: (a) => dispatch(a),
    wait: (a) => wait(a),
    watch: (a) => watch(a),
    run: (a) => run(a),
  },
});
