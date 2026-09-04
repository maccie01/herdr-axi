#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { home, agents, fleetCmd, read, wait, dispatch, watch, run } from "../src/commands.mjs";

const HELP = `Run \`herdr-axi <command>\` - commands: agents, fleet, read, dispatch, wait, watch, run
Bare \`herdr-axi\`: fleet state + next action. Target pane IDs (w1:pP), never titles.
Orchestrating? run init, set HERDR_AXI_RUN, then queue -> next -> watch -> inbox -> accept/revise.
Selected runs scope fleet/read/wait to owned workers; self is excluded. --all lists globally.
Phase caps explore/build/integrate/verify/fix: 4/3/2/2/1. One writer/worktree; configured native reviewers only.
read <pane>: compact text; --raw for layout, --full for history (combinable).
dispatch <pane> "<task>": submit + wait. --no-wait confirms submission only.
wait <pane>: idle or background done; unknown never proves completion.
Inspect blocked input with read --raw before dispatch --keys; never auto-approve.
Details: herdr-axi <command> --help. Startup/layout: herdr agent start --help.`;

const COMMAND_HELP = {
  agents: "herdr-axi agents [--state working|blocked|idle|done|unknown] [--kind claude|codex|copilot] [--all]\n  Selected run by default; --all lists globally. Fields: name, kind, state, pane.",
  fleet: "herdr-axi fleet [--all]\n  Selected run: owned tasks, review queue, capacity. --all: global counts and pane IDs. Titles: herdr-axi agents.",
  read: "herdr-axi read <pane> [--raw] [--full] [--lines N] [--chars N]\n  Default: compact text; 60 visible lines, 8000 characters.\n  --raw preserves layout (diagrams, tables, approval menus); limits still apply.\n  --full reads history, still compact unless --raw; 2000-line cap, no default character cap. May require a settled agent.\n  --lines and --chars override defaults; --full never exceeds 2000 lines.\n  --compact remains a compatibility alias for the default; cannot combine with --raw.",
  dispatch: 'herdr-axi dispatch <pane> "<task>" [--no-wait] [--timeout-ms N]\n  Submit and wait for a post-submission settled state. Refuses a working agent.\n  --no-wait confirms submission only; a separate wait may match pre-start idle.\nherdr-axi dispatch <pane> --keys <key> [<key>...]\n  Send explicit UI keys (e.g. down enter) and return immediately. Inspect the dialog before answering; never automatically approve it.',
  wait: "herdr-axi wait <pane> --until <state> [--timeout-ms N]\n  Wait for a state (default idle, also matches background done). Reports actual reached state. Unknown is not completion. Settled state does not prove background work has finished.",
  watch: "herdr-axi watch [--timeout-ms N]\n  Selected run: wait up to 30s for a fleet change; return actionable states immediately. No prompt injection. Repeat when changed:false.",
  run: `herdr-axi run init [--project <path>] [--dir <external-run-dir>] [--owner <pane>]
  Load project-root .herdr-axi.json; snapshot roles/models/effort, caps, layout, context, retention.
  Default state: ~/.local/state/herdr-axi (override HERDR_AXI_STATE_HOME); never inside the project.
  Owner: HERDR_PANE_ID or pane current --current, never focus. Export returned HERDR_AXI_RUN.
herdr-axi run config
  Effective config. Orchestrator role is a launch contract; never restarts the current owner.
herdr-axi run queue <task-id> --role <role> --cwd <path> --area <relative-path> --prompt-file <path> [--after task-id,task-id]
  Legacy --kind claude|codex|copilot instead of --role. Explicit acceptance criteria. 128 tasks/run.
herdr-axi run next
  Reserve free slots; concurrent starts; reuse matching kind/cwd/policy. One writer per worktree.
  Read-only verifiers may overlap; final verification needs an accepted writer dependency.
  Pending/unknown/unreviewed work occupies slots. Native leaf reviewers have a separate bounded budget.
herdr-axi run status | inbox
  Owned fleet only, context warnings, summaries <=600 chars/worker. No owner prompt injection.
herdr-axi run accept <pane> --evidence "review and checks"
  Current generation proof + settlement + explicit review; releases task and writer capacity.
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
  or requeue only after all registered resources are verified absent.
herdr-axi run unlock
  Dead transaction holder only. Writer leases fail closed after an unrecorded crash; inspect before manual recovery.
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
