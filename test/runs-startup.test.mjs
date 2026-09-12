import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fixture, cli } from "./support/run-fixture.mjs";

  test("missing startup session returns structured unsubmitted diagnostics and remains cancellable", () => {
    const f = fixture();
    try {
      f.ok(["run", "queue", "session-missing", "--kind", "opencode", "--cwd", f.state().project, "--area", ".", "--prompt", "Inspect only"]);
      fs.writeFileSync(path.join(f.dir, "startup-no-session"), "1");
      const result = f.execute(["run", "next"], { HERDR_SESSION_READY_TIMEOUT_SECONDS: "1" });
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /SESSION_START_UNVERIFIED/);
      assert.match(result.output, /submitted: false/);
      assert.equal(f.state().tasks[0].errorCode, "SESSION_START_UNVERIFIED");
      const status = f.ok(["run", "status"]);
      assert.match(status, /SESSION_START_UNVERIFIED/);
      assert.match(status, /not_submitted/);
      assert(!f.calls().some((call) => call.action === "prompt"));
      f.ok(["run", "cancel", "session-missing", "--evidence", "Missing native session inspected; cancel authorized"]);
      assert.equal(f.state().tasks[0].state, "cancelled");
    } finally { f.clean(); }
  });

  test("lazy Codex initialization completes before the monitored assignment is submitted", () => {
    const f = fixture();
    try {
      f.env.CODEX_HOME = path.join(f.dir, "codex");
      fs.writeFileSync(path.join(f.dir, "lazy-codex"), "complete");
      f.queue("lazy-session");
      const output = f.ok(["run", "next"]);
      assert.equal(f.state().tasks[0].state, "running", output);
      const calls = f.calls(), prompts = calls.filter(c => c.action === "prompt");
      assert.equal(prompts.length, 2, "one initialization turn followed by one assignment");
      assert.match(prompts[0].args[1], /HERDR_AXI_READY_/);
      assert.doesNotMatch(prompts[0].args[1], /Write hello|\.proof\./);
      assert.match(prompts[1].args[1], /Write hello/);
      const monitorIndex = calls.findIndex(c => c.group === "pane" && c.action === "run");
      assert(calls.indexOf(prompts[0]) < monitorIndex);
      assert(monitorIndex < calls.indexOf(prompts[1]));
      assert.equal(f.state().workers[0].bootstrap.state, "settled");
      f.ok(["run", "cancel", "lazy-session", "--evidence", "Initialization regression complete; authorized cleanup"]);
    } finally { f.clean(); }
  });

  test("pending Codex initialization is visible and recovery never replays its input", () => {
    const f = fixture();
    try {
      f.env.CODEX_HOME = path.join(f.dir, "codex");
      f.env.HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS = "1";
      fs.writeFileSync(path.join(f.dir, "lazy-codex"), "pending");
      f.queue("initializing");
      const output = f.ok(["run", "next"]);
      assert.match(output, /CODEX_BOOTSTRAP_PENDING/);
      assert.equal(f.state().tasks[0].state, "uncertain");
      const status = f.ok(["run", "status"]);
      assert.match(status, /bootstrap: pending/);
      assert.match(status, /initialization|Initialization/);
      assert.doesNotMatch(status, /No task input sent/);
      const recovery = f.execute(["run", "recover", "initializing"]);
      assert.match(recovery.output, /CODEX_BOOTSTRAP_PENDING/);
      const prompts = f.calls().filter(c => c.action === "prompt");
      assert.equal(prompts.length, 1, "ambiguous initialization is never resubmitted");
      assert.doesNotMatch(prompts[0].args[1], /Write hello|\.proof\./);
      assert(!f.calls().some(c => c.group === "pane" && c.action === "split"));
      f.ok(["run", "cancel", "initializing", "--evidence", "Unconfirmed initialization inspected; cleanup authorized"]);
      assert.equal(f.state().tasks[0].state, "cancelled");
    } finally { f.clean(); }
  });

  test("late Codex initialization evidence releases one assignment without another initialization turn", () => {
    const f = fixture();
    try {
      f.env.CODEX_HOME = path.join(f.dir, "codex");
      f.env.HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS = "1";
      fs.writeFileSync(path.join(f.dir, "lazy-codex"), "pending");
      f.queue("late-initialization"); f.ok(["run", "next"]);
      const worker = f.state().workers[0];
      const prompt = f.calls().find(c => c.action === "prompt").args[1];
      const reply = prompt.match(/HERDR_AXI_READY_[A-Za-z0-9_-]+/)[0];
      const session = randomUUID(), file = path.join(f.dir, `${worker.pane}.agent`);
      const native = JSON.parse(fs.readFileSync(file));
      native.agent_status = "idle"; native.agent_session = { value: session };
      fs.writeFileSync(file, JSON.stringify(native));
      const sessions = path.join(f.env.CODEX_HOME, "sessions", "2026", "09", "12");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, `rollout-2026-09-12-${session}.jsonl`), [
        { type: "session_meta", payload: { id: session } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "late-turn" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: reply }] } },
        { type: "event_msg", payload: { type: "task_complete", turn_id: "late-turn", last_agent_message: reply } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      const recovered = f.ok(["run", "recover", "late-initialization"]);
      assert.equal(f.state().tasks[0].state, "running", recovered);
      assert.equal(f.calls().filter(c => c.action === "prompt").length, 2);
      assert.equal(f.state().workers[0].session, session);
      assert.equal(f.state().workers[0].generation, worker.generation, "observe-only recovery retains its startup generation");
      assert.equal(f.state().workers[0].bootstrap.state, "settled");
      f.ok(["run", "cancel", "late-initialization", "--evidence", "Late initialization recovery tested; cleanup authorized"]);
    } finally { f.clean(); }
  });

  test("relative CODEX_HOME keeps initialization and native transcript lookup in the same directory", () => {
    const f = fixture();
    try {
      fs.mkdirSync(path.join(f.dir, "codex-state"));
      fs.writeFileSync(path.join(f.dir, "lazy-codex"), "complete");
      f.queue("relative-home");
      const result = spawnSync(process.execPath, [cli, "run", "next"], {
        cwd: f.dir, env: { ...f.env, CODEX_HOME: "codex-state", HERDR_CODEX_BOOTSTRAP_TIMEOUT_SECONDS: "5" },
        encoding: "utf8", timeout: 20000,
      });
      assert.ifError(result.error);
      assert.equal(f.state().tasks[0].state, "running", result.stdout + result.stderr);
      assert(fs.existsSync(path.join(f.dir, "codex-state", "sessions")));
      f.ok(["run", "cancel", "relative-home", "--evidence", "Relative configuration regression complete; cleanup authorized"]);
    } finally { f.clean(); }
  });

  test("custom CODEX_HOME supports completion collection after initialization", () => {
    const f = fixture();
    try {
      f.env.CODEX_HOME = path.join(f.dir, "custom-codex");
      fs.writeFileSync(path.join(f.dir, "lazy-codex"), "complete");
      f.queue("custom-home-completion"); f.ok(["run", "next"]);
      const worker = f.state().workers[0];
      const assignment = f.calls().filter(c => c.action === "prompt")[1].args[1];
      const sessions = path.join(f.env.CODEX_HOME, "sessions", "2026", "09", "12");
      const transcript = path.join(sessions, fs.readdirSync(sessions)[0]);
      fs.appendFileSync(transcript, [
        { type: "event_msg", payload: { type: "task_started", turn_id: "assignment-turn" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: assignment }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "CUSTOM_HOME_REPORT: checked the requested file" }] } },
        { type: "event_msg", payload: { type: "task_complete", turn_id: "assignment-turn", last_agent_message: "CUSTOM_HOME_REPORT: checked the requested file" } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      fs.writeFileSync(`${worker.receipt}.proof.${worker.generation}`, worker.generation + "\n");
      const nativeFile = path.join(f.dir, `${worker.pane}.agent`);
      const native = JSON.parse(fs.readFileSync(nativeFile)); native.agent_status = "idle";
      fs.writeFileSync(nativeFile, JSON.stringify(native));
      assert.match(f.ok(["run", "inbox"]), /CUSTOM_HOME_REPORT/);
      f.ok(["run", "accept", worker.pane, "--evidence", "Custom-home native transcript and completion proof verified"]);
      f.ok(["run", "close", worker.pane]); f.ok(["run", "finish"]);
      assert.equal(f.state().tasks[0].state, "accepted");
    } finally { f.clean(); }
  });

  test("Cursor queue, revision and cancellation preserve owned topology and native model policy", () => {
    const f = fixture();
    try {
      f.ok(["run", "queue", "cursor-work", "--role", "verifier", "--kind", "cursor", "--model", "composer-2.5", "--cwd", f.state().project, "--area", ".", "--prompt", "Read only; report checks", "--start"]);
      const w = f.state().workers[0];
      assert.equal(w.kind, "cursor");
      assert.equal(f.state().tasks[0].effort, "model");
      const args = f.calls().find(c => c.group === "agent" && c.action === "start").args;
      assert(args.includes("--auto-review")); assert(args.includes("composer-2.5"));
      for (const flag of ["--force", "--yolo", "--trust", "--mode", "--effort", "--approve-mcps"]) assert(!args.includes(flag), flag);
      f.complete(w);
      f.ok(["run", "revise", w.pane, "--prompt", "Recheck the same file; report only"]);
      const next = f.state().workers[0];
      assert.equal(next.pane, w.pane); assert.notEqual(next.generation, w.generation);
      f.ok(["run", "cancel", next.pane, "--evidence", "Authorized scratch stop; no background jobs"]);
      assert.equal(f.state().tasks[0].state, "cancelled");
      assert.equal(f.calls().filter(c => c.group === "tab" && c.action === "close").length, 1);
      f.ok(["run", "finish"]);
    } finally { f.clean(); }
  });

  test("installed Herdr integrations gate native workers without silently dropping flags", () => {
    const f = fixture();
    try {
      assert.match(f.initialized, /integrations\[5\]:.*opencode/);
      for (const extra of [["--model", "ignored"], ["--effort", "high"]]) {
        const rejected = f.execute(["run", "queue", `native-${extra[0].slice(2)}`, "--kind", "opencode", ...extra, "--cwd", f.state().project, "--area", ".", "--prompt", "Inspect"]);
        assert.equal(rejected.status, 1); assert.match(rejected.output, /native configuration/);
      }
      const missing = f.execute(["run", "queue", "missing", "--kind", "cursor", "--model", "composer-2.5", "--cwd", f.state().project, "--area", ".", "--prompt", "Inspect"], { AXI_TEST_MISSING_INTEGRATION: "cursor" });
      assert.equal(missing.status, 1); assert.match(missing.output, /INTEGRATION_NOT_INSTALLED/);
      assert.equal(f.state().tasks.length, 0);

      const output = f.ok(["run", "queue", "native", "--kind", "opencode", "--cwd", f.state().project, "--area", ".", "--prompt", "Inspect", "--start"]);
      const task = f.state().tasks[0], start = f.calls().find((call) => call.group === "agent" && call.action === "start");
      assert.equal(task.state, "running", output); assert.equal(task.kind, "opencode");
      assert.equal(task.model, undefined); assert.equal(task.effort, undefined);
      assert.deepEqual(start.args.slice(start.args.indexOf("--") + 1), []);
      assert.match(f.ok(["run", "config", "--full"]), /integrations\[5\]:.*opencode/);
    } finally { f.clean(); }
  });

  test("an integration removed after queue defers launch without allocating resources", () => {
    const f = fixture();
    try {
      f.ok(["run", "queue", "native", "--kind", "opencode", "--cwd", f.state().project, "--area", ".", "--prompt", "Inspect"]);
      const output = f.execute(["run", "next"], { AXI_TEST_MISSING_INTEGRATION: "opencode" });
      assert.equal(output.status, 0, output.output); assert.match(output.output, /integration is not installed/);
      assert.equal(f.state().tasks[0].state, "queued");
      assert(!f.calls().some((call) => call.action === "create"));
    } finally { f.clean(); }
  });

  test("one queue-start call selects the requested Opus worker, verifies auto and completes the owned lifecycle", () => {
    const f = fixture();
    try {
      const output = f.ok(["run", "queue", "opus-task", "--role", "implementer", "--kind", "claude", "--model", "claude-opus-5", "--effort", "xhigh", "--cwd", f.state().project, "--area", ".", "--prompt", "Implement a bounded change; report checks; application AWS budget is separate", "--start"]);
      assert.match(output, /mode: auto/); assert.match(output, /,running/);
      assert.deepEqual(f.cliCalls.map((args) => args.slice(0, 2)), [["run", "init"], ["run", "queue"]], "two CLI calls to a running worker; no guide/help/config/fleet preflight");
      assert(Buffer.byteLength(output) < 1500, "startup reply stays bounded without expanding docs");
      const r = f.state(), t = r.tasks[0], w = r.workers[0];
      assert.equal(t.model, "claude-opus-5"); assert.equal(t.access, "write");
      assert.equal(r.config.roles.implementer.kind, "copilot", "per-task choice does not rewrite project/run defaults");
      const calls = f.calls(), start = calls.find((c) => c.action === "start");
      assert(start.args.includes("claude-opus-5")); assert(start.args.includes("xhigh"));
      assert.equal(start.args[start.args.indexOf("--permission-mode") + 1], "auto");
      assert.equal(calls.filter((c) => c.action === "prompt").length, 1);
      assert(calls.findIndex((c) => c.action === "read") < calls.findIndex((c) => c.action === "prompt"));
      const prompt = calls.find((c) => c.action === "prompt").args[1];
      assert.match(prompt, /Application\/model-call budgets are separate/);
      assert(!calls.some((c) => ["layout", "current"].includes(c.action)));
      f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "Fixture completion/checks independently inspected"]);
      f.ok(["run", "close", w.pane]); f.ok(["run", "finish"]);
      assert.equal(f.calls().filter((c) => c.action === "close").length, 1);
    } finally { f.clean(); }
  });

  test("queue rejects manual and incompatible model requests without allocation; runtime downgrade leaves an inspectable cancellable tab", () => {
    const f = fixture();
    try {
      const args = ["run", "queue", "bad", "--role", "implementer", "--cwd", f.state().project, "--area", ".", "--prompt", "Do work", "--start"];
      for (const extra of [["--permission-mode", "manual"], ["--kind", "claude", "--model", "haiku"], ["--kind", "claude"]]) {
        assert.equal(f.execute([...args, ...extra]).status, 1);
        assert.equal(f.state().tasks.length, 0);
      }
      assert(!f.calls().some((c) => c.action === "create"));
      fs.writeFileSync(path.join(f.dir, "context-footer"), "⏸ manual mode on");
      const output = f.ok([...args, "--kind", "claude", "--model", "claude-opus-5"]);
      assert.match(output, /AUTO_MODE_UNSUPPORTED/); assert.match(output, /submitted: false/);
      const w = f.state().workers[0]; assert.equal(w.stage, "created");
      assert(!f.calls().some((c) => ["split", "prompt", "close"].includes(c.action)));
      f.ok(["run", "cancel", "bad", "--evidence", "Mode mismatch; no submitted work; authorized stop"]);
      assert.equal(f.state().tasks[0].state, "cancelled");
    } finally { f.clean(); }
  });

  test("unconfirmed monitor startup offers cancellation and never submits or duplicates the monitor", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "monitor-not-ready"), "");
      f.queue("startup");
      const result = f.ok(["run", "next"]), w = f.state().workers[0];
      assert.match(result, /MONITOR_START_UNVERIFIED/); assert.match(result, /submitted: false/);
      assert.match(result, /herdr-axi run cancel startup/); assert.doesNotMatch(result, /herdr-axi run recover/);
      assert.equal(w.stage, "created"); assert(w.monitor);
      assert.match(f.ok(["run", "status"]), /herdr-axi run cancel startup/);
      for (const args of [["run", "inbox"], ["watch", "--task", "startup", "--timeout-ms", "1000"]])
        assert.match(f.ok(args), /herdr-axi run cancel startup/);
      const recovery = f.execute(["run", "recover", "startup"]);
      assert.equal(recovery.status, 1); assert.match(recovery.output, /MONITOR_START_UNVERIFIED/);
      assert(!f.calls().some((c) => c.action === "prompt"));
      assert.equal(f.calls().filter((c) => c.action === "split").length, 1);
      f.ok(["run", "cancel", "startup", "--evidence", "Unsubmitted monitor startup failed; authorized test cleanup"]);
      assert.equal(f.calls().filter((c) => c.action === "close").length, 1);
      assert(!fs.existsSync(path.join(f.dir, `${w.monitor}.monitor`)));
    } finally { f.clean(); }
  });

  test("startup preview is bounded and never auto-confirms a dialog", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "startup-blocked"), "");
      fs.writeFileSync(path.join(f.dir, "context-footer"), "padding ".repeat(2000) + "Trust this folder?");
      f.queue("preview");
      const result = f.ok(["run", "next"]);
      assert.match(result, /startupOutput:/); assert.match(result, /Trust this folder/);
      assert(Buffer.byteLength(result) < 5000);
      assert(!f.calls().some((c) => ["prompt", "send-keys"].includes(c.action)));
      assert.equal(f.calls().filter((c) => c.action === "read").length, 1);
      const w = f.state().workers[0], retry = f.execute(["run", "recover", w.pane]);
      assert.equal(retry.status, 1); assert.match(retry.output, /STARTUP_NOT_READY/);
      assert(retry.output.includes(`herdr-axi read ${w.pane} --raw --lines 60 --chars 8000`));
      assert(!f.calls().some((c) => ["prompt", "send-keys"].includes(c.action)));
    } finally { f.clean(); }
  });

  test("live blocked wins over starting and wakes watch before the launcher returns", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "startup-blocked"), "");
      f.queue("a"); f.ok(["run", "next"]);
      const r = f.state(), w = r.workers[0];
      r.tasks[0].state = "starting"; r.tasks[0].launcher = process.pid;
      r.workers = []; f.write(r); // Early registry only, launcher still in flight.
      const status = f.ok(["fleet"]);
      assert.match(status, /blocked/); assert.match(status, /not_submitted/);
      assert.doesNotMatch(status, /starting/);
      assert.match(status, new RegExp(`herdr-axi read ${w.pane} --raw`));
      const at = Date.now();
      assert.match(f.ok(["watch", "--timeout-ms", "10000"]), /blocked/);
      assert(Date.now() - at < 5000);
      r.workers = [w]; f.write(r);
      const registryFile = path.join(path.dirname(w.receipt), `${w.name}.json`);
      const registry = JSON.parse(fs.readFileSync(registryFile)); registry.stage = "submitting";
      fs.writeFileSync(registryFile, JSON.stringify(registry));
      assert.doesNotMatch(f.ok(["fleet"]), /not_submitted/, "resumed startup must read current submission stage");
      assert(f.calls().every((c) => !["prompt", "send-keys", "close"].includes(c.action)));
    } finally { f.clean(); }
  });

  test("startup registry without a native agent remains starting until launch completes", async () => {
    const f = fixture(); let launch;
    try {
      f.queue("a"); fs.writeFileSync(path.join(f.dir, "startup-delay"), "");
      launch = f.asyncRun(["run", "next"]);
      const deadline = Date.now() + 10000;
      while (!f.calls().some((c) => c.action === "start") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert(f.calls().some((c) => c.action === "start"));
      const status = f.ok(["run", "status"]);
      assert.match(status, /starting/); assert.doesNotMatch(status, /lost/);
      const started = Date.now(), watched = await f.asyncRun(["watch", "--timeout-ms", "350"]);
      assert.equal(watched.status, 0, watched.output); assert.match(watched.output, /changed: false/);
      assert(Date.now() - started >= 300, "watch must wait, not return a false lost event");
      fs.unlinkSync(path.join(f.dir, "startup-delay"));
      const done = await launch; assert.equal(done.status, 0, done.output);
    } finally { fs.rmSync(path.join(f.dir, "startup-delay"), { force: true }); if (launch) await launch; f.clean(); }
  });
