#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

// Standalone fake backend. This executable never imports or launches a test suite.
const pane = "w1:pTEST";
const args = process.argv.slice(2);
if (!["agent", "machine"].includes(args[0])) {
  console.error(JSON.stringify({ error: { code: "unsupported", message: `fake herdr (${process.argv[1].split("/").pop()}): unhandled command ${process.argv.slice(2).join(" ")}` } }));
  process.exit(2);
}
appendFileSync(process.env.AXI_TEST_LOG, JSON.stringify(args) + "\n");
const scenario = process.env.AXI_TEST_SCENARIO;
const agent = { pane_id: pane, agent: "codex", agent_status: "idle", terminal_title_stripped: "Title with spaces" };
const emit = (result) => console.log(JSON.stringify({ id: "cli:test", result }));
const fail = (code, message, stream = "stderr") => {
  process[stream].write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};
if (args[0] === "machine") {
  assert.deepEqual(args, ["machine", "list", "--json"]);
  console.log(JSON.stringify([
    { id: "studio", label: "Studio", target: "ops@example", session: "main", enabled: true, selected: true },
    { id: "lab", label: "Lab", target: "lab@example", session: "agents", enabled: false, selected: false },
  ]));
} else if (args[1] === "list") {
  if (scenario === "ipc-denied") fail("io_error", "Operation not permitted (os error 1) while connecting to socket");
  if (scenario === "empty-json") process.exit(0);
  if (scenario === "invalid-json") { console.log("not JSON"); process.exit(0); }
  if (["working", "blocked", "unknown", "done"].includes(scenario)) agent.agent_status = scenario;
  if (scenario === "empty") emit({ agents: [] });
  else if (scenario === "mixed") emit({ agents: ["done", "unknown", "idle", "working", "blocked"].map((state, i) => ({ ...agent, pane_id: `w1:p${i}`, agent_status: state })) });
  else if (scenario === "many") emit({ agents: Array.from({ length: 13 }, (_, i) => ({ ...agent, pane_id: `w1:p${i}` })) });
  else emit({ agents: [agent] });
} else if (args[1] === "explain") {
  assert.deepEqual(args, ["agent", "explain", pane, "--json"]);
  console.log(JSON.stringify({
    agent: "codex", state: "blocked", manifest_source: "bundled", manifest_version: "4",
    cached_remote_version: "5", local_override_shadowing_remote: false, remote_update_status: "current",
    matched_rule: { id: "approval", state: "blocked", region: "tail", priority: 10 },
    visible_idle: false, visible_blocker: true, visible_working: false, screen_detection_skipped: true,
    screen_detection_skip_reason: "full_lifecycle_hook_authority", skip_state_update: true,
    evaluated_rules: [{ id: "approval", state: "blocked", region: "tail", priority: 10, matched: true,
      evidence: { contains: ["Approve?"], regex: [], line_regex: [], region_bytes: 400, region_preview: "Approve?" } }],
  }));
} else if (args[1] === "read") {
  if (scenario === "read-error") fail("pane_not_found", "pane disappeared");
  if (scenario === "read-active") fail("read_failed", "alternate-screen history can only be captured by scrolling while idle");
  if (scenario === "empty-output") process.exit(0);
  if (scenario === "json-output") { console.log('{"error":{"message":"agent output, not a protocol error"}}'); process.exit(0); }
  if (scenario === "chrome") {
    console.log(Array.from({ length: 8 }, (_, i) => ["─".repeat(180), `│ Step ${i + 1}: keep this text${" ".repeat(150)}│`, "", "", "  indented code", "│" + "─".repeat(178) + "│"].join("\n")).join("\n"));
    process.exit(0);
  }
  if (scenario === "long-line") { console.log("😀".repeat(12000) + "END"); process.exit(0); }
  if (scenario === "layout-only") { console.log("┌─────┐\n│     │\n└─────┘"); process.exit(0); }
  if (scenario === "padding") { process.stdout.write("  indented text  \n\n  \n"); process.exit(0); }
  const count = Number(args[args.indexOf("--lines") + 1]);
  console.log(Array.from({ length: count }, (_, i) => `line-${i + 1}`).join("\n"));
} else if (args[1] === "prompt") {
  if (scenario === "blocked") fail("agent_blocked", "interactive input required");
  if (scenario === "stalled") fail("agent_prompt_stalled", "no lifecycle change", "stdout");
  if (scenario === "timeout") fail("timeout", "timed out waiting for agent status");
  if (!args.includes("--wait")) emit({ prompt_delivered: true });
  else {
    // The native wait owns the idle -> working -> done observation.
    assert.equal(args[args.indexOf("--timeout") + 1], "1000");
    emit({ agent: { ...agent, agent_status: "done" } });
  }
} else if (args[1] === "wait") {
  assert(!args.includes("--timeout-ms"));
  assert(!args.some((a) => a.includes(",")));
  if (scenario === "syntax") { console.error("unknown option: --timeout-ms"); process.exit(2); }
  if (scenario === "disappeared") fail("agent_not_found", "agent disappeared during wait");
  if (["timeout", "unknown"].includes(scenario)) fail("timeout", "timed out waiting for agent status");
  emit({ agent: { ...agent, agent_status: "done" } });
} else if (args[1] === "send-keys") emit({ sent: true });
else throw new Error(`unexpected fake herdr call: ${args}`);
