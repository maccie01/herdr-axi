#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const self = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL("../bin/herdr-axi.mjs", import.meta.url));
const pane = "w1:pTEST";

// This file doubles as an isolated HERDR_BIN. No call can reach real panes.
if (process.argv[2] === "agent") {
  const args = process.argv.slice(2);
  appendFileSync(process.env.AXI_TEST_LOG, JSON.stringify(args) + "\n");
  const scenario = process.env.AXI_TEST_SCENARIO;
  const agent = { pane_id: pane, agent: "codex", agent_status: "idle", terminal_title_stripped: "Title with spaces" };
  const emit = (result) => console.log(JSON.stringify({ id: "cli:test", result }));
  const fail = (code, message, stream = "stderr") => {
    process[stream].write(JSON.stringify({ error: { code, message } }));
    process.exit(1);
  };
  if (args[1] === "list") {
    if (scenario === "invalid-json") { console.log("not JSON"); process.exit(0); }
    if (["working", "blocked", "unknown", "done"].includes(scenario)) agent.agent_status = scenario;
    if (scenario === "empty") emit({ agents: [] });
    else if (scenario === "mixed") emit({ agents: ["done", "unknown", "idle", "working", "blocked"].map((state, i) => ({ ...agent, pane_id: `w1:p${i}`, agent_status: state })) });
    else if (scenario === "many") emit({ agents: Array.from({ length: 13 }, (_, i) => ({ ...agent, pane_id: `w1:p${i}` })) });
    else emit({ agents: [agent] });
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
} else {
  function run(args, scenario = "idle") {
    const dir = mkdtempSync(path.join(tmpdir(), "herdr-axi-test-"));
    const log = path.join(dir, "calls");
    try {
      const r = spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8", timeout: 10000,
        env: { ...process.env, HERDR_AXI_RUN: "", HERDR_BIN: self, AXI_TEST_SCENARIO: scenario, AXI_TEST_LOG: log },
      });
      assert.ifError(r.error);
      let calls = [];
      try { calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      return { ...r, calls, output: r.stdout + r.stderr };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("dispatch uses native transition-aware wait, not a second stale idle poll", () => {
    const r = run(["dispatch", pane, "hello", "--timeout-ms", "1000"]);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.calls, [["agent", "list"], ["agent", "prompt", pane, "hello", "--wait", "--timeout", "1000"]]);
    assert.match(r.output, /state: done/);
    assert.match(r.output, /herdr-axi read w1:pTEST/);
  });

  test("no-wait submits once without claiming settlement", () => {
    const r = run(["dispatch", pane, "hello", "--no-wait"]);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.calls.at(-1), ["agent", "prompt", pane, "hello"]);
    assert.equal(r.calls.length, 2);
    assert.match(r.output, /Submission only/);
    assert.doesNotMatch(r.output, /state:/);
  });

  test("busy rejection never sends input and suggestions use pane IDs", () => {
    const r = run(["dispatch", pane, "hello"], "working");
    assert.equal(r.status, 1);
    assert.match(r.output, /code: AGENT_BUSY/);
    assert.match(r.output, /herdr-axi wait w1:pTEST/);
    assert.equal(r.calls.length, 1);
  });

  test("idle wait accepts unseen done and reports the actual matched state", () => {
    const r = run(["wait", pane, "--until", "idle", "--timeout-ms", "1000"]);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.calls.at(-1), ["agent", "wait", pane, "--until", "idle", "--until", "done", "--timeout", "1000"]);
    assert.match(r.output, /requested: idle/);
    assert.match(r.output, /reached: done/);
  });

  test("unknown does not count as completion", () => {
    const r = run(["wait", pane, "--timeout-ms", "1000"], "unknown");
    assert.equal(r.status, 1);
    assert.match(r.output, /code: TIMEOUT/);
    assert.doesNotMatch(r.output, /reached:/);
  });

  test("timeout, disappearing pane, and CLI syntax errors remain distinct", () => {
    for (const [scenario, code] of [["timeout", "TIMEOUT"], ["disappeared", "UNKNOWN_AGENT"], ["syntax", "HERDR_CLI_ERROR"]]) {
      const r = run(["wait", pane, "--timeout-ms", "1000"], scenario);
      assert.equal(r.status, 1);
      assert.match(r.output, new RegExp(`code: ${code}`));
      assert.match(r.output, /help/);
    }
  });

  test("prompt errors decode both stderr and stdout envelopes", () => {
    for (const [scenario, code] of [["blocked", "AGENT_BLOCKED"], ["stalled", "PROMPT_STALLED"]]) {
      const r = run(["dispatch", pane, "hello"], scenario);
      assert.equal(r.status, 1);
      assert.match(r.output, new RegExp(`code: ${code}`));
      assert.match(r.output, /herdr-axi read w1:pTEST/);
    }
  });

  test("explicit key dispatch can answer blocked controls without prompting", () => {
    const r = run(["dispatch", pane, "--keys", "down", "enter"], "blocked");
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.calls.at(-1), ["agent", "send-keys", pane, "down", "enter"]);
  });

  test("dispatch sends the complete task without echoing it into context", () => {
    const task = "long task ".repeat(1000);
    for (const flags of [["--no-wait"], ["--timeout-ms", "1000"]]) {
      const r = run(["dispatch", pane, task, ...flags]);
      assert.equal(r.status, 0, r.output);
      assert.equal(r.calls.at(-1)[3], task.trim());
      assert.match(r.output, /submitted: true/);
      assert.doesNotMatch(r.output, /long task/);
      assert(Buffer.byteLength(r.output) < 250);
    }
  });

  test("fleet keeps all IDs and counts without repeating titles", () => {
    for (const args of [[], ["fleet"]]) {
      const r = run(args, "many");
      assert.equal(r.status, 0, r.output);
      for (let i = 0; i < 13; i++) assert(r.output.includes(`w1:p${i}`));
      assert.doesNotMatch(r.output, /Title with spaces/);
      assert.match(r.output, /help\[2\]/);
    }
    const r = run(["agents"], "many");
    assert.match(r.output, /Title with spaces/);
    const mixed = run(["fleet"], "mixed");
    assert.match(mixed.output, /herdr-axi run init/);
    for (let i = 0; i < 5; i++) assert(mixed.output.includes(`w1:p${i}`));
  });

  test("compact reads remove layout noise while preserving text and indentation", () => {
    const raw = run(["read", pane, "--full", "--raw"], "chrome");
    const compact = run(["read", pane], "chrome");
    assert.equal(compact.status, 0, compact.output);
    assert.match(raw.output, /─{8}/);
    assert.doesNotMatch(compact.output, /─{8}/);
    for (let i = 1; i <= 8; i++) assert(compact.output.includes(`Step ${i}: keep this text`));
    assert.match(compact.output, /  indented code/);
    assert.doesNotMatch(compact.output, /raw: true/);
    assert.equal(run(["read", pane, "--compact"], "chrome").output, compact.output);
    assert(Buffer.byteLength(compact.output) < Buffer.byteLength(raw.output) / 5);
  });

  test("history and formatting are independent; raw preserves terminal padding", () => {
    for (const raw of [false, true]) for (const full of [false, true]) {
      const r = run(["read", pane, ...(raw ? ["--raw"] : []), ...(full ? ["--full"] : [])], "chrome");
      assert.equal(r.status, 0, r.output);
      assert.equal(r.output.includes("─".repeat(8)), raw);
      assert.equal(r.output.includes("raw: true"), raw);
      assert.equal(r.calls.at(-1)[4], full ? (raw ? "recent" : "recent-unwrapped") : "visible");
    }
    const padded = run(["read", pane, "--raw"], "padding");
    const value = padded.output.split("\n").find((line) => line.startsWith("output: ")).slice(8);
    assert.equal(JSON.parse(value), "  indented text  \n\n  ");
    const limited = run(["read", pane, "--full", "--lines", "5", "--chars", "10", "--raw"]);
    assert.equal(limited.status, 0, limited.output);
    assert.equal(limited.calls.at(-1).at(-1), "6");
    assert.match(limited.output, /5-line cap, 10-character cap/);
    assert.equal(run(["read", pane, "--full", "--lines", "NaN"]).status, 1);
  });

  test("layout-only content is disclosed and blocked reads offer raw inspection", () => {
    const r = run(["read", pane], "layout-only");
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /layout-only output/);
    assert.match(r.output, /herdr-axi read w1:pTEST --raw/);
    assert.doesNotMatch(r.output, /no visible output/);
    const blocked = run(["read", pane, "--lines", "5"], "blocked");
    assert.match(blocked.output, /herdr-axi read w1:pTEST --lines 120/);
    assert.doesNotMatch(blocked.output, /--full/);
  });

  test("character caps bound long lines without splitting Unicode characters", () => {
    const r = run(["read", pane, "--chars", "8"], "long-line");
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /😀😀😀😀😀END/);
    assert.match(r.output, /8-character cap/);
    assert.match(r.output, /herdr-axi read w1:pTEST --lines 60 --chars 12003/);
    assert.doesNotMatch(r.output, /�/);
    assert.match(run(["read", pane], "long-line").output, /8000-character cap/);
    const full = run(["read", pane, "--full"], "long-line");
    assert.doesNotMatch(full.output, /truncated:/);
    assert.equal(run(["read", pane, "--chars", "NaN"]).status, 1);
  });

  test("read honors HERDR_BIN, retains the tail, and announces truncation", () => {
    const r = run(["read", pane, "--lines", "5"]);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.calls.at(-1), ["agent", "read", pane, "--source", "visible", "--lines", "6"]);
    assert.doesNotMatch(r.output, /line-1/);
    assert.match(r.output, /line-2/);
    assert.match(r.output, /line-6/);
    assert.match(r.output, /truncated:/);
  });

  test("full read uses scrollback with a disclosed 2000-line cap", () => {
    const r = run(["read", pane, "--full"]);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.calls.at(-1), ["agent", "read", pane, "--source", "recent-unwrapped", "--lines", "2001"]);
    assert.match(r.output, /2000-line cap/);
  });

  test("failed reads never masquerade as empty successful output", () => {
    for (const [scenario, code] of [["read-error", "UNKNOWN_AGENT"], ["read-active", "READ_UNAVAILABLE"]]) {
      const r = run(["read", pane, "--full"], scenario);
      assert.equal(r.status, 1);
      assert.match(r.output, new RegExp(`code: ${code}`));
      assert.doesNotMatch(r.output, /no visible output/);
    }
    assert.match(run(["read", pane], "empty-output").output, /no visible output/);
  });

  test("terminal JSON is output, not a backend error envelope", () => {
    const r = run(["read", pane], "json-output");
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /agent output, not a protocol error/);
  });

  test("invalid numbers and missing values fail before dispatch", () => {
    for (const value of ["NaN", "-1", "0", "1.5", "Infinity", "99999999999999999"]) {
      const r = run(["dispatch", pane, "hello", "--timeout-ms", value]);
      assert.equal(r.status, 1);
      assert.match(r.output, /code: INVALID_VALUE/);
      assert(!r.calls.some((a) => a[1] === "prompt"));
    }
    const r = run(["read", pane, "--lines", "--full"]);
    assert.equal(r.status, 1);
    assert.match(r.output, /code: MISSING_VALUE/);
    assert.equal(r.calls.length, 0);
  });

  test("names cannot target panes; unknown-agent hints stay bounded", () => {
    assert.equal(run(["dispatch", "Title with spaces", "hello"]).status, 1);
    const r = run(["read", "missing"], "many");
    assert.equal(r.status, 1);
    assert.match(r.output, /\(\+5 more\)/);
    assert.doesNotMatch(r.output, /w1:p8/);
  });

  test("fleet exposes done and unknown agents; empty states are explicit", () => {
    for (const state of ["done", "unknown"]) {
      const r = run(["fleet"], state);
      assert.equal(r.status, 0);
      assert.match(r.output, new RegExp(`${state}\\[1\\]`));
      assert.match(r.output, /herdr-axi run init/);
    }
    assert.match(run([], "empty").output, /0 agents/);
    assert.match(run(["agents"], "empty").output, /0 matching agents/);
    assert.equal(run(["agents"], "invalid-json").status, 1);
  });

  test("unknown commands exit 2, invalid flags exit 1", () => {
    assert.equal(run(["nonexistent"]).status, 2);
    assert.equal(run(["constructor"]).status, 2);
    assert.equal(run(["toString", "--help"]).status, 2);
    assert.equal(run(["read", pane, "--typo"]).status, 1);
  });

  test("contradictory and misleading flags fail before touching the backend", () => {
    for (const args of [
      ["read", pane, "--raw", "--compact"], ["read", pane, "--raw=false"],
      ["dispatch", pane, "hello", "--no-wait=false"], ["fleet", "--full"],
      ["fleet", "unexpected"], ["read", pane, "unexpected"],
      ["fleet", "--toString"],
    ]) {
      const r = run(args);
      assert.equal(r.status, 1, r.output);
      assert.equal(r.calls.length, 0);
      assert(r.output.endsWith("\n"));
      assert.match(r.output, /herdr-axi .*--help/);
    }
  });

  test("agent-facing help teaches defaults and pane safety without querying the fleet", () => {
    for (const args of [["--help"], ["read", "--help"]]) {
      const r = run(args);
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, /compact/);
      assert.match(r.output, /--raw/);
      assert.match(r.output, /--full/);
      assert.equal(r.calls.length, 0);
      assert(r.output.endsWith("\n"));
    }
    assert.match(run(["--help"]).output, /pane IDs.*never titles/);
  });

  test("discovery and help direct delegation through managed runs, never arbitrary idle dispatch or raw startup", () => {
    for (const args of [[], ["agents"], ["fleet"]]) for (const scenario of ["idle", "empty"]) {
      const r = run(args, scenario);
      assert.equal(r.status, 0, r.output); assert.match(r.output, /global-discovery; ownership not implied/);
      assert.match(r.output, /herdr-axi run init/); assert.doesNotMatch(r.output, /herdr agent start|herdr-axi dispatch/);
      assert(r.calls.every((c) => c[1] === "list"));
    }
    const help = run(["--help"]);
    assert.match(help.output, /run next owns startup, layout and limits/);
    assert.match(help.output, /Do not create worker panes or call raw herdr agent start\/prompt/);
    assert.doesNotMatch(help.output, /Startup\/layout:|herdr agent start --help/);
    assert.equal(help.calls.length, 0);
  });
}
