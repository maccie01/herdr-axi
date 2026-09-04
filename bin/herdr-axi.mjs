#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { home, agents, fleetCmd, read, wait, dispatch, watch } from "../src/commands.mjs";

const HELP = `Run \`herdr-axi <command>\` - commands: agents, fleet, read, dispatch, wait, watch
Bare \`herdr-axi\` shows live fleet state.`;

const COMMAND_HELP = {
  agents: "herdr-axi agents [--state working|blocked|idle|done|unknown] [--kind claude|codex|copilot]\n  List live agents: name, kind, state, pane.",
  fleet: "herdr-axi fleet\n  Aggregate counts and pane IDs for every state in one call.",
  read: "herdr-axi read <pane> [--lines N] [--full]\n  Last 60 visible lines by default. --full reads available history, capped at 2000 lines; alternate-screen history may require a settled agent.",
  dispatch: 'herdr-axi dispatch <pane> "<task>" [--no-wait] [--timeout-ms N]\n  Submit and wait for a post-submission settled state. Refuses a working agent.\n  --no-wait confirms submission only; a separate wait may match pre-start idle.\nherdr-axi dispatch <pane> --keys <key> [<key>...]\n  Send explicit UI keys (e.g. down enter) and return immediately. Inspect the dialog before answering; never automatically approve it.',
  wait: "herdr-axi wait <pane> --until <state> [--timeout-ms N]\n  Wait for a state (default idle, also matches background done). Reports actual reached state. Unknown is not completion. Settled state does not prove background work has finished.",
  watch: "herdr-axi watch [engine args]\n  Run the bash supervision engine (receipts, generations, lifecycle).",
};

await runAxiCli({
  version: "0.1.0",
  description: "Agent-ergonomic CLI for herdr fleet supervision. Prefer this over raw `herdr` for agent and fleet operations.",
  topLevelHelp: HELP,
  getCommandHelp: (c) => COMMAND_HELP[c] ?? null,
  home: () => home(),
  commands: {
    agents: (a) => agents(a),
    fleet: () => fleetCmd(),
    read: (a) => read(a),
    dispatch: (a) => dispatch(a),
    wait: (a) => wait(a),
    watch: (a) => watch(a),
  },
});
