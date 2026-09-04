#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { home, agents, fleetCmd, read, wait, dispatch, watch } from "../src/commands.mjs";

const HELP = `Run \`herdr-axi <command>\` - commands: agents, fleet, read, dispatch, wait, watch
Bare \`herdr-axi\`: fleet state + next action. Target pane IDs (w1:pP), never titles.
read <pane>: compact text; --raw for layout, --full for history (combinable).
dispatch <pane> "<task>": submit + wait. --no-wait confirms submission only.
wait <pane>: idle or background done; unknown never proves completion.
Inspect blocked input with read --raw before dispatch --keys; never auto-approve.
Details: herdr-axi <command> --help. Startup/layout: herdr agent start --help.`;

const COMMAND_HELP = {
  agents: "herdr-axi agents [--state working|blocked|idle|done|unknown] [--kind claude|codex|copilot]\n  List live agents: name, kind, state, pane.",
  fleet: "herdr-axi fleet\n  Counts and pane IDs by state; one priority action. Titles: herdr-axi agents.",
  read: "herdr-axi read <pane> [--raw] [--full] [--lines N] [--chars N]\n  Default: compact text; 60 visible lines, 8000 characters.\n  --raw preserves layout (diagrams, tables, approval menus); limits still apply.\n  --full reads history, still compact unless --raw; 2000-line cap, no default character cap. May require a settled agent.\n  --lines and --chars override defaults; --full never exceeds 2000 lines.\n  --compact remains a compatibility alias for the default; cannot combine with --raw.",
  dispatch: 'herdr-axi dispatch <pane> "<task>" [--no-wait] [--timeout-ms N]\n  Submit and wait for a post-submission settled state. Refuses a working agent.\n  --no-wait confirms submission only; a separate wait may match pre-start idle.\nherdr-axi dispatch <pane> --keys <key> [<key>...]\n  Send explicit UI keys (e.g. down enter) and return immediately. Inspect the dialog before answering; never automatically approve it.',
  wait: "herdr-axi wait <pane> --until <state> [--timeout-ms N]\n  Wait for a state (default idle, also matches background done). Reports actual reached state. Unknown is not completion. Settled state does not prove background work has finished.",
  watch: "herdr-axi watch [engine args]\n  Run the bash supervision engine (receipts, generations, lifecycle).",
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
  },
});
