#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { home, agents, fleetCmd, read, wait, dispatch, watch } from "../src/commands.mjs";

const HELP = `Run \`herdr-axi <command>\` - commands: agents, fleet, read, dispatch, wait, watch
Bare \`herdr-axi\` shows live fleet state.`;

const COMMAND_HELP = {
  agents: "herdr-axi agents [--state working|blocked|idle|done|unknown] [--kind claude|codex|copilot]\n  List live agents: name, kind, state, pane.",
  fleet: "herdr-axi fleet\n  Aggregate counts by state plus blocked/working/idle names in one call.",
  read: "herdr-axi read <agent> [--lines N] [--full]\n  Read an agent's visible output. Defaults to the last 60 lines.",
  dispatch: 'herdr-axi dispatch <agent> "<task>" [--no-wait] [--timeout-ms N]\n  Submit a task and wait until the agent settles. Refuses a working agent.',
  wait: "herdr-axi wait <agent> --until <state> [--timeout-ms N]\n  Block until the agent reaches a state.",
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
