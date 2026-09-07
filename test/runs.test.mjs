#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

const self = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL("../bin/herdr-axi.mjs", import.meta.url));
const owner = { pane_id: "wTEST:pOWNER", tab_id: "wTEST:tOWNER", workspace_id: "wTEST", terminal_id: "owner-terminal", name: "orchestrator", agent: "codex", agent_status: "working" };

if (["agent", "tab", "pane"].includes(process.argv[2])) {
  const [group, action, ...args] = process.argv.slice(2);
  const dir = process.env.AXI_RUN_TEST;
  fs.appendFileSync(path.join(dir, "calls"), JSON.stringify({ group, action, args, time: Date.now() }) + "\n");
  const emit = (result) => console.log(JSON.stringify({ result }));
  const all = () => fs.readdirSync(dir).filter((n) => n.endsWith(".agent")).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n))));
  const monitors = () => fs.readdirSync(dir).filter((n) => n.endsWith(".monitor")).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n))));
  const save = (a) => {
    const file = path.join(dir, `${a.pane_id}.agent`), temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(a)); fs.renameSync(temp, file);
  };
  const currentOwner = () => fs.existsSync(path.join(dir, "owner-gone")) ? [] : [fs.existsSync(path.join(dir, "owner.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "owner.json"))) : owner];
  const find = (id) => [...currentOwner(), ...all()].find((a) => a.pane_id === id || a.name === id);
  const missing = (kind) => { console.error(JSON.stringify({ error: { code: `${kind}_not_found`, message: "resource absent" } })); process.exit(1); };
  if (group === "agent") {
    if (action === "list") emit({ agents: [...currentOwner(), ...all().filter((a) => a.agent)] });
    else if (action === "get") emit({ agent: find(args[0]) ?? missing("agent") });
    else if (action === "start") {
      const ready = path.join(dir, "startup-delay"), deadline = Date.now() + 10000;
      while (fs.existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      assert(!fs.existsSync(ready), "startup fixture was not released");
      const a = find(args[args.indexOf("--pane") + 1]);
      a.name = args[0]; a.agent = args[args.indexOf("--kind") + 1]; a.agent_status = "idle";
      if (fs.existsSync(path.join(dir, "startup-blocked"))) {
        a.agent_status = "blocked"; save(a);
        console.error(JSON.stringify({ error: { code: "agent_not_ready", message: "startup blocked" } })); process.exit(1);
      }
      save(a); emit({ agent: a });
    } else if (action === "prompt") {
      assert.notEqual(args[0], owner.pane_id, "must never prompt the owner");
      assert.notEqual(args[0], "orchestrator");
      assert(args.includes("--wait"));
      assert.equal(args[args.indexOf("--timeout") + 1], "15000");
      assert(args.includes("working"), "must acknowledge working rather than wait for settlement");
      const a = find(args[0]); a.agent_status = "working"; save(a);
      if (fs.existsSync(path.join(dir, "session-rotate"))) { a.agent_session = { value: randomUUID() }; save(a); }
      if (fs.existsSync(path.join(dir, "prompt-uncertain"))) {
        console.error(JSON.stringify({ error: { code: "timeout", message: "acknowledgement lost" } })); process.exit(1);
      }
      // Keep first startup in flight so concurrent `next` exercises reservations.
      await new Promise((resolve) => setTimeout(resolve, 150));
      emit({ agent: a });
    } else if (action === "read") console.log(fs.existsSync(path.join(dir, `screen-${args[0]}`)) ? fs.readFileSync(path.join(dir, `screen-${args[0]}`), "utf8") : fs.existsSync(path.join(dir, "context-footer")) ? fs.readFileSync(path.join(dir, "context-footer"), "utf8") : find(args[0])?.agent === "claude" ? "Worker result\n⏵⏵ auto mode on (shift+tab to cycle) · for agents" : "Worker result");
    else if (action === "wait") emit({ agent: find(args[0]) ?? missing("agent") });
    else if (action === "send-keys") { const a = find(args[0]); a.agent_status = "idle"; save(a); emit({ sent: true }); }
    else throw Error(`unexpected agent ${action}`);
  } else if (group === "tab") {
    if (action === "create") {
      if (fs.existsSync(path.join(dir, "create-fail"))) { console.error("backend unavailable before tab create"); process.exit(1); }
      const id = randomUUID().slice(0, 8);
      const a = { ...owner, pane_id: `wTEST:p${id}`, tab_id: `wTEST:t${id}`, terminal_id: id, name: "", label: args[args.indexOf("--label") + 1], agent: "", agent_status: "idle", cwd: args[args.indexOf("--cwd") + 1] };
      save(a); emit({ tab: { tab_id: a.tab_id }, root_pane: { pane_id: a.pane_id } });
    } else if (action === "get") {
      const panes = [...currentOwner(), ...all(), ...monitors()].filter((a) => a.tab_id === args[0]);
      const a = panes[0] ?? missing("tab");
      emit({ tab: { tab_id: a.tab_id, workspace_id: a.workspace_id, pane_count: panes.length + (fs.existsSync(path.join(dir, "extra-pane")) ? 1 : 0) } });
    } else if (action === "rename") {
      assert.notEqual(args[0], owner.tab_id);
      if (fs.existsSync(path.join(dir, "rename-delay"))) await new Promise((r) => setTimeout(r, 5000));
      if (fs.existsSync(path.join(dir, "rename-fail"))) { console.error("rename unavailable"); process.exit(1); }
      const a = all().find((a) => a.tab_id === args[0]) ?? missing("tab");
      a.label = args.slice(1).join(" "); save(a); emit({ renamed: true });
    } else if (action === "close") {
      assert.notEqual(args[0], owner.tab_id);
      if (fs.existsSync(path.join(dir, "close-fail"))) { console.error("temporary close failure"); process.exit(1); }
      for (const a of all().filter((a) => a.tab_id === args[0])) fs.unlinkSync(path.join(dir, `${a.pane_id}.agent`));
      for (const a of monitors().filter((a) => a.tab_id === args[0])) fs.unlinkSync(path.join(dir, `${a.pane_id}.monitor`));
      emit({ closed: true });
    } else throw Error(`unexpected tab ${action}`);
  } else if (action === "current") {
    assert(args.includes("--current")); emit({ pane: owner });
  } else if (action === "split") {
    const a = find(args[args.indexOf("--pane") + 1]);
    fs.writeFileSync(path.join(dir, `${a.pane_id}MONITOR.monitor`), JSON.stringify({ pane_id: a.pane_id + "MONITOR", tab_id: a.tab_id, workspace_id: a.workspace_id }));
    emit({ pane: { pane_id: a.pane_id + "MONITOR" } });
  } else if (action === "get") {
    const a = [...currentOwner(), ...all(), ...monitors()].find((a) => a.pane_id === args[0]) ?? missing("pane");
    emit({ pane: { pane_id: args[0], tab_id: a.tab_id } });
  } else if (["run", "wait-output"].includes(action)) emit({ ok: true });
  else throw Error(`unexpected pane ${action}`);
} else {
  function fixture() {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "herdr-axi-run-test-"));
    const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
    for (const [name, target] of [["herdr", self], ["node", process.execPath], ["jq", "/opt/homebrew/bin/jq"], ["rg", "/opt/homebrew/bin/rg"]]) fs.symlinkSync(target, path.join(bin, name));
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HERDR_BIN: self, HERDR_ENV: "1", HERDR_PANE_ID: owner.pane_id, HERDR_TAB_ID: owner.tab_id, HERDR_AXI_RUN: path.join(dir, "run"), HERDR_AXI_STATE_HOME: path.join(dir, "state"), AXI_RUN_TEST: dir };
    const cliCalls = [];
    const execute = (args, extra = {}) => {
      cliCalls.push(args);
      const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20000, env: { ...env, ...extra } });
      assert.ifError(r.error); return { ...r, output: r.stdout + r.stderr };
    };
    const ok = (args) => { const r = execute(args); assert.equal(r.status, 0, r.output); return r.output; };
    const asyncRun = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { env }); let output = "";
      child.stdout.on("data", (b) => { output += b; }); child.stderr.on("data", (b) => { output += b; });
      child.on("error", reject); child.on("close", (status) => resolve({ status, output }));
    });
    const state = () => JSON.parse(fs.readFileSync(path.join(env.HERDR_AXI_RUN, "run.json")));
    const write = (r) => fs.writeFileSync(path.join(env.HERDR_AXI_RUN, "run.json"), JSON.stringify(r));
    const calls = () => fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    const queue = (id, area = id, after) => {
      const cwd = path.join(dir, "work", area.split("/")[0]); fs.mkdirSync(cwd, { recursive: true });
      return ok(["run", "queue", id, "--kind", "codex", "--cwd", cwd, "--area", area.includes("/") ? area.split("/").slice(1).join("/") : ".", "--prompt-file", path.join(dir, "prompt"), ...(after ? ["--after", after] : [])]);
    };
    const complete = (w, state = "done") => {
      const file = path.join(dir, `${w.pane}.agent`);
      const a = JSON.parse(fs.readFileSync(file)); a.agent_status = state; fs.writeFileSync(file, JSON.stringify(a));
      fs.writeFileSync(w.receipt, ["herdr-receipt/3", "1", "settled", "delivered", `generation:${w.generation}`, "settled", `generation:${w.generation}`, `generation:${w.generation}`, "open", w.generation, "delivered"].join("\t") + "\n");
      fs.writeFileSync(`${w.receipt}.inbox`, JSON.stringify({ generation: w.generation, event: "settled", summary: "checks passed" }));
    };
    fs.writeFileSync(path.join(dir, "prompt"), "Write hello. Check its contents. Report file and check.");
    const project = path.join(dir, "project"); fs.mkdirSync(project);
    const initialized = ok(["run", "init", "--dir", env.HERDR_AXI_RUN, "--project", project]);
    return { dir, env, execute, ok, asyncRun, state, write, calls, cliCalls, queue, complete, initialized, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  function exhaustedWorker(f) {
    f.ok(["run", "phase", "explore", "--cap", "1"]);
    f.ok(["run", "queue", "quota-task", "--role", "implementer", "--cwd", f.state().project, "--area", ".", "--prompt", "Finish the partial implementation; check its contents."]);
    f.ok(["run", "next"]);
    const w = f.state().workers[0], file = path.join(f.dir, `${w.pane}.agent`);
    const a = JSON.parse(fs.readFileSync(file)); a.agent_status = "idle"; fs.writeFileSync(file, JSON.stringify(a));
    fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "● Partial implementation; checks pending\n✗ You have exceeded your monthly quota (Request ID: fixture)\n /commands · autopilot");
    return w;
  }

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

  test("queue-start failure reports durable queued task; invalid legacy models consume no slot or lease", () => {
    const f = fixture();
    try {
      const code = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        import {runCommand} from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const rename = fs.renameSync; let commits=0;
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json') && ++commits === 2) throw Error('next publication failed'); return rename(a,b); };
        await assert.rejects(runCommand('queue',{_:['persisted'],role:'implementer',cwd:${JSON.stringify(f.state().project)},area:'.',prompt:'bounded task',start:true}), /already queued; do not queue again/);`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); assert.equal(f.state().tasks[0].state, "queued");
      const r = f.state(); r.tasks[0].kind = "claude"; r.tasks[0].model = "haiku"; f.write(r);
      const output = f.ok(["run", "next"]); assert.match(output, /auto-capable/);
      assert(!f.calls().some((c) => c.action === "create")); assert.equal(f.state().tasks[0].state, "queued");
    } finally { f.clean(); }
  });

  test("queue-start retains actionable deferral and generation drift never suggests a blind cancellation retry", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f);
      const queued = f.ok(["run", "queue", "later", "--role", "implementer", "--cwd", f.state().project, "--area", ".", "--prompt", "Later task", "--start"]);
      assert.match(queued, /queued: later/); assert.match(queued, /primary capacity/);
      assert.equal(f.calls().filter((c) => c.action === "start").length, 1);
      const fields = fs.readFileSync(w.receipt, "utf8").trimEnd().split("\t"); fields[9] = "different-assignment";
      fs.writeFileSync(w.receipt, fields.join("\t") + "\n");
      const failed = f.execute(["run", "cancel", "quota-task", "--evidence", "Authorized stop; observed partial state"]);
      assert.equal(failed.status, 1); assert.match(failed.output, /GENERATION_DRIFT/);
      assert.match(failed.output, /not retriable unchanged/);
      assert.doesNotMatch(failed.output, /herdr-axi run cancel quota-task/);
      const status = f.ok(["run", "status"]);
      assert.match(status, /GENERATION_DRIFT/); assert.doesNotMatch(status, /herdr-axi run cancel quota-task/);
      assert.equal(f.state().tasks[0].state, "cancelling");
      assert(!f.calls().some((c) => c.action === "close"));
    } finally { f.clean(); }
  });

  test("failed startup without registry can be explicitly cancelled without closing inferred resources", async () => {
    const f = fixture(); let orphan;
    try {
      f.queue("never-started"); fs.writeFileSync(path.join(f.dir, "create-fail"), "1");
      f.ok(["run", "next"]);
      assert.equal(f.state().tasks[0].state, "uncertain");
      assert.equal(f.state().workers.length, 0);
      assert.match(f.execute(["run", "recover", "never-started"]).output, /STARTUP_UNRECORDED/);
      assert.match(f.execute(["run", "cancel", "never-started"]).output, /CANCEL_EVIDENCE_REQUIRED/);
      orphan = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(()=>{},1000)", fileURLToPath(new URL("../engine/herdr-worker.sh", import.meta.url)), "--name", f.state().tasks[0].name]);
      await new Promise((resolve, reject) => { orphan.stdout.once("data", resolve); orphan.once("error", reject); });
      assert.match(f.execute(["run", "cancel", "never-started", "--evidence", "Inspect startup"]).output, /RUN_BUSY/);
      assert.equal(f.state().tasks[0].state, "uncertain");
      const stopped = new Promise((resolve) => orphan.once("exit", resolve)); orphan.kill(); await stopped; orphan = null;
      f.ok(["run", "cancel", "never-started", "--evidence", "Failed startup inspected; no background work; cancel authorized"]);
      assert.equal(f.state().tasks[0].state, "cancelled");
      assert.equal(fs.readdirSync(path.join(f.env.HERDR_AXI_STATE_HOME, "writers")).length, 0);
      assert(!f.calls().some((c) => c.action === "close" || c.action === "prompt"));
      f.ok(["run", "finish"]);
    } finally {
      if (orphan) { const stopped = new Promise((resolve) => orphan.once("exit", resolve)); orphan.kill(); await stopped; }
      f.clean();
    }
  });

  test("blocked dialog plus old quota never offers or executes a provider switch", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f), file = path.join(f.dir, `${w.pane}.agent`);
      const a = JSON.parse(fs.readFileSync(file)); a.agent_status = "blocked"; fs.writeFileSync(file, JSON.stringify(a));
      fs.appendFileSync(path.join(f.dir, `screen-${w.pane}`), "\nDo you want to proceed?\n❯ 1. Yes\n  2. No");
      const inbox = f.ok(["run", "inbox"]); assert.doesNotMatch(inbox, /run switch/);
      const result = f.execute(["run", "switch", w.pane, "--kind", "codex", "--model", "gpt-5.6-sol"]);
      assert.match(result.output, /QUOTA_NOT_CONFIRMED/); assert.equal(f.state().tasks[0].state, "running");
      assert(!f.calls().some((c) => c.action === "close"));
    } finally { f.clean(); }
  });

  test("startup quota handoff retires a created tab with no monitor or receipt", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "startup-blocked"), "1");
      f.queue("startup"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; assert.equal(w.stage, "created"); assert.equal(w.monitor, null);
      fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "You've hit your session limit");
      f.ok(["run", "switch", w.pane, "--kind", "copilot", "--model", "gpt-5.6-sol"]);
      assert.equal(f.state().tasks[0].state, "queued"); assert(f.state().workers[0].closed);
      assert.equal(f.calls().filter((c) => c.action === "close").length, 1);
      assert(!f.calls().some((c) => c.group === "pane" && c.action === "get" && !c.args[0]));
    } finally { f.clean(); }
  });

  for (const action of ["keys", "switch", "cancel"]) test(`corrupt unrelated registry does not block healthy worker ${action}`, () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f);
      const run = f.state(); run.tasks.push({ ...run.tasks[0], id: "broken", name: "axi-broken", pane: undefined, state: "uncertain" }); f.write(run);
      fs.writeFileSync(path.join(f.env.HERDR_AXI_RUN, "receipts/wTEST/axi-broken.json"), "partial");
      if (action === "keys") f.ok(["dispatch", w.pane, "--keys", "enter"]);
      else if (action === "switch") f.ok(["run", "switch", w.pane, "--kind", "codex", "--model", "gpt-5.6-sol"]);
      else f.ok(["run", "cancel", w.pane, "--evidence", "Authorized stop; partial work and background jobs inspected"]);
      const create = f.calls().find((c) => c.group === "tab" && c.action === "create");
      assert(create.args.includes(`HERDR_AXI_NODE=${process.execPath}`), "worker environment pins the initiating Node binary");
      assert(f.calls().some((c) => c.group === "pane" && c.action === "run" && c.args[1].includes("HERDR_AXI_NODE=")), "monitor command retains pinned Node across shell startup");
      assert.equal(f.state().tasks[0].state, action === "keys" ? "running" : action === "switch" ? "queued" : "cancelled");
      assert.equal(f.state().tasks[1].state, "uncertain");
      assert.match(f.execute(["run", "cancel", "broken", "--evidence", "inspect"]).output, /JSON|Unexpected|partial/);
    } finally { f.clean(); }
  });

  for (const reused of [false, true]) test(`parked diagnostics do not spin a working run${reused ? " with recycled watch PID" : ""}`, () => {
    const f = fixture();
    try {
      f.queue("parked"); f.queue("active"); f.ok(["run", "next"]);
      const w = f.state().workers.find((w) => w.name === f.state().tasks[0].name);
      f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file)); a.agent_status = "unknown"; fs.writeFileSync(file, JSON.stringify(a));
      if (reused) fs.writeFileSync(path.join(f.env.HERDR_AXI_RUN, "watch.json"), JSON.stringify({ pid: process.pid, started: "Mon Jan 1 00:00:00 2001", action: "watch" }));
      for (let i = 0; i < 2; i++) assert.match(f.ok(["watch", "--timeout-ms", "200"]), /reason: timeout/);
      assert.match(f.ok(["run", "status"]), /parkedAttention/);
      f.ok(["run", "close", w.pane]);
    } finally { f.clean(); }
  });

  test("corrupt unrelated registry permits owner takeover but still fences worker tabs", () => {
    const f = fixture();
    try {
      f.queue("broken");
      const run = f.state(); Object.assign(run.tasks[0], { state: "uncertain", name: "axi-broken" }); f.write(run);
      const registryDir = path.join(f.env.HERDR_AXI_RUN, "receipts/wTEST"); fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(path.join(registryDir, "axi-broken.json"), "partial");
      fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify({ ...owner, agent_status: "idle" }));
      fs.writeFileSync(path.join(f.dir, `screen-${owner.pane_id}`), "You've hit your session limit");
      const env = replacementOwner(f);
      const args = ["run", "takeover", "--from", owner.pane_id, "--evidence", "Authorized transfer; inspect broken worker"];
      const replacementFile = path.join(f.dir, `${env.HERDR_PANE_ID}.agent`), a = JSON.parse(fs.readFileSync(replacementFile));
      fs.writeFileSync(replacementFile, JSON.stringify({ ...a, name: "axi-broken" }));
      assert.match(f.execute(args, env).output, /SELF_TARGET/);
      fs.writeFileSync(replacementFile, JSON.stringify(a));
      const result = f.execute(args, env); assert.equal(result.status, 0, result.output);
      assert.equal(f.state().owner.pane, env.HERDR_PANE_ID);
      assert(!f.calls().some((c) => c.action === "close"));
    } finally { f.clean(); }
  });

  test("valid settled report takes precedence over a stale monitor failure", () => {
    const f = fixture();
    try {
      f.queue("task"); f.ok(["run", "next"]); const w = f.state().workers[0];
      for (const generation of ["-", w.generation]) {
        fs.writeFileSync(w.receipt + ".monitor-error", `${generation}\ttransient monitor failure`);
        f.complete(w);
        const inbox = f.ok(["run", "inbox"]);
        assert.match(inbox, /run accept/); assert.doesNotMatch(inbox, /transient monitor failure/);
      }
      f.ok(["run", "accept", w.pane, "--evidence", "reviewed saved report"]);
    } finally { f.clean(); }
  });

  test("control markers survive PID reuse and concurrent same-process calls without clobbering", () => {
    const f = fixture();
    try {
      const source = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
        import {runCommand} from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const folder=path.join(process.env.HERDR_AXI_RUN,'operations'); fs.mkdirSync(folder,{recursive:true});
        const old=path.join(folder,String(process.pid)); fs.writeFileSync(old,'previous incarnation');
        const first=runCommand('inbox',{_:[]}), second=runCommand('inbox',{_:[]});
        assert.equal(fs.readdirSync(folder).length,3,'both live controls must retain their own marker');
        await Promise.all([first,second]);
        assert.deepEqual(fs.readdirSync(folder),[String(process.pid)]);
        assert.equal(fs.readFileSync(old,'utf8'),'previous incarnation');`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    } finally { f.clean(); }
  });

  test("unlock is idempotent when no transaction lock exists, but refuses a live holder", () => {
    const f = fixture();
    try {
      assert.match(f.ok(["run", "unlock"]), /Already unlocked/);
      assert.match(f.ok(["run", "unlock"]), /unlocked: false/);
      const lock = path.join(f.env.HERDR_AXI_RUN, "run.lock");
      fs.writeFileSync(lock, String(process.pid));
      assert.match(f.execute(["run", "unlock"]).output, /RUN_BUSY/);
      assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
      assert(!fs.existsSync(path.join(f.env.HERDR_AXI_RUN, "run.unlock")));
    } finally { f.clean(); }
  });

  for (const retry of [false, true]) test(`recover retains absent worker evidence through ${retry ? "replacement" : "cancellation"} and finish`, () => {
    const f = fixture();
    try {
      f.queue("lost"); f.ok(["run", "next"]);
      const w = f.state().workers[0];
      fs.writeFileSync(w.receipt + ".inbox", JSON.stringify({ generation: w.generation, event: "lost", summary: "partial evidence to preserve" }));
      fs.unlinkSync(path.join(f.dir, `${w.pane}.agent`));
      fs.unlinkSync(path.join(f.dir, `${w.monitor}.monitor`));
      f.ok(["run", "recover", w.pane]);
      assert.equal(f.state().workers[0].closed, true);
      assert.equal(f.state().tasks[0].state, "queued");
      if (retry) {
        f.ok(["run", "next"]);
        const fresh = f.state().workers.find((v) => !v.closed);
        assert.notEqual(fresh.name, w.name);
        f.complete(fresh); f.ok(["run", "accept", fresh.pane, "--evidence", "Checked replacement result"]);
        f.ok(["run", "close", fresh.pane]);
      } else f.ok(["run", "cancel", "lost"]);
      f.ok(["run", "finish"]);
      const archive = JSON.parse(gunzipSync(fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "detail.json.gz"))));
      assert.match(archive.inboxes[w.name], /partial evidence to preserve/);
      for (const file of [w.receipt, w.receipt + ".inbox", w.receipt.replace(/\.event$/, ".json")]) assert(!fs.existsSync(file), file);
    } finally { f.clean(); }
  });

  for (const reuseParked of [false, true]) test(`handoff survives recovery and later switching${reuseParked ? " onto another parked worker" : " onto a new worker"}`, () => {
    const f = fixture();
    try {
      const old = exhaustedWorker(f);
      f.ok(["run", "switch", old.pane, "--kind", "codex", "--model", "gpt-5.6-sol", "--summary", "FIRST_HANDOFF_PENDING"]);
      fs.writeFileSync(path.join(f.dir, "startup-blocked"), "");
      f.ok(["run", "next"]);
      const file = path.join(f.env.HERDR_AXI_RUN, "task-quota-task.txt");
      assert.match(fs.readFileSync(file, "utf8"), /FIRST_HANDOFF_PENDING/);
      fs.unlinkSync(path.join(f.dir, "startup-blocked"));
      const w = f.state().workers.find((w) => !w.closed);
      f.ok(["dispatch", w.pane, "--keys", "enter"]); f.ok(["run", "recover", w.pane]);
      assert.match(f.calls().filter((c) => c.action === "prompt").at(-1).args[1], /FIRST_HANDOFF_PENDING/);
      const fresh = f.state().workers.find((w) => !w.closed);
      f.complete(fresh);
      f.ok(["run", "revise", fresh.pane, "--prompt", "REVISION_ONLY: check and fix one edge case"]);
      const delivered = f.calls().filter((c) => c.action === "prompt").at(-1).args[1];
      assert.match(delivered, /REVISION_ONLY/); assert.doesNotMatch(delivered, /FIRST_HANDOFF_PENDING|Prior terminal tail/);
      const lost = f.state().workers.find((w) => !w.closed);
      fs.unlinkSync(path.join(f.dir, `${lost.pane}.agent`));
      fs.unlinkSync(path.join(f.dir, `${lost.monitor}.monitor`));
      f.ok(["run", "recover", lost.pane]);
      let parked;
      if (reuseParked) {
        // Another identical-policy task ran in an earlier phase; its worker
        // never received this task's checkpoint. Launch it through the CLI.
        const r = f.state(), original = r.tasks[0];
        r.tasks.push({ ...original, id: "parked-task", prompt: "Independent check", handoffs: [], revisions: [] });
        original.phase = "build"; f.write(r);
        f.ok(["run", "next"]); parked = f.state().workers.find((w) => !w.closed);
        f.complete(parked); f.ok(["run", "accept", parked.pane, "--evidence", "Independent check reviewed"]);
        f.ok(["run", "phase", "build", "--cap", "1"]);
      }
      f.ok(["run", "next"]);
      if (parked) assert.equal(f.state().tasks[0].pane, parked.pane, "must exercise reuse, not a fresh launch");
      if (parked) {
        const hint = fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "receipts", "wTEST", `${parked.name}.task`), "utf8");
        assert.match(hint, /\trunning\t/, "monitor hint must describe active task, not later queued accepted history");
      }
      const restored = f.calls().filter((c) => c.action === "prompt").at(-1).args[1];
      assert.match(restored, /REVISION_ONLY/); assert.match(restored, /FIRST_HANDOFF_PENDING/);
      const current = f.state().workers.find((w) => !w.closed);
      const aFile = path.join(f.dir, `${current.pane}.agent`), a = JSON.parse(fs.readFileSync(aFile));
      a.agent_status = "idle"; fs.writeFileSync(aFile, JSON.stringify(a));
      fs.writeFileSync(path.join(f.dir, `screen-${current.pane}`), "Session limit reached");
      f.ok(["run", "switch", current.pane, "--kind", "claude", "--model", "opus", "--summary", "SECOND_HANDOFF_PENDING"]);
      f.ok(["run", "next"]);
      const second = f.calls().filter((c) => c.action === "prompt").at(-1).args[1];
      assert.match(second, /SECOND_HANDOFF_PENDING/); assert.doesNotMatch(second, /FIRST_HANDOFF_PENDING/);
    } finally { f.clean(); }
  });

  test("queue returns actual cwd-relative scope before any worker is started", () => {
    const f = fixture();
    try {
      const cwd = f.state().project;
      const output = f.ok(["run", "queue", "scope", "--kind", "codex", "--cwd", cwd, "--area", "project", "--prompt", "Check scope"]);
      assert(output.includes(path.join(cwd, "project")));
      assert.equal(f.state().tasks[0].area, path.join(cwd, "project"));
      assert(!f.calls().some((c) => c.action === "start"));
    } finally { f.clean(); }
  });

  test("quota and context share a fair two-probe budget at slow polling cadence", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "context-footer"), "Context 8% left");
      fs.writeFileSync(path.join(f.dir, "screen-wTEST:pQUOTA"), "You have exceeded your monthly quota");
      const source = `import assert from 'node:assert/strict';
        import {contextStatus} from ${JSON.stringify(new URL("../src/context.mjs", import.meta.url).href)};
        const workers=[{pane:'wTEST:pA',kind:'codex',state:'working'},{pane:'wTEST:pB',kind:'codex',state:'working'},{pane:'wTEST:pQUOTA',kind:'copilot',state:'idle'}].map(w=>({...w,generation:'gen'}));
        const run={config:{context:{warnPercent:70,criticalPercent:85}}};
        let now=1000000; Date.now=()=>now;
        let result; for(let i=0;i<4;i++){result=contextStatus(run,workers,workers); now+=30000;}
        assert.equal(result.quotas[0]?.pane,'wTEST:pQUOTA');
        assert.equal(result.warnings.length,2);`;
      const before = f.calls().length;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const reads = f.calls().slice(before).filter((c) => c.action === "read");
      assert(reads.length <= 8); assert(reads.some((c) => c.args[0] === "wTEST:pQUOTA"));
    } finally { f.clean(); }
  });

  test("quota-only screen changes preserve fresh context warnings until context refresh is due", () => {
    const f = fixture();
    try {
      const source = `import assert from 'node:assert/strict'; import fs from 'node:fs';
        import {contextStatus} from ${JSON.stringify(new URL("../src/context.mjs", import.meta.url).href)};
        let now=1000000; Date.now=()=>now;
        const w={pane:'wTEST:pA',kind:'codex',generation:'g',state:'done'};
        fs.writeFileSync(process.env.HERDR_AXI_RUN+'/context.json',JSON.stringify({[w.pane]:{generation:'g',percent:92,at:now-1000,attemptedAt:now-1000,quotaAt:now-1000,quotaState:'idle',source:'native-context'}}));
        const run={config:{context:{warnPercent:70,criticalPercent:85}}};
        let s=contextStatus(run,[w],[w]); assert.equal(s.warnings[0]?.percent,92); assert.equal(s.stale,0);
        now+=16000; s=contextStatus(run,[w],[w]); assert.equal(s.warnings.length,0); assert.equal(s.lastKnown[0]?.percent,92);`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    } finally { f.clean(); }
  });

  test("takeover and archive cleanup reclaim reused-PID controls by start identity, not PID alone", () => {
    const f = fixture();
    try {
      const env = replacementOwner(f);
      fs.writeFileSync(path.join(f.dir, "owner-gone"), "");
      const folder = path.join(f.env.HERDR_AXI_RUN, "operations"); fs.mkdirSync(folder);
      const stale = path.join(folder, `${process.pid}.${randomUUID()}`);
      fs.writeFileSync(stale, JSON.stringify({ pid: process.pid, started: "Mon Jan 1 00:00:00 2001", action: "inbox" }));
      const result = f.execute(["run", "takeover", "--from", owner.pane_id, "--evidence", "Authorized recovery; previous PID incarnation ended"], env);
      assert.equal(result.status, 0, result.output); assert(!fs.existsSync(stale));
      fs.writeFileSync(stale, JSON.stringify({ pid: process.pid, started: "Mon Jan 1 00:00:00 2001", action: "inbox" }));
      const finished = f.execute(["run", "finish"], env);
      assert.equal(finished.status, 0, finished.output); assert(!fs.existsSync(stale));
    } finally { f.clean(); }
  });

  test("unverifiable live control gives exact inspection hints without deleting the marker", () => {
    const f = fixture();
    try {
      const env = replacementOwner(f);
      fs.writeFileSync(path.join(f.dir, "owner-gone"), "");
      const folder = path.join(f.env.HERDR_AXI_RUN, "operations"); fs.mkdirSync(folder);
      const marker = path.join(folder, String(process.pid)); fs.writeFileSync(marker, "legacy control");
      const result = f.execute(["run", "takeover", "--from", owner.pane_id, "--evidence", "Authorized recovery"], env);
      assert.equal(result.status, 1); assert.match(result.output, /RUN_BUSY/);
      assert(result.output.includes(marker)); assert(result.output.includes(`ps -p ${process.pid}`));
      assert.equal(fs.readFileSync(marker, "utf8"), "legacy control");
    } finally { f.clean(); }
  });

  test("resumed quota switch collects a newly arrived proof and offers cancellation, not a retry loop", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f), aFile = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(aFile));
      const session = randomUUID(); a.agent_session = { value: session }; fs.writeFileSync(aFile, JSON.stringify(a));
      fs.writeFileSync(path.join(f.dir, "close-fail"), "");
      assert.match(f.execute(["run", "switch", w.pane, "--kind", "codex", "--model", "gpt-5.6-sol"]).output, /SWITCH_PENDING/);
      const closes = f.calls().filter((c) => c.action === "close").length;
      f.env.HOME = path.join(f.dir, "home");
      const transcript = path.join(f.env.HOME, ".copilot/session-state", session, "events.jsonl");
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, JSON.stringify({ type: "session.task_complete", data: { summary: "SWITCH_LATE_REPORT: checked" } }) + "\n");
      fs.writeFileSync(`${w.receipt}.proof.${w.generation}`, w.generation + "\n");
      fs.unlinkSync(path.join(f.dir, "close-fail"));
      const result = f.execute(["run", "switch", "quota-task"]);
      assert.equal(result.status, 1); assert.match(result.output, /SWITCH_PENDING/); assert.match(result.output, /run switch quota-task --cancel/);
      assert.equal(f.calls().filter((c) => c.action === "close").length, closes);
      f.ok(["run", "switch", "quota-task", "--cancel"]);
      assert.equal(f.state().tasks[0].errorCode, undefined, "abandoned switch clears stale diagnostics");
      const report = f.ok(["watch", "--timeout-ms", "100"]);
      assert.match(report, /SWITCH_LATE_REPORT/); assert.match(report, /review/);
      f.ok(["run", "accept", w.pane, "--evidence", "Late report reviewed"]);
    } finally { f.clean(); }
  });

  for (const [quota, action] of [[false, "watch"], [false, "task-watch"], [true, "watch"], [true, "switch"], [false, "accept"], [true, "accept"], [false, "revise"]]) test(`${action} collects late native proof without losing completed work${quota ? " despite quota banner" : ""}`, () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f), aFile = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(aFile));
      const session = randomUUID(); a.agent_session = { value: session }; fs.writeFileSync(aFile, JSON.stringify(a));
      f.env.HOME = path.join(f.dir, "home");
      const transcript = path.join(f.env.HOME, ".copilot/session-state", session, "events.jsonl");
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, JSON.stringify({ type: "session.task_complete", data: { summary: "LATE_REPORT: checks passed" } }) + "\n");
      fs.writeFileSync(`${w.receipt}.proof.${w.generation}`, w.generation + "\n");
      if (!quota) fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "Task finished");
      if (action === "accept") {
        const output = f.ok(["run", "accept", w.pane, "--evidence", "Independently reviewed current result/checks"]);
        assert.match(output, /accepted: quota-task/);
        assert.match(f.state().tasks[0].result, /LATE_REPORT/);
        assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
        return;
      }
      if (action === "revise") {
        f.ok(["run", "revise", w.pane, "--prompt", "Small correction; recheck"]);
        assert.equal(f.state().tasks[0].pane, w.pane);
        assert.notEqual(f.state().workers[0].generation, w.generation);
        assert.match(f.state().tasks[0].revisions[0].summary, /LATE_REPORT/);
        assert.equal(f.calls().filter((c) => c.action === "prompt").length, 2);
        return;
      }
      if (action === "switch") {
        const r = f.execute(["run", "switch", w.pane, "--kind", "codex", "--model", "gpt-5.6-sol"]);
        assert.equal(r.status, 1); assert.match(r.output, /NOT_SWITCHABLE/);
        assert(!f.calls().some((c) => c.action === "close"));
        assert.equal(f.state().tasks[0].state, "running");
      }
      const out = f.ok(["watch", ...(action === "task-watch" ? ["--task", "quota-task"] : []), "--timeout-ms", "100"]);
      assert.match(out, /LATE_REPORT/); assert.match(out, /review/); assert.match(out, /run accept/);
      assert.doesNotMatch(out, /herdr-axi run inbox|herdr-axi run switch/);
      f.ok(["run", "accept", w.pane, "--evidence", "Verified actual result and checks"]);
    } finally { f.clean(); }
  });

  test("explicit cancellation closes working worker AND monitor; saves partial work without acceptance", () => {
    const f = fixture();
    try {
      f.queue("stop"); f.ok(["run", "next"]);
      const w = f.state().workers[0], task = f.state().tasks[0];
      // Launch already published running; a long-lived caller/reused old PID
      // is not an active launch and must not strand cancellation.
      const running = f.state(); running.tasks[0].launcher = process.pid; f.write(running);
      const partial = path.join(task.cwd, "partial.txt"); fs.writeFileSync(partial, "unfinished");
      const args = ["run", "cancel", w.pane, "--evidence", "User authorized stop; partial files retained, no detached jobs."];
      assert.match(f.execute(["run", "cancel", w.pane]).output, /CANCEL_EVIDENCE_REQUIRED/);
      assert.match(f.execute(["run", "close", w.pane]).output, /herdr-axi run cancel/);
      assert.match(f.execute(["run", "recover", w.pane]).output, /herdr-axi run cancel/);
      assert.equal(f.calls().filter((c) => c.action === "close").length, 0);
      fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "partial terminal history ".repeat(2000));
      const output = f.ok(args); assert.match(output, /cancelled: stop/);
      assert(!fs.existsSync(path.join(f.dir, `${w.pane}.agent`)));
      assert(!fs.existsSync(path.join(f.dir, `${w.monitor}.monitor`)));
      assert.equal(f.state().workers[0].closed, true);
      assert.equal(f.state().tasks[0].state, "cancelled");
      assert.equal(f.state().tasks[0].cancellation.output.length, 32000);
      assert.equal(fs.readFileSync(partial, "utf8"), "unfinished");
      assert.deepEqual(fs.readdirSync(path.join(f.env.HERDR_AXI_STATE_HOME, "writers")), []);
      assert.notEqual(fs.readFileSync(w.receipt, "utf8").split("\t")[7], `generation:${w.generation}`);
      f.ok(["run", "cancel", "stop"]);
      assert.equal(f.calls().filter((c) => c.action === "close").length, 1);
      const split = f.calls().find((c) => c.action === "split");
      assert.equal(split.args[split.args.indexOf("--cwd") + 1], path.dirname(w.receipt));
      f.ok(["run", "finish"]);
      const archive = JSON.parse(gunzipSync(fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "detail.json.gz"))));
      assert.equal(archive.tasks[0].cancellation.output.length, 32000);
      assert.match(f.ok(["run", "history", "--task", "stop"]), /User authorized stop/);
    } finally { f.clean(); }
  });

  test("cancellation repairs a monitor-only orphan after its worktree was externally deleted", () => {
    const f = fixture();
    try {
      f.queue("orphan"); f.ok(["run", "next"]);
      const w = f.state().workers[0];
      fs.unlinkSync(path.join(f.dir, `${w.pane}.agent`));
      fs.rmdirSync(f.state().tasks[0].cwd);
      assert.match(f.execute(["run", "recover", w.pane]).output, /RESOURCES_REMAIN/);
      assert.match(f.ok(["run", "cancel", w.pane, "--evidence", "Authorized cleanup; prior agent and empty worktree already removed."]), /capture: unavailable/);
      assert.equal(f.state().tasks[0].state, "cancelled");
      assert(!fs.existsSync(path.join(f.dir, `${w.monitor}.monitor`)));
      assert.match(f.state().tasks[0].cancellation.gitStatus, /unavailable/);
      assert.equal(f.calls().filter((c) => c.group === "tab" && c.action === "close").length, 1);
    } finally { f.clean(); }
  });

  test("failed cancellation reserves slot and lease; retry closes once without another prompt", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f);
      const leases = path.join(f.env.HERDR_AXI_STATE_HOME, "writers"), lease = path.join(leases, fs.readdirSync(leases)[0]);
      const savedLease = fs.readFileSync(lease, "utf8");
      fs.writeFileSync(path.join(f.dir, "close-fail"), "");
      assert.match(f.execute(["run", "cancel", w.pane, "--evidence", "Authorized cancellation"]).output, /CANCEL_PENDING/);
      const checkpoint = f.state().tasks[0].cancellation;
      assert.equal(f.state().tasks[0].state, "cancelling");
      assert.equal(fs.readFileSync(lease, "utf8"), savedLease);
      assert.match(f.ok(["run", "status"]), /herdr-axi run cancel quota-task/);
      assert.match(f.execute(["run", "finish"]).output, /RUN_ACTIVE/);
      fs.unlinkSync(path.join(f.dir, "close-fail"));
      f.ok(["run", "cancel", "quota-task"]);
      assert.deepEqual(f.state().tasks[0].cancellation, checkpoint);
      assert(!fs.existsSync(lease));
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
    } finally { f.clean(); }
  });

  test("cancellation refuses changed identities, extra panes, owner tab and live controls", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f), args = ["run", "cancel", w.pane, "--evidence", "Authorized stop"];
      const state = f.state(), file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      state.tasks[0].state = "starting"; state.tasks[0].launcher = process.pid; f.write(state);
      assert.match(f.execute(args).output, /RUN_BUSY/);
      state.tasks[0].state = "running"; delete state.tasks[0].launcher; f.write(state);
      a.terminal_id = "replacement"; fs.writeFileSync(file, JSON.stringify(a));
      assert.match(f.execute(args).output, /WORKER_CHANGED/);
      a.terminal_id = w.terminal; fs.writeFileSync(file, JSON.stringify(a));
      state.workers[0].tab = owner.tab_id; f.write(state);
      assert.match(f.execute(args).output, /SELF_TARGET/);
      state.workers[0].tab = w.tab; f.write(state);
      fs.writeFileSync(path.join(f.dir, "extra-pane"), "");
      assert.match(f.execute(args).output, /CANCEL_PENDING/);
      assert.equal(f.calls().filter((c) => c.action === "close").length, 0);
      fs.unlinkSync(path.join(f.dir, "extra-pane"));
      f.ok(["run", "cancel", "quota-task"]);
    } finally { f.clean(); }
  });

  for (const legacy of [false, true]) test(`cancellation can retire blocked startup before a monitor exists${legacy ? " with legacy missing receipt" : " with its armed receipt"}`, () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "startup-blocked"), "");
      f.queue("startup"); f.ok(["run", "next"]);
      const w = f.state().workers[0];
      assert.equal(w.monitor, null);
      assert.equal(fs.readFileSync(w.receipt, "utf8").trimEnd().split("\t")[9], w.generation);
      if (legacy) fs.unlinkSync(w.receipt); // Pre-fix worker never armed before native startup.
      f.ok(["run", "cancel", "startup", "--evidence", "User cancelled unapproved startup; no task submitted."]);
      assert.equal(f.state().workers[0].closed, true);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 0);
    } finally { f.clean(); }
  });

  test("cancellation publishes checkpoint before closure and resumes after failed final publication", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f);
      const source = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        import {runCommand} from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        import {loadRun} from ${JSON.stringify(new URL("../src/run-state.mjs", import.meta.url).href)};
        const rename = fs.renameSync;
        const args = {_:['quota-task'], evidence:'User authorized stop; partial state retained'};
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json')) throw Error('checkpoint failed'); return rename(a,b); };
        await assert.rejects(runCommand('cancel',args), /checkpoint failed/);
        assert.equal(loadRun().tasks[0].state, 'running');
        assert(fs.existsSync(${JSON.stringify(path.join(f.dir, `${w.pane}.agent`))}));
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json') && JSON.parse(fs.readFileSync(a)).tasks[0].state === 'cancelled') throw Error('publication failed'); return rename(a,b); };
        await assert.rejects(runCommand('cancel',args), {code:'CANCEL_PENDING'});
        assert.equal(loadRun().tasks[0].state, 'cancelling');
        assert(!fs.existsSync(${JSON.stringify(path.join(f.dir, `${w.monitor}.monitor`))}));
        fs.renameSync = rename;
        await runCommand('cancel',{_:['quota-task']});
        assert.equal(loadRun().tasks[0].state, 'cancelled');`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8", timeout: 20000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.calls().filter((c) => c.action === "close").length, 1);
      assert.deepEqual(fs.readdirSync(path.join(f.env.HERDR_AXI_STATE_HOME, "writers")), []);
    } finally { f.clean(); }
  });

  test("quota wakes fleet/inbox/watch and switches the same unfinished task without losing files or its lease", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f), original = f.state().tasks[0];
      const partial = path.join(original.cwd, "partial.txt"); fs.writeFileSync(partial, "unfinished, untracked");
      const leases = path.join(f.env.HERDR_AXI_STATE_HOME, "writers"), lease = path.join(leases, fs.readdirSync(leases)[0]), beforeLease = fs.readFileSync(lease);
      for (const command of [["fleet"], ["run", "inbox"], ["watch", "--timeout-ms", "100"], ["read", w.pane]]) {
        const output = f.ok(command); assert.match(output, /quota|QUOTA_EXHAUSTED/);
        assert(output.includes(`herdr-axi run switch ${w.pane} --kind codex --model gpt-5.6-sol`));
      }
      const refused = f.execute(["run", "accept", w.pane, "--evidence", "partial only"]);
      assert.equal(refused.status, 1); assert.match(refused.output, /QUOTA_EXHAUSTED/);
      fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "large terminal history ".repeat(8000) + "\n✗ You have exceeded your monthly quota (Request ID: fixture)");
      const result = f.ok(["run", "switch", w.pane, "--kind", "codex", "--model", "gpt-5.6-sol", "--summary", "Implementation partial; build not verified."]);
      assert.match(result, /state: queued/); assert.match(result, /herdr-axi run next/);
      const moved = f.state().tasks[0];
      for (const key of ["id", "prompt", "cwd", "worktree", "area", "deps", "phase", "access"]) assert.deepEqual(moved[key], original[key]);
      assert.equal(moved.kind, "codex"); assert.equal(f.state().workers[0].closed, true);
      assert.equal(moved.handoffs[0].state, "retired");
      assert.match(moved.handoffs[0].output, /monthly quota/);
      assert(moved.handoffs[0].output.length <= 32000);
      assert.equal(moved.handoffs[0].capture.truncated, true);
      assert.deepEqual(fs.readFileSync(lease), beforeLease);
      assert.equal(fs.readFileSync(partial, "utf8"), "unfinished, untracked");
      assert.notEqual(fs.readFileSync(w.receipt, "utf8").split("\t")[7], `generation:${w.generation}`, "handoff is not completion");
      assert.equal(f.calls().filter((c) => c.action === "start").length, 1, "switch does not overspawn");
      f.ok(["run", "next"]);
      const replacement = f.state().workers.find((p) => !p.closed);
      assert.equal(replacement.kind, "codex"); assert.notEqual(replacement.pane, w.pane);
      const prompt = fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "task-quota-task.txt"), "utf8");
      assert.match(prompt, /Provider handoff, unfinished task/); assert.match(prompt, /Implementation partial; build not verified/);
      assert.match(prompt, /Finish the partial implementation/);
      f.complete(replacement); f.ok(["run", "accept", replacement.pane, "--evidence", "replacement checked"]);
      f.ok(["run", "close", replacement.pane]); f.ok(["run", "finish"]);
      assert.match(f.ok(["run", "history", "--task", original.id]), /handoffs/);
      const archive = JSON.parse(gunzipSync(fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "detail.json.gz"))));
      assert.match(archive.tasks[0].handoffs[0].output, /monthly quota/);
      assert.equal(fs.readFileSync(partial, "utf8"), "unfinished, untracked");
    } finally { f.clean(); }
  });

  test("failed quota switch retains checkpoint and lease; explicit retry never duplicates a worker", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f);
      fs.writeFileSync(path.join(f.dir, "close-fail"), "");
      const result = f.execute(["run", "switch", w.pane, "--kind", "claude", "--model", "opus"]);
      assert.equal(result.status, 1); assert.match(result.output, /SWITCH_PENDING/);
      assert.equal(f.state().tasks[0].state, "switching");
      assert.match(f.ok(["run", "inbox"]), /herdr-axi run switch quota-task/);
      f.ok(["run", "next"]); assert.equal(f.calls().filter((c) => c.action === "start").length, 1);
      assert.equal(f.execute(["run", "switch", "quota-task", "--kind", "codex", "--model", "different"]).status, 1);
      fs.unlinkSync(path.join(f.dir, "close-fail"));
      f.ok(["run", "switch", "quota-task"]);
      assert.equal(f.state().tasks[0].kind, "claude");
      assert.equal(f.state().tasks[0].handoffs.length, 1);
      assert.equal(fs.readdirSync(path.join(f.env.HERDR_AXI_STATE_HOME, "writers")).length, 1);
      f.ok(["run", "next"]); assert.equal(f.calls().filter((c) => c.action === "start").length, 2);
    } finally { f.clean(); }
  });

  test("switch refuses foreign owner, active worker, access escalation and non-quota errors", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f), before = f.state();
      const args = ["run", "switch", w.pane, "--kind", "codex", "--model", "gpt-5.6-sol"];
      assert.equal(f.execute(args, { HERDR_PANE_ID: "wOTHER:pX" }).status, 1);
      assert.equal(f.execute(["run", "switch", w.pane, "--role", "verifier"]).status, 1);
      assert.equal(f.execute(["run", "switch", w.pane, "--kind", "copilot", "--model", "gpt-5.6-sol"]).status, 1);
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      a.agent_status = "working"; fs.writeFileSync(file, JSON.stringify(a)); assert.equal(f.execute(args).status, 1);
      a.agent_status = "idle"; fs.writeFileSync(file, JSON.stringify(a));
      fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "Rate limit exceeded; retry in 2 seconds");
      assert.match(f.execute(args).output, /QUOTA_NOT_CONFIRMED/);
      assert.deepEqual(f.state(), before);
      assert(!f.calls().some((c) => c.action === "close"));
    } finally { f.clean(); }
  });

  test("quota switch publication failures preserve checkpoints, never duplicate close, and allow safe cancellation", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f);
      const source = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        import { runCommand } from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        import { loadRun } from ${JSON.stringify(new URL("../src/run-state.mjs", import.meta.url).href)};
        const rename = fs.renameSync;
        const args = {_: [${JSON.stringify(w.pane)}], kind:'codex', model:'gpt-5.6-sol'};
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json')) throw Error('checkpoint failed'); return rename(a,b); };
        await assert.rejects(runCommand('switch',args), /checkpoint failed/);
        assert.equal(loadRun().tasks[0].state,'running');
        assert(fs.existsSync(${JSON.stringify(path.join(f.dir, `${w.pane}.agent`))}));
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json') && JSON.parse(fs.readFileSync(a)).tasks[0].state === 'queued') throw Error('publication failed'); return rename(a,b); };
        await assert.rejects(runCommand('switch',args), {code:'SWITCH_PENDING'});
        assert.equal(loadRun().tasks[0].state,'switching');
        assert(!fs.existsSync(${JSON.stringify(path.join(f.dir, `${w.pane}.agent`))}));
        assert.match(loadRun().tasks[0].handoffs[0].output,/monthly quota/);
        fs.renameSync = rename;
        await runCommand('switch',{_:['quota-task']});
        assert.equal(loadRun().tasks[0].state,'queued');`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8", timeout: 20000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.calls().filter((c) => c.action === "close").length, 1);
      f.ok(["run", "next"]);
      const next = f.state().workers.find((w) => !w.closed), file = path.join(f.dir, `${next.pane}.agent`);
      const a = JSON.parse(fs.readFileSync(file)); a.agent_status = "idle"; fs.writeFileSync(file, JSON.stringify(a));
      fs.writeFileSync(path.join(f.dir, `screen-${next.pane}`), "Session limit reached");
      fs.writeFileSync(path.join(f.dir, "close-fail"), "");
      assert.equal(f.execute(["run", "switch", next.pane, "--kind", "claude", "--model", "opus"]).status, 1);
      fs.writeFileSync(path.join(f.dir, `screen-${next.pane}`), "● Resumed after limit reset");
      assert.match(f.execute(["run", "switch", "quota-task"]).output, /--cancel/);
      f.ok(["run", "switch", "quota-task", "--cancel"]);
      assert.equal(f.state().tasks[0].state, "running");
      assert.equal(f.state().tasks[0].handoffs.at(-1).state, "cancelled");
      assert(fs.existsSync(file));
    } finally { f.clean(); }
  });

  test("one watch wakes for a newly reached quota; subsequent status reuses the bounded probe", async () => {
    const f = fixture(); let watching;
    try {
      const w = exhaustedWorker(f), file = path.join(f.dir, `${w.pane}.agent`);
      const a = JSON.parse(fs.readFileSync(file)); a.agent_status = "working"; fs.writeFileSync(file, JSON.stringify(a));
      const before = f.calls().filter((c) => c.action === "list").length;
      watching = f.asyncRun(["watch", "--timeout-ms", "8000"]);
      const deadline = Date.now() + 3000;
      while (f.calls().filter((c) => c.action === "list").length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      a.agent_status = "idle"; fs.writeFileSync(file, JSON.stringify(a));
      const result = await watching;
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /reason: state-change/);
      assert.match(result.output, /monthly/); assert.match(result.output, /herdr-axi run switch/);
      const reads = f.calls().filter((c) => c.action === "read").length;
      f.ok(["fleet"]);
      assert.equal(f.calls().filter((c) => c.action === "read").length, reads);
    } finally { if (watching) await watching; f.clean(); }
  });

  test("quiet watch backs off backend probes yet persisted reports wake it without another orchestrator call", async () => {
    const f = fixture(); let watching;
    try {
      f.queue("task"); f.ok(["run", "next"]);
      const w = f.state().workers[0];
      const before = f.calls().filter((c) => c.action === "list").length;
      watching = f.asyncRun(["watch", "--timeout-ms", "16000"]);
      await new Promise((r) => setTimeout(r, 8500));
      const probes = f.calls().filter((c) => c.action === "list").length - before;
      assert(probes >= 2 && probes <= 3, `quiet run: initial + 2s + 4s reconciliation, got ${probes}`);
      const started = Date.now(); f.complete(w);
      const result = await watching;
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /checks passed/); assert.match(result.output, /run accept/);
      assert(Date.now() - started < 3000, "receipt wake must not wait for the next 8s reconciliation");
      assert(!fs.existsSync(path.join(f.env.HERDR_AXI_RUN, "watch.json")));
    } finally { if (watching) await watching; f.clean(); }
  });

  test("run watch alias includes review results and refuses a second live watcher", async () => {
    const f = fixture(); let watching;
    try {
      f.queue("task"); f.ok(["run", "next"]);
      const w = f.state().workers[0];
      watching = f.asyncRun(["run", "watch", "--timeout-ms", "6000"]);
      const marker = path.join(f.env.HERDR_AXI_RUN, "watch.json"), deadline = Date.now() + 2000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      const registered = JSON.parse(fs.readFileSync(marker));
      assert.equal(registered.action, "watch"); assert(Number.isFinite(Date.parse(registered.started)));
      const duplicate = f.execute(["watch", "--timeout-ms", "100"]);
      assert.equal(duplicate.status, 1); assert.match(duplicate.output, /WATCH_ACTIVE/);
      f.complete(w);
      const result = await watching;
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /checks passed/); assert.match(result.output, /run accept/);
      assert.doesNotMatch(result.output, /help\[1\]: herdr-axi run inbox/);
      assert(!fs.existsSync(marker));
      assert.match(f.ok(["run", "watch", "--help"]), /Alias of herdr-axi watch/);
    } finally { if (watching) await watching; f.clean(); }
  });

  for (const kind of ["codex", "claude"]) test(`${kind} quota switches safely even when native state is unknown; disposable monitor hints removed`, () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f), r = f.state();
      r.tasks[0].kind = kind; r.workers[0].kind = kind; f.write(r);
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      a.agent = kind; a.agent_status = "unknown"; fs.writeFileSync(file, JSON.stringify(a));
      fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), kind === "claude" ? "You've hit your limit · resets later" : "■ You've hit your usage limit. Try again later");
      fs.writeFileSync(w.receipt + ".monitor-error", "old hint");
      const alternate = kind === "codex" ? "claude" : "codex";
      f.ok(["run", "switch", w.pane, "--kind", alternate, "--model", alternate === "claude" ? "opus" : "gpt-5.6-sol"]);
      assert.equal(f.state().tasks[0].state, "queued");
      assert(!fs.existsSync(w.receipt + ".monitor-error"));
      assert(!fs.existsSync(w.receipt.replace(/\.event$/, ".task")));
      assert(fs.existsSync(w.receipt), "retain tombstone for audit and safe retries");
      assert(!fs.existsSync(w.receipt.replace(/\.event$/, ".json")), "engine removes the retired runtime registry");
      assert.equal(f.state().tasks[0].handoffs[0].from.generation, w.generation, "registry identity retained in checkpoint");
    } finally { f.clean(); }
  });

  function replacementOwner(f) {
    const a = { ...owner, pane_id: "wTEST:pNEW", tab_id: "wTEST:tNEW", terminal_id: "new-terminal", name: "replacement", agent: "claude" };
    fs.writeFileSync(path.join(f.dir, `${a.pane_id}.agent`), JSON.stringify(a));
    return { HERDR_PANE_ID: a.pane_id, HERDR_TAB_ID: a.tab_id };
  }

  for (const transition of ["takeover", "finish"]) test(`active watch reports ${transition} distinctly and removes its watch record`, async () => {
    const f = fixture(); let watching;
    try {
      f.queue("task"); f.ok(["run", "next"]);
      const lists = f.calls().filter((c) => c.action === "list").length;
      watching = f.asyncRun(["watch", "--timeout-ms", "6000"]);
      const deadline = Date.now() + 2000;
      while (f.calls().filter((c) => c.action === "list").length === lists && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      if (transition === "takeover") {
        const env = replacementOwner(f);
        fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify({ ...owner, agent_status: "idle" }));
        fs.writeFileSync(path.join(f.dir, `screen-${owner.pane_id}`), "You've hit your limit");
        const result = f.execute(["run", "takeover", "--from", owner.pane_id, "--evidence", "Authorized replacement"], env);
        assert.equal(result.status, 0, result.output);
      } else {
        const r = f.state(); r.finishedAt = new Date().toISOString();
        r.tasks.forEach((t) => { t.state = "accepted"; }); r.workers.forEach((w) => { w.closed = true; }); f.write(r);
      }
      const result = await watching; assert.equal(result.status, 0, result.output);
      assert.match(result.output, transition === "takeover" ? /reason: owner-changed/ : /reason: state-change/);
      if (transition === "finish") assert.match(result.output, /finished:/);
      assert(!fs.existsSync(path.join(f.env.HERDR_AXI_RUN, "watch.json")));
    } finally { if (watching) await watching; f.clean(); }
  });

  test("quota owner takeover preserves tasks and leases, fences the previous owner and never closes either owner", () => {
    const f = fixture();
    try {
      const worker = exhaustedWorker(f), env = replacementOwner(f), before = f.state();
      fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify({ ...owner, agent_status: "unknown" }));
      fs.writeFileSync(path.join(f.dir, `screen-${owner.pane_id}`), "You've hit your usage limit");
      const args = ["run", "takeover", "--from", owner.pane_id, "--evidence", "User authorized transfer; finish review, preserve dirty files."];
      const result = f.execute(args, env); assert.equal(result.status, 0, result.output);
      const after = f.state();
      assert.equal(after.owner.pane, env.HERDR_PANE_ID);
      for (const key of ["id", "tasks", "workers", "phase", "limits", "config"]) assert.deepEqual(after[key], before[key]);
      assert.match(after.ownerHandoffs[0].output, /usage limit/);
      assert.equal(fs.readdirSync(path.join(f.env.HERDR_AXI_STATE_HOME, "writers")).length, 1);
      assert.match(f.execute(["run", "next"]).output, /NOT_RUN_OWNER/);
      assert.match(f.execute(["dispatch", worker.pane, "--keys", "enter"]).output, /NOT_RUN_OWNER/);
      assert.equal(f.execute(["run", "inbox"], env).status, 0);
      assert(!f.calls().some((c) => c.action === "close" || c.action === "send-keys"));
      assert.match(f.ok(["run", "history"]), /ownerHandoffs/);
      assert.equal(f.execute(args, env).status, 1, "repeated old --from cannot transfer twice");
    } finally { f.clean(); }
  });

  test("takeover refuses active controls, wrong owners, working/changed occupants and worker promotion", () => {
    const f = fixture();
    try {
      const env = replacementOwner(f), before = f.state();
      const args = ["run", "takeover", "--from", owner.pane_id, "--evidence", "Explicitly authorized recovery"];
      assert.match(f.execute(args, env).output, /OWNER_BUSY/);
      fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify({ ...owner, agent_status: "idle" }));
      assert.match(f.execute(args, env).output, /QUOTA_NOT_CONFIRMED/);
      fs.writeFileSync(path.join(f.dir, `screen-${owner.pane_id}`), "You've hit your limit");
      const ops = path.join(f.env.HERDR_AXI_RUN, "operations"); fs.mkdirSync(ops);
      const active = path.join(ops, `${process.pid}.${randomUUID()}`);
      fs.writeFileSync(active, "next");
      assert.match(f.execute(args, env).output, /RUN_BUSY/);
      fs.unlinkSync(active);
      fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify({ ...owner, terminal_id: "different", agent_status: "idle" }));
      assert.match(f.execute(args, env).output, /OWNER_CHANGED/);
      assert.match(f.execute(args, { ...env, HERDR_AXI_WORKER: "1" }).output, /NESTED_RUN/);
      assert.deepEqual(f.state(), before);
    } finally { f.clean(); }
  });

  test("takeover requires verified old-pane absence and keeps the same run", () => {
    const f = fixture();
    try {
      const env = replacementOwner(f);
      fs.writeFileSync(path.join(f.dir, "owner-gone"), "");
      const result = f.execute(["run", "takeover", "--from", owner.pane_id, "--evidence", "User authorized replacement of closed owner"], env);
      assert.equal(result.status, 0, result.output); assert.equal(f.state().ownerHandoffs[0].absent, true);
      assert(!f.calls().some((c) => ["close", "prompt", "start"].includes(c.action)));
    } finally { f.clean(); }
  });

  test("validated takeover reclaims only dead transaction/operation locks and never a live holder", () => {
    const f = fixture();
    try {
      const env = replacementOwner(f), args = ["run", "takeover", "--from", owner.pane_id, "--evidence", "Authorized recovery after process exit"];
      fs.writeFileSync(path.join(f.dir, "owner-gone"), "");
      const lock = path.join(f.env.HERDR_AXI_RUN, "run.lock");
      fs.writeFileSync(lock, String(process.pid));
      assert.match(f.execute(args, env).output, /RUN_BUSY/);
      assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
      const stopped = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
      assert.equal(stopped.status, 0); assert.throws(() => process.kill(stopped.pid, 0), { code: "ESRCH" });
      fs.writeFileSync(lock, String(stopped.pid));
      const ops = path.join(f.env.HERDR_AXI_RUN, "operations"); fs.mkdirSync(ops);
      fs.writeFileSync(path.join(ops, String(stopped.pid)), "next");
      fs.writeFileSync(path.join(ops, `${stopped.pid}.${randomUUID()}`), "inbox");
      const result = f.execute(args, env); assert.equal(result.status, 0, result.output);
      assert(!fs.existsSync(lock)); assert.deepEqual(fs.readdirSync(ops), []);
    } finally { f.clean(); }
  });

  test("failed takeover publication leaves the original owner in control and no destructive calls", () => {
    const f = fixture();
    try {
      const env = replacementOwner(f), before = f.state();
      fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify({ ...owner, agent_status: "idle" }));
      fs.writeFileSync(path.join(f.dir, `screen-${owner.pane_id}`), "Session limit reached");
      const source = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        import {runCommand} from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const rename = fs.renameSync;
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json')) throw Error('publication failed'); return rename(a,b); };
        await assert.rejects(runCommand('takeover',{_:[],from:${JSON.stringify(owner.pane_id)},evidence:'Authorized transfer'}), /publication failed/);`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: { ...f.env, ...env }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(f.state(), before);
      f.queue("still-owned");
      assert(!f.calls().some((c) => ["close", "prompt", "start"].includes(c.action)));
    } finally { f.clean(); }
  });

  test("durable quota inbox preserves history without suggesting a stale quota switch", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f);
      fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "ordinary idle output");
      fs.writeFileSync(w.receipt + ".inbox", JSON.stringify({ generation: w.generation, event: "error", quota: { code: "QUOTA_EXHAUSTED", scope: "monthly" }, summary: "Monthly quota was reached" }));
      const inbox = f.ok(["run", "inbox"]);
      assert.match(inbox, /reportedQuota/); assert.doesNotMatch(inbox, /herdr-axi run switch/);
      assert.match(f.execute(["run", "switch", w.pane, "--kind", "codex", "--model", "gpt-5.6-sol"]).output, /QUOTA_NOT_CONFIRMED/);
      assert(!f.calls().some((c) => c.action === "close"));
    } finally { f.clean(); }
  });

  test("failed next after handoff retains its pre-existing lease while rolling back new reservations", () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f);
      f.ok(["run", "switch", w.pane, "--kind", "codex", "--model", "gpt-5.6-sol"]);
      f.ok(["run", "phase", "explore", "--cap", "2"]); f.queue("second");
      const leases = path.join(f.env.HERDR_AXI_STATE_HOME, "writers"), name = fs.readdirSync(leases)[0];
      const previous = fs.readFileSync(path.join(leases, name), "utf8");
      const source = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        import {runCommand} from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const rename = fs.renameSync;
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json')) throw Error('publication failed'); return rename(a,b); };
        await assert.rejects(runCommand('next',{_:[]}), /publication failed/);`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readdirSync(leases), [name]);
      assert.equal(fs.readFileSync(path.join(leases, name), "utf8"), previous);
      assert(f.state().tasks.every((t) => t.state === "queued"));
      assert.equal(f.calls().filter((c) => c.action === "start").length, 1);
    } finally { f.clean(); }
  });

  test("init exposes worker choices and queue syntax; config is compact with explicit full detail", () => {
    const f = fixture();
    try {
      assert.match(f.initialized, /roles\[2\]/);
      assert.match(f.initialized, /implementer,copilot,gpt-5.6-sol,high,write/);
      assert.match(f.initialized, /verifier,claude,opus,high,read/);
      assert.match(f.initialized, /--prompt/);
      assert.doesNotMatch(f.initialized, /herdr-axi run --help/);
      assert.deepEqual(f.calls().map(({ group, action }) => [group, action]), [["agent", "get"]]);
      const before = f.state(), calls = f.calls().length;
      const compact = f.ok(["run", "config"]), full = f.ok(["run", "config", "--full"]);
      assert.match(compact, /roles\[2\]/);
      assert.match(compact, /herdr-axi run config --full/);
      assert.match(full, /orchestrator:/);
      assert.match(full, /retention:/);
      assert(Buffer.byteLength(compact) < Buffer.byteLength(full));
      assert.equal(f.calls().length, calls, "config must not inspect panes or models");
      assert.deepEqual(f.state(), before);
      const startHint = f.execute(["start", "--help"]);
      assert.equal(startHint.status, 2);
      assert.match(startHint.output, /help\[1\]: herdr-axi run queue --help/);
      assert.equal(f.calls().length, calls);
      assert.equal(f.execute(["run", "config", "--full=false"]).status, 1);
      f.ok(["run", "queue", "review", "--role", "verifier", "--cwd", f.state().project, "--area", ".", "--prompt-file", path.join(f.dir, "prompt")]);
      assert.equal(f.state().tasks[0].access, "read");
      assert.equal(f.state().tasks[0].kind, "claude");
      assert(!f.calls().some((c) => ["start", "create", "split", "prompt"].includes(c.action)), "init and queue do not start workers");
    } finally { f.clean(); }
  });

  test("inline queue and revision prompts need no project documents and reject ambiguous inputs", () => {
    const f = fixture();
    try {
      const cwd = f.state().project;
      const args = ["run", "queue", "review", "--role", "verifier", "--cwd", cwd, "--area", "."];
      const before = f.state();
      for (const input of [[], ["--prompt", " "], ["--prompt", "é".repeat(32001)], ["--prompt", "task", "--prompt-file", path.join(f.dir, "prompt")]]) {
        assert.equal(f.execute([...args, ...input]).status, 1);
        assert.deepEqual(f.state(), before);
      }
      const prompt = "Inspect branch; report checks.\nNo writes. 'quoted' $literal `text`";
      f.ok([...args, "--prompt", prompt]);
      assert.equal(f.state().tasks[0].prompt, prompt);
      assert.deepEqual(fs.readdirSync(cwd), []);
      f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      const settled = f.state();
      assert.equal(f.execute(["run", "revise", w.pane, "--prompt", "fix", "--prompt-file", path.join(f.dir, "prompt")]).status, 1);
      assert.deepEqual(f.state(), settled);
      f.ok(["run", "revise", w.pane, "--prompt", "Recheck branch only."]);
      const t = f.state().tasks[0];
      assert.equal(t.prompt, "Recheck branch only."); assert.equal(t.revisions[0].prompt, prompt);
      assert.equal(t.pane, w.pane);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 2);
      assert.deepEqual(fs.readdirSync(cwd), []);
    } finally { f.clean(); }
  });

  test("non-git busy work never suggests impossible Git snapshots and settled waits lead to inbox", () => {
    const f = fixture();
    try {
      f.queue("first", "shared"); f.queue("second", "shared");
      const output = f.ok(["run", "next"]);
      assert.match(output, /No verified Git HEAD/);
      assert.doesNotMatch(output, /worktree add|cleanupAfterClose|snapshot\[/);
      assert.match(output, /run move second/);
      const w = f.state().workers[0]; f.complete(w);
      const waited = f.ok(["wait", w.pane, "--until", "idle", "--timeout-ms", "100"]);
      assert.match(waited, /help\[1\]: herdr-axi run inbox/);
      assert.doesNotMatch(waited, /herdr-axi read/);
      const refused = f.execute(["run", "close", w.pane]);
      assert.equal(refused.status, 1);
      assert.match(refused.output, /review inbox then accept/);
      assert.match(refused.output, /herdr-axi run inbox/);
      assert(!f.calls().some((c) => c.action === "close"));
    } finally { f.clean(); }
  });

  test("busy verifier gets executable isolation recovery; move preserves task and never touches foreign panes", () => {
    const f = fixture();
    try {
      const cwd = path.join(f.dir, "source's repo"); fs.mkdirSync(cwd);
      const git = (...args) => {
        const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr); return r.stdout;
      };
      git("init"); fs.mkdirSync(path.join(cwd, "src"));
      fs.writeFileSync(path.join(cwd, "src", "value"), "committed"); git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
      fs.writeFileSync(path.join(cwd, "src", "value"), "dirty");
      fs.writeFileSync(path.join(cwd, "untracked"), "keep");
      const dirty = git("status", "--porcelain");
      const pane = "wFOREIGN:pOTHER";
      fs.writeFileSync(path.join(f.dir, `${pane}.agent`), JSON.stringify({ ...owner, pane_id: pane, workspace_id: "wFOREIGN", tab_id: "wFOREIGN:tOTHER", name: "unowned", cwd, agent_status: "idle" }));
      f.ok(["run", "queue", "review", "--role", "verifier", "--cwd", path.join(cwd, "src"), "--area", ".", "--prompt", "Read value in the assigned cwd; report snapshot, no writes."]);
      const original = f.state().tasks[0];
      const source = `import { runCommand } from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)}; console.log(JSON.stringify(await runCommand("next", {_:[]})));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const blocked = JSON.parse(result.stdout);
      assert.deepEqual(blocked.started, []);
      assert.equal(blocked.deferred[0].pane, pane);
      assert.equal(blocked.deferred[0].worktree, fs.realpathSync(cwd));
      assert.match(blocked.isolation.note, /HEAD-only.*dirty\/untracked/);
      assert.doesNotMatch(JSON.stringify(blocked.help), /herdr-axi read|run status/);
      assert(!f.calls().some((c) => ["start", "prompt", "read", "close"].includes(c.action)));
      // Execute the actual suggested commands, including shell quoting and a real Git worktree.
      const shell = (cmd) => {
        const r = spawnSync("/bin/sh", ["-c", cmd], { env: { ...f.env, PATH: `${path.dirname(cli)}:${f.env.PATH}` }, encoding: "utf8", timeout: 20000 });
        assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout;
      };
      shell(blocked.isolation.snapshot[0]);
      shell(blocked.isolation.snapshot[1]);
      const moved = f.state().tasks[0];
      for (const k of ["id", "prompt", "role", "model", "effort", "policy", "access", "deps", "phase", "state"]) assert.deepEqual(moved[k], original[k]);
      assert.notEqual(moved.worktree, original.worktree);
      assert.equal(moved.area, moved.cwd);
      assert.equal(moved.cwd, path.join(moved.worktree, "src"), "snapshot relocation preserves subtree scope");
      assert.equal(fs.readFileSync(path.join(moved.cwd, "value"), "utf8"), "committed");
      assert(!fs.existsSync(path.join(moved.worktree, "untracked")));
      assert(f.state().events.some((e) => e.action === "move" && e.from === original.cwd && e.to === moved.cwd));
      shell(blocked.isolation.snapshot[2]);
      assert.equal(f.state().tasks[0].state, "running");
      const active = f.state();
      assert.equal(f.execute(["run", "move", "review", "--cwd", cwd]).status, 1);
      assert.deepEqual(f.state(), active);
      const w = active.workers[0]; f.complete(w);
      f.ok(["run", "accept", w.pane, "--evidence", "fixture checked"]);
      f.ok(["run", "close", w.pane]); shell(blocked.isolation.cleanupAfterClose);
      assert.equal(git("status", "--porcelain"), dirty);
      assert.equal(fs.readFileSync(path.join(cwd, "src", "value"), "utf8"), "dirty");
      assert(!f.calls().some((c) => ["prompt", "read", "send-keys", "close"].includes(c.action) && c.args.some((a) => a.startsWith("wFOREIGN:"))));
    } finally { f.clean(); }
  });

  test("phase and ineligible next guidance avoid redundant status loops", () => {
    const f = fixture();
    try {
      assert.match(f.ok(["run", "phase", "explore", "--cap", "1"]), /help\[1\]: herdr-axi run queue --help/);
      f.queue("a");
      assert.match(f.ok(["run", "phase", "explore"]), /help\[1\]: herdr-axi run next/);
      f.ok(["run", "phase", "build"]);
      const result = f.ok(["run", "next"]);
      assert.match(result, /explicit phase change/);
      assert.match(result, /herdr-axi run phase explore/);
      assert.doesNotMatch(result, /herdr-axi run status/);
      assert(!f.calls().some((c) => ["start", "prompt", "read"].includes(c.action)));
    } finally { f.clean(); }
  });

  test("move validates before releasing reservations and remains retryable after publication failure", () => {
    const f = fixture();
    try {
      f.queue("a"); const original = f.state();
      const cwd = path.join(f.dir, "destination"); fs.mkdirSync(cwd);
      for (const extra of [{ HERDR_PANE_ID: "wOTHER:pOWNER" }]) {
        assert.equal(f.execute(["run", "move", "a", "--cwd", cwd], extra).status, 1);
        assert.deepEqual(f.state(), original);
      }
      const alias = path.join(f.dir, "state-alias"); fs.symlinkSync(f.env.HERDR_AXI_RUN, alias);
      for (const args of [["--cwd", cwd, "--area", "../escape"], ["--cwd", f.env.HERDR_AXI_RUN], ["--cwd", alias], ["--cwd", path.join(f.dir, "prompt")]]) {
        assert.equal(f.execute(["run", "move", "a", ...args]).status, 1);
        assert.deepEqual(f.state(), original);
      }
      const source = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        import { runCommand } from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        import { loadRun } from ${JSON.stringify(new URL("../src/run-state.mjs", import.meta.url).href)};
        import { writerLease, leasePath } from ${JSON.stringify(new URL("../src/project.mjs", import.meta.url).href)};
        const run = loadRun(), task = run.tasks[0], file = leasePath(task);
        assert(writerLease(run, task));
        const value = fs.readFileSync(file);
        fs.writeFileSync(file, 'partial');
        await assert.rejects(runCommand('move', {_:['a'], cwd:${JSON.stringify(cwd)}}), {code:'LEASE_UNVERIFIED'});
        assert.deepEqual(loadRun(), run);
        fs.writeFileSync(file, value);
        const rename = fs.renameSync;
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json')) throw Error('publication failed'); return rename(a,b); };
        await assert.rejects(runCommand('move', {_:['a'], cwd:${JSON.stringify(cwd)}}), /publication failed/);
        fs.renameSync = rename;
        assert.deepEqual(loadRun(), run);
        assert(!fs.existsSync(file), 'no live work: released queued reservation can be reacquired');
        assert(writerLease(run, task));
        await runCommand('move', {_:['a'], cwd:${JSON.stringify(cwd)}});
        assert(!fs.existsSync(file), 'successful move must not leave old-tree reservation');
        // Foreign reservations are never released, even when moving away.
        const moved = loadRun(), newFile = leasePath(moved.tasks[0]);
        assert(writerLease({...moved,id:'foreign'}, moved.tasks[0]));
        const foreign = fs.readFileSync(newFile);
        await runCommand('move', {_:['a'], cwd:task.cwd});
        assert.deepEqual(fs.readFileSync(newFile), foreign);`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.state().tasks[0].cwd, original.tasks[0].cwd);
      assert(!f.calls().some((c) => ["start", "prompt", "read", "close"].includes(c.action)));
    } finally { f.clean(); }
  });

  test("full parked pool identifies a safe close; cancelled dependencies identify the blocked task", () => {
    const f = fixture();
    try {
      f.ok(["run", "phase", "explore", "--cap", "1"]);
      f.queue("old"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      f.queue("fresh");
      const full = f.ok(["run", "next"]);
      assert.match(full, /parked pool full/); assert(full.includes(`herdr-axi run close ${w.pane}`));
      assert.doesNotMatch(full, /herdr-axi run status/);
      f.ok(["run", "close", w.pane]); f.ok(["run", "next"]);
      assert.equal(f.state().tasks[1].state, "running");
      const fresh = f.state().workers.find((p) => !p.closed); f.complete(fresh);
      f.ok(["run", "accept", fresh.pane, "--evidence", "checked"]);
      assert(f.ok(["run", "next"]).includes(`herdr-axi run close ${fresh.pane}`));
      f.ok(["run", "close", fresh.pane]);
      assert.match(f.ok(["run", "next"]), /herdr-axi run finish/);
      f.queue("cancelled"); f.queue("dependent", "dependent", "cancelled");
      f.ok(["run", "cancel", "cancelled"]);
      const blocked = f.ok(["run", "next"]);
      assert.match(blocked, /unaccepted dependency/); assert.match(blocked, /herdr-axi run cancel dependent/);
      assert.equal(f.state().tasks.find((t) => t.id === "dependent").state, "queued");
    } finally { f.clean(); }
  });

  test("run scopes ownership and excludes self from reads, waits, prompts and close", () => {
    const f = fixture();
    try {
      assert.match(f.ok(["fleet"]), /occupied: 0/);
      assert.doesNotMatch(f.ok(["agents", "--all"]), /pOWNER/);
      for (const args of [["read", owner.pane_id], ["wait", owner.pane_id], ["dispatch", owner.pane_id, "hello"], ["run", "close", owner.pane_id]]) assert.equal(f.execute(args).status, 1);
      assert.equal(f.execute(["run", "init", "--dir", f.env.HERDR_AXI_RUN]).status, 1);
      assert.match(f.execute(["run", "init"], { HERDR_AXI_WORKER: "1" }).output, /NESTED_RUN/);
      assert.equal(f.execute(["run", "phase", "fix"], { HERDR_PANE_ID: "wTEST:pOTHER" }).status, 1);
      assert(!f.calls().some((c) => ["prompt", "send-keys", "close"].includes(c.action)));
      const lock = path.join(f.env.HERDR_AXI_RUN, "run.lock");
      fs.writeFileSync(lock, String(process.pid));
      assert.match(f.execute(["run", "unlock"]).output, /RUN_BUSY/);
      assert.match(f.execute(["run", "phase", "fix"]).output, /RUN_BUSY/);
      fs.writeFileSync(lock, "2147483647");
      f.ok(["run", "unlock"]);
      assert(!fs.existsSync(lock));
      const guard = path.join(f.env.HERDR_AXI_RUN, "run.unlock");
      fs.writeFileSync(guard, "");
      assert.match(f.execute(["run", "phase", "fix"]).output, /RUN_BUSY/);
      fs.unlinkSync(guard);
    } finally { f.clean(); }
  });

  test("compact role preview preserves custom contracts and discloses overflow", () => {
    const f = fixture();
    try {
      const r = f.state();
      r.limits.explore = 2;
      r.config.roles.implementer.subagents = [{ role: "verifier", max: 1, when: "review only" }];
      for (let i = 0; i < 10; i++) r.config.roles[`reviewer${i}`] = { ...r.config.roles.verifier, model: "claude-opus-5" };
      f.write(r);
      const compact = f.ok(["run", "config"]);
      assert.match(compact, /roles\[8\]/);
      assert.match(compact, /moreRoles: 4/);
      assert.match(compact, /implementer,copilot,gpt-5.6-sol,high,write,1/);
      assert.match(compact, /capacity: 2/);
      assert.doesNotMatch(compact, /reviewer9/);
      const full = f.ok(["run", "config", "--full"]);
      assert.match(full, /reviewer9:/);
      assert.match(full, /review only/);
      assert.deepEqual(f.state(), r, "summaries never trim or rewrite stored contracts");
      f.ok(["run", "queue", "last", "--role", "reviewer9", "--cwd", r.project, "--area", ".", "--prompt-file", path.join(f.dir, "prompt")]);
      assert.equal(f.state().tasks[0].model, "claude-opus-5");
    } finally { f.clean(); }
  });

  test("queue validates dependencies and paths; cancelled dependencies never unlock work", () => {
    const f = fixture();
    try {
      f.queue("a"); f.queue("b", "b", "a");
      assert.equal(f.execute(["run", "queue", "bad", "--kind", "codex", "--cwd", f.dir, "--area", "../escape", "--prompt-file", path.join(f.dir, "prompt")]).status, 1);
      f.ok(["run", "cancel", "a"]);
      assert.match(f.ok(["run", "next"]), /No eligible task/);
      assert.equal(f.state().tasks[1].state, "queued");
    } finally { f.clean(); }
  });

  test("reservation blocks overspawn and overlapping areas across concurrent next calls", async () => {
    const f = fixture();
    try {
      f.ok(["run", "phase", "explore", "--cap", "2"]);
      f.queue("a", "shared"); f.queue("overlap", "shared/child"); f.queue("b", "other"); f.queue("c");
      const results = await Promise.all([f.asyncRun(["run", "next"]), f.asyncRun(["run", "next"])]);
      for (const r of results) assert(r.status === 0 || /RUN_BUSY/.test(r.output), r.output);
      for (const r of results) assert.doesNotMatch(r.output, /uncertain/, r.output);
      const r = f.state();
      assert.equal(r.workers.length, 2);
      const first = r.workers.find((w) => w.pane === r.tasks.find((t) => t.id === "a").pane);
      assert.equal(r.tasks.find((t) => t.id === "overlap").state, "queued");
      assert.equal(r.tasks.find((t) => t.id === "c").state, "queued");
      assert.equal(f.calls().filter((c) => c.group === "tab" && c.action === "create").length, 2);
      assert.equal(f.execute(["run", "phase", "fix"]).status, 1);
      assert.equal(f.execute(["dispatch", r.workers[0].pane, "bypass budget"]).status, 1);
      assert.match(f.ok(["watch", "--timeout-ms", "40"]), /changed: false/);
      for (const w of r.workers) f.complete(w);
      assert.match(f.ok(["fleet"]), /review/);
      assert.match(f.ok(["run", "inbox"]), /checks passed/);
      assert.equal(f.execute(["run", "close", r.workers[0].pane]).status, 1);
      assert.equal(f.execute(["run", "accept", r.workers[0].pane]).status, 1);
      f.ok(["run", "accept", first.pane, "--evidence", "Reviewed hello and test result"]);
      f.ok(["run", "next"]);
      assert.equal(f.state().workers.length, 2, "reuse must not open another tab");
      assert.equal(f.state().tasks.find((t) => t.id === "overlap").state, "running");
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, `${first.pane}.agent`))).label, "overlap · codex", "reused tab follows its current assignment");
      const second = f.state().workers.find((w) => w.pane !== first.pane);
      const oldGeneration = second.generation;
      f.ok(["run", "revise", second.pane, "--prompt-file", path.join(f.dir, "prompt")]);
      assert.notEqual(f.state().workers.find((w) => w.pane === second.pane).generation, oldGeneration);
      assert.equal(f.execute(["run", "accept", second.pane, "--evidence", "stale review"]).status, 1);
      for (const w of f.state().workers) {
        f.complete(w);
        f.ok(["run", "accept", w.pane, "--evidence", "Reviewed final checks"]);
      }
      f.ok(["run", "phase", "fix"]);
      assert.equal(f.state().workers.filter((w) => !w.closed).length, 1, "phase reduction retires excess accepted workers");
    } finally { f.clean(); }
  });

  test("unknown/lost never releases capacity; stale proof cannot be accepted; owner tab cannot close", () => {
    const f = fixture();
    try {
      const r = f.state();
      const w = { pane: "wTEST:pWORKER", tab: "wTEST:tWORKER", workspace: "wTEST", terminal: "worker", kind: "codex", cwd: f.dir, name: "worker", receipt: path.join(f.dir, "receipt"), generation: "new" };
      fs.writeFileSync(path.join(f.dir, `${w.pane}.agent`), JSON.stringify({ ...owner, name: w.name, pane_id: w.pane, tab_id: w.tab, terminal_id: w.terminal, agent_status: "unknown" }));
      r.workers.push(w); r.tasks.push({ id: "a", pane: w.pane, state: "running", area: f.dir }); f.write(r);
      assert.match(f.ok(["fleet"]), /unknown/);
      f.complete({ ...w, generation: "old" });
      assert.equal(f.execute(["run", "accept", w.pane, "--evidence", "old"]).status, 1);
      fs.unlinkSync(path.join(f.dir, `${w.pane}.agent`));
      assert.match(f.ok(["fleet"]), /lost/);
      assert.equal(f.state().tasks[0].state, "running");
      r.workers[0].tab = owner.tab_id; r.tasks[0].state = "accepted"; f.write(r);
      assert.match(f.execute(["run", "close", w.pane]).output, /SELF_TARGET/);
      assert(!f.calls().some((c) => c.action === "close"));
    } finally { f.clean(); }
  });

  test("startup dialogs stay inspectable; recover submits once in the same owned pane", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "startup-blocked"), "");
      f.queue("a"); const result = f.ok(["run", "next"]);
      assert.match(result, /blocked/); assert.match(result, /submitted: false/);
      assert.match(result, /startupOutput: Worker result/);
      const w = f.state().workers[0];
      assert.match(result, new RegExp(`herdr-axi read ${w.pane} --raw`));
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, `${w.pane}.agent`))).label, "a · codex");
      assert.equal(f.calls().filter((c) => ["prompt", "send-keys"].includes(c.action)).length, 0);
      assert.match(f.ok(["read", w.pane]), /Worker result/);
      assert.equal(f.execute(["run", "recover", "a"]).status, 1);
      f.ok(["dispatch", w.pane, "--keys", "enter"]);
      assert.match(f.ok(["run", "recover", "a"]), /running/);
      assert.equal(f.state().tasks[0].errorCode, undefined, "successful launch clears the old startup error");
      assert.equal(f.calls().filter((c) => c.action === "create").length, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
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

  test("ambiguous submission preserves capacity and recovery never duplicates the prompt", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "prompt-uncertain"), "");
      f.queue("a"); assert.match(f.ok(["run", "next"]), /uncertain/);
      const w = f.state().workers[0];
      assert.equal(f.state().tasks[0].state, "uncertain");
      f.ok(["run", "recover", w.pane]);
      assert.equal(f.state().tasks[0].state, "running");
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
      fs.unlinkSync(path.join(f.dir, `${w.pane}.agent`));
      assert.match(f.execute(["run", "recover", w.pane]).output, /RESOURCES_REMAIN/);
      fs.unlinkSync(path.join(f.dir, `${w.monitor}.monitor`));
      assert.match(f.ok(["run", "recover", w.pane]), /requeued/);
      assert.equal(f.state().tasks[0].state, "queued");
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

  test("cosmetic relabel failure cannot corrupt task delivery or trigger a resend", () => {
    const f = fixture();
    try {
      f.queue("first", "shared"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      fs.writeFileSync(path.join(f.dir, "rename-fail"), "");
      f.queue("second", "shared");
      const result = f.ok(["run", "next"]);
      assert.match(result, /labelError/); assert.doesNotMatch(result, /uncertain/);
      assert.equal(f.state().tasks[1].state, "running");
      assert.notEqual(f.state().workers[0].generation, w.generation);
      assert.equal(f.execute(["run", "recover", w.pane]).status, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 2);
    } finally { f.clean(); }
  });

  test("one writer per Git worktree, concurrent verifier, native model policy and durable finish", () => {
    const f = fixture();
    try {
      const cwd = path.join(f.dir, "project");
      assert.equal(spawnSync("git", ["init", "-q", cwd]).status, 0);
      fs.mkdirSync(path.join(cwd, "src"));
      const r = f.state(); r.config.sharedReadWorktree = true; r.config.roles.implementer.subagents = [{ role: "verifier", max: 1, when: "review" }]; f.write(r);
      const queue = (id, role, dir, area) => f.ok(["run", "queue", id, "--role", role, "--cwd", dir, "--area", area, "--prompt-file", path.join(f.dir, "prompt")]);
      queue("writer", "implementer", cwd, "src/a");
      queue("collision", "implementer", path.join(cwd, "src"), "b");
      queue("reviewer", "verifier", cwd, ".");
      assert.equal(f.execute(["run", "finish"]).status, 1);
      f.ok(["run", "next"]);
      const started = f.state();
      assert.equal(started.workers.length, 2);
      assert.equal(started.tasks.find((t) => t.id === "collision").state, "queued");
      assert.match(f.ok(["fleet"]), /nativeReserved: 1/);
      const starts = f.calls().filter((c) => c.action === "start");
      assert(starts.some((c) => c.args.includes("gpt-5.6-sol") && c.args.includes("--effort")));
      const creation = f.calls().find((c) => c.action === "create");
      const workerPath = creation.args.find((v) => v.startsWith("PATH=")).slice(5);
      const onPath = spawnSync("/bin/sh", ["-c", "command -v herdr-axi; herdr-axi agents --help"], { cwd: cwd, env: { ...f.env, PATH: workerPath }, encoding: "utf8" });
      assert.equal(onPath.status, 0, onPath.stderr); assert.match(onPath.stdout, /Selected run by default/);
      const prompts = f.calls().filter((c) => c.action === "prompt").map((c) => c.args[1]);
      assert(prompts.some((s) => s.includes("Native subagents only") && s.includes("Read-only project") === false));
      assert(prompts.some((s) => s.includes("Read-only project")));
      assert(prompts.every((s) => s.includes("concise TOON") && s.includes("No repository state files")));
      for (const w of started.workers) { f.complete(w); f.ok(["run", "accept", w.pane, "--evidence=Reviewed files; bytes=6; exact hello and no extra docs"]); f.ok(["run", "close", w.pane]); }
      f.ok(["run", "cancel", "collision"]);
      fs.writeFileSync(path.join(f.env.HERDR_AXI_RUN, "user-notes"), "keep");
      assert.match(f.ok(["run", "finish"]), /archived: true/);
      assert(fs.existsSync(path.join(f.env.HERDR_AXI_RUN, "detail.json.gz")));
      assert(!fs.existsSync(path.join(f.env.HERDR_AXI_RUN, "task-writer.txt")));
      assert(fs.existsSync(path.join(f.env.HERDR_AXI_RUN, "user-notes")));
      assert.match(f.ok(["run", "history", "--task", "writer"]), /Write hello/);
      assert.match(f.ok(["run", "history"]), /Reviewed files/);
      const offline = f.execute(["run", "history", "--task", "writer"], { HERDR_ENV: "" });
      assert.equal(offline.status, 0, offline.output); assert.match(offline.output, /bytes=6/);
      assert.equal((offline.output.match(/checks passed/g) ?? []).length, 1, "detailed history must not repeat its result as a summary");
      assert.equal(f.execute(["run", "next"]).status, 1);
      assert.match(f.ok(["fleet"]), /complete: true/);
    } finally { f.clean(); }
  });

  test("context probes are cached and bounded; warnings wake a working fleet immediately", () => {
    const f = fixture();
    try {
      for (const id of ["a", "b", "c"]) f.queue(id);
      f.ok(["run", "next"]);
      fs.writeFileSync(path.join(f.dir, "context-footer"), "Context 10% left · weekly 91% left");
      const reads = () => f.calls().filter((c) => c.action === "read").length;
      const before = reads();
      assert.match(f.ok(["fleet"]), /critical/); assert.equal(reads() - before, 2);
      f.ok(["fleet"]); assert.equal(reads() - before, 3);
      f.ok(["fleet"]); assert.equal(reads() - before, 3);
      const at = Date.now();
      assert.match(f.ok(["watch", "--timeout-ms", "10000"]), /critical/);
      assert(Date.now() - at < 5000, "known warning should not wait out the timeout");
    } finally { f.clean(); }
  });

  test("quiet inbox and working reads guide independent work or one watch, not a read/inbox loop", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]); const w = f.state().workers[0];
      f.ok(["run", "status"]); // Prime bounded context probes.
      const before = f.calls().filter((c) => c.action === "read").length;
      for (let i = 0; i < 3; i++) {
        const output = f.ok(["run", "inbox"]);
        assert.match(output, /events: \[\]/); assert.match(output, /pending: 1/);
        assert.match(output, /Continue independent work/); assert.match(output, /help\[1\]: herdr-axi watch/);
        assert.doesNotMatch(output, /herdr-axi read|herdr-axi run inbox|tasks\[|contextUnknown/);
        assert(Buffer.byteLength(output) < 400, output);
      }
      assert.equal(f.calls().filter((c) => c.action === "read").length, before, "empty inbox must not fetch terminal progress");
      const read = f.ok(["read", w.pane]);
      assert.match(read, /herdr-axi watch/); assert.match(read, /Still working; not a result/);
      f.complete(w);
      const result = f.ok(["run", "inbox"]);
      assert.match(result, /checks passed/); assert.match(result, /herdr-axi run accept/);
      assert.doesNotMatch(result, /help.*herdr-axi run inbox/);
    } finally { f.clean(); }
  });

  test("watch ignores historical telemetry churn, emits compact timeout, and wakes for new warnings or proof", async () => {
    const f = fixture(); let watching;
    try {
      f.queue("a"); f.ok(["run", "next"]); const w = f.state().workers[0];
      const file = path.join(f.env.HERDR_AXI_RUN, "context.json");
      const cache = (percent, stale) => fs.writeFileSync(file, JSON.stringify({ [w.pane]: { generation: w.generation, percent, at: Date.now() - (stale ? 200000 : 0), attemptedAt: Date.now(), source: "native-context" } }));
      for (const event of ["telemetry", "warning", "proof"]) {
        cache(20, event === "telemetry");
        const before = f.calls().filter((c) => c.action === "list").length;
        watching = f.asyncRun(["watch", "--timeout-ms", "600"]);
        const deadline = Date.now() + 5000;
        while (f.calls().filter((c) => c.action === "list").length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 100));
        if (event === "proof") f.complete(w); else cache(event === "warning" ? 92 : 25, event === "telemetry");
        const result = await watching;
        assert.equal(result.status, 0, result.output);
        if (event === "telemetry") {
          assert.match(result.output, /changed: false/); assert.match(result.output, /reason: timeout/);
          assert.doesNotMatch(result.output, /tasks\[|contextLastKnown|contextStale/);
          assert(Buffer.byteLength(result.output) < 400, result.output);
        } else {
          assert.match(result.output, /changed: true/);
          assert.match(result.output, event === "warning" ? /critical/ : /review/);
        }
      }
      const immediate = f.ok(["watch", "--timeout-ms", "600"]);
      assert.match(immediate, /reason: attention/); assert.match(immediate, /review/);
    } finally { if (watching) await watching; f.clean(); }
  });

  test("identity drift degrades status and blocks control, without blocking unrelated tasks", () => {
    const f = fixture();
    try {
      f.queue("old"); f.ok(["run", "next"]);
      const r = f.state(), w = r.workers[0]; w.session = "original"; f.write(r);
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      a.agent_session = { value: "replacement" }; a.terminal_title_stripped = "claude --model lots of command noise";
      fs.writeFileSync(file, JSON.stringify(a));
      for (const args of [[], ["fleet"], ["run", "status"], ["run", "inbox"], ["watch", "--timeout-ms", "10000"]]) assert.match(f.ok(args), /lost/);
      assert.match(f.ok(["agents", "--all"]), new RegExp(w.name));
      assert.doesNotMatch(f.ok(["agents", "--all"]), /command noise/);
      for (const args of [["dispatch", w.pane, "no"], ["run", "close", w.pane], ["run", "recover", w.pane]]) assert.equal(f.execute(args).status, 1);
      f.queue("fresh"); f.ok(["run", "next"]);
      assert.equal(f.state().tasks[1].state, "running");
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 2);
      assert(!f.calls().some((c) => ["send-keys", "close"].includes(c.action)));
    } finally { f.clean(); }
  });

  test("task-scoped watch waits past unrelated loss and wakes with the selected report", async () => {
    const f = fixture(); let watching;
    try {
      f.queue("lost"); f.queue("healthy"); f.ok(["run", "next"]);
      const state = f.state();
      const [lost, healthy] = ["lost", "healthy"].map((id) => state.workers.find((w) => w.pane === state.tasks.find((t) => t.id === id).pane));
      fs.unlinkSync(path.join(f.dir, `${lost.pane}.agent`));
      const inbox = f.ok(["run", "inbox"]);
      assert.match(inbox, /run recover lost/); assert.doesNotMatch(inbox, /agents --all/);
      assert.match(inbox, /watch --task healthy/);
      assert.match(f.execute(["watch", "--task", "absent"]).output, /UNKNOWN_TASK/);
      const start = Date.now();
      const timeout = f.ok(["run", "watch", "--task", "healthy", "--timeout-ms", "300"]);
      assert(Date.now() - start >= 300); assert.match(timeout, /reason: timeout/); assert.match(timeout, /watching: healthy/);
      const agentFile = path.join(f.dir, `${healthy.pane}.agent`), native = JSON.parse(fs.readFileSync(agentFile));
      native.agent_status = "done"; fs.writeFileSync(agentFile, JSON.stringify(native));
      assert.match(f.ok(["watch", "--task", "healthy", "--timeout-ms", "300"]), /reason: timeout/, "native settlement alone is not a finished task");
      watching = f.asyncRun(["watch", "--task", "healthy", "--timeout-ms", "6000"]);
      await new Promise((resolve) => setTimeout(resolve, 600));
      f.complete(healthy);
      const result = await watching;
      assert.equal(result.status, 0, result.output); assert.match(result.output, /reason: (state-change|attention)/);
      assert.match(result.output, /watching: healthy/); assert.match(result.output, /checks passed/);
      assert(result.output.includes(`run accept ${healthy.pane}`));
      assert.equal(f.state().tasks[0].state, "running", "no implicit resolution of unrelated lost work");
    } finally { if (watching) await watching; f.clean(); }
  });

  test("selection rollback removes leases even when durable state publication fails", () => {
    const f = fixture();
    try {
      f.queue("a"); f.queue("b");
      const source = `import fs from 'node:fs';
        import { runCommand } from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const rename = fs.renameSync;
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json')) throw Error('injected save failure'); return rename(a,b); };
        try { await runCommand('next', { _: [] }); process.exitCode = 2; }
        catch (e) { if (!e.message.includes('injected save failure')) throw e; }`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert(f.state().tasks.every((t) => t.state === "queued"));
      assert.equal(fs.readdirSync(path.join(f.env.HERDR_AXI_STATE_HOME, "writers")).length, 0);
      assert(!f.calls().some((c) => c.action === "start"));
      f.ok(["run", "next"]);
      assert(f.state().tasks.every((t) => t.state === "running"));
    } finally { f.clean(); }
  });

  test("launch publication retries a competing transaction without resending", async () => {
    const f = fixture();
    try {
      f.queue("a");
      const result = f.asyncRun(["run", "next"]);
      const deadline = Date.now() + 10000;
      while (!f.calls().some((c) => c.action === "prompt") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert(f.calls().some((c) => c.action === "prompt"));
      const lock = path.join(f.env.HERDR_AXI_RUN, "run.lock");
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(f.state().tasks[0].state, "starting");
      fs.unlinkSync(lock);
      const done = await result;
      assert.equal(done.status, 0, done.output);
      assert.equal(f.state().tasks[0].state, "running");
      assert.equal(f.state().workers.length, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
    } finally { f.clean(); }
  });

  test("inbox keeps healthy worker events when another collection or inbox is broken", () => {
    const f = fixture();
    try {
      f.queue("a"); f.queue("b"); const started = f.ok(["run", "next"]);
      assert.equal(f.state().workers.length, 2, started);
      const [bad, good] = f.state().workers;
      f.complete(bad, "idle"); f.complete(good);
      fs.unlinkSync(bad.receipt);
      fs.writeFileSync(`${bad.receipt}.proof.${bad.generation}`, bad.generation);
      fs.writeFileSync(`${bad.receipt}.inbox`, "broken json");
      // Fail only engine subprocesses after startup; status reads remain live.
      fs.symlinkSync("/usr/bin/false", path.join(f.dir, "bin/bash"));
      const result = f.ok(["run", "inbox"]);
      assert.match(result, /Engine failed/); assert.match(result, /errors/); assert.match(result, /checks passed/);
    } finally { f.clean(); }
  });

  test("read-only roles serialize in a shared worktree unless explicitly opted in", () => {
    const f = fixture();
    try {
      const cwd = path.join(f.dir, "project");
      for (const [id, role] of [["writer", "implementer"], ["reader", "verifier"]]) f.ok(["run", "queue", id, "--role", role, "--cwd", cwd, "--area", ".", "--prompt-file", path.join(f.dir, "prompt")]);
      f.ok(["run", "next"]);
      assert.equal(f.state().workers.length, 1);
      assert.equal(f.state().tasks[1].state, "queued");
      const w = f.state().workers[0]; f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      f.ok(["run", "next"]);
      assert.equal(f.state().tasks[1].state, "running");
    } finally { f.clean(); }
  });

  test("sixteen workers retain historical evidence without stale actionable warnings or double counts", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "context-footer"), "Context 10% left");
      const source = `import assert from 'node:assert/strict';
        import { contextStatus } from ${JSON.stringify(new URL("../src/context.mjs", import.meta.url).href)};
        let now = 1000000; Date.now = () => now;
        const workers = Array.from({length:16}, (_,i) => ({pane:'wTEST:p'+i, kind:'codex', generation:'g'+i}));
        const run = {config:{context:{warnPercent:70, criticalPercent:85}}};
        let result;
        for(let i=0;i<12;i++) { result = contextStatus(run,workers,workers); now += 30000; }
        assert.equal(result.warnings.length + result.lastKnown.length,16);
        assert(result.stale > 0);
        assert.equal(result.stale, result.lastKnown.length);
        assert.equal(result.unknown,0);
        assert(result.lastKnown.every(w => now - 30000 - w.observedAt > 120000));`;
      const before = f.calls().filter((c) => c.action === "read").length;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.calls().filter((c) => c.action === "read").length - before, 24);
    } finally { f.clean(); }
  });

  test("read sharing never bypasses a visible foreign-workspace worker without a lease", () => {
    const f = fixture();
    try {
      const r = f.state(); r.config.sharedReadWorktree = true; f.write(r);
      const cwd = path.join(f.dir, "project"), pane = "wZZFOREIGN:pOTHER";
      f.ok(["run", "queue", "writer", "--role", "implementer", "--cwd", cwd, "--area", ".", "--prompt-file", path.join(f.dir, "prompt")]);
      f.ok(["run", "next"]);
      fs.writeFileSync(path.join(f.dir, `${pane}.agent`), JSON.stringify({ ...owner, pane_id: pane, workspace_id: "wZZFOREIGN", tab_id: "wZZFOREIGN:tOTHER", name: "other-run", cwd }));
      f.ok(["run", "queue", "read", "--role", "verifier", "--cwd", cwd, "--area", ".", "--prompt-file", path.join(f.dir, "prompt")]);
      const result = f.ok(["run", "next"]);
      assert.match(result, /worktree busy/); assert(result.includes(pane));
      assert.equal(f.state().tasks[1].state, "queued");
      assert.equal(f.calls().filter((c) => c.action === "start").length, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
      assert(!f.calls().some((c) => ["send-keys", "close"].includes(c.action)));
    } finally { f.clean(); }
  });

  test("failed publication leaves a recoverable registry, never an untracked resend", () => {
    const f = fixture();
    try {
      f.queue("a");
      const source = `import fs from 'node:fs';
        import { runCommand } from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const rename = fs.renameSync;
        fs.renameSync = (a,b) => {
          if (b.endsWith('/run.json') && JSON.parse(fs.readFileSync(a)).tasks.some(t => t.state === 'running')) throw Error('publication failed');
          return rename(a,b);
        };
        console.log(JSON.stringify(await runCommand('next', { _: [] })));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /record_pending/);
      assert.match(result.stdout, /herdr-axi run recover a/);
      assert.equal(f.state().tasks[0].state, "starting");
      assert.match(f.ok(["fleet"]), /wTEST:p/);
      f.ok(["run", "recover", "a"]);
      assert.equal(f.state().tasks[0].state, "running");
      assert.equal(f.state().workers.length, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
      const leases = path.join(f.env.HERDR_AXI_STATE_HOME, "writers");
      const lease = path.join(leases, fs.readdirSync(leases)[0]), value = fs.readFileSync(lease);
      const w = f.state().workers[0]; f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      fs.writeFileSync(lease, value); // Crash after accepted state, before lease removal.
      assert.match(f.ok(["run", "recover", "a"]), /releasedLease/);
      assert.equal(fs.readdirSync(leases).length, 0);
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

  test("unverified registry remains visible with a diagnostic pane, never control authority", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]);
      const r = f.state(), w = r.workers[0]; r.workers = []; f.write(r);
      const registry = path.join(path.dirname(w.receipt), `${w.name}.json`);
      const value = JSON.parse(fs.readFileSync(registry)); value.receipt_file = "/wrong/event";
      fs.writeFileSync(registry, JSON.stringify(value));
      const agents = f.ok(["agents"]);
      assert.match(agents, /ownershipIssues/); assert(agents.includes(w.pane)); assert.doesNotMatch(agents, /0 matching agents/);
      assert.match(f.ok(["run", "status"]), /unverified/);
      assert.equal(f.execute(["dispatch", w.pane, "unsafe"]).status, 1);
      const source = `import assert from 'node:assert/strict'; import fs from 'node:fs';
        import {agents} from ${JSON.stringify(new URL("../src/commands.mjs", import.meta.url).href)};
        const read=fs.readFileSync; fs.readFileSync=(file,...args)=>{if(file===${JSON.stringify(registry)}) throw Object.assign(Error('injected I/O failure'),{code:'EIO'}); return read(file,...args);};
        const result=agents([]); assert.equal(result.ownershipIssues[0].pane,${JSON.stringify(w.pane)}); assert(result.ownershipIssues[0].error.includes('I/O failure'));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    } finally { f.clean(); }
  });

  test("failed and unverified context probes preserve evidence, never spin watch", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]);
      const w = f.state().workers[0], at = Date.now() - 200000;
      const file = path.join(f.env.HERDR_AXI_RUN, "context.json");
      fs.writeFileSync(file, JSON.stringify({ [w.pane]: { generation: w.generation, percent: 92, at, source: "native-context" } }));
      const status = f.ok(["fleet"]);
      assert.match(status, /contextLastKnown/); assert.match(status, /92/); assert.doesNotMatch(status, /contextWarnings|contextUnknown/);
      assert.equal(JSON.parse(fs.readFileSync(file))[w.pane].percent, 92);
      const start = Date.now(); assert.match(f.ok(["watch", "--timeout-ms", "350"]), /changed: false/);
      assert(Date.now() - start >= 300);
      const source = `import assert from 'node:assert/strict'; import fs from 'node:fs';
        import {contextStatus} from ${JSON.stringify(new URL("../src/context.mjs", import.meta.url).href)};
        const w=${JSON.stringify(w)}, run=${JSON.stringify(f.state())};
        const other={pane:'wTEST:pOther',kind:'claude',generation:'other'};
        let s=contextStatus(run,[w,other],[other]);
        assert.equal(s.stale,1); assert.equal(s.unknown,1); assert.equal(s.lastKnown[0].percent,92);
        assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(file)}))[w.pane].percent,92);
        let now=Date.now(); Date.now=()=>now;
        for(const kind of ['claude','copilot']) { now+=16000; s=contextStatus(run,[{...w,kind}],[w]); assert.equal(s.lastKnown[0].percent,92); }
        s=contextStatus(run,[{...w,generation:'new'}],[w]); assert.equal(s.unknown,1); assert.equal(s.lastKnown.length,0);`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    } finally { f.clean(); }
  });

  test("accept refuses a missing or corrupt result; postcommit lease failure is recoverable even archived", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      for (const payload of [null, "broken", JSON.stringify({ generation: "old", summary: "stale" })]) {
        if (payload === null) fs.unlinkSync(`${w.receipt}.inbox`); else fs.writeFileSync(`${w.receipt}.inbox`, payload);
        assert.match(f.execute(["run", "accept", w.pane, "--evidence", "checked"]).output, /RESULT_UNAVAILABLE/);
        assert.equal(f.state().tasks[0].state, "running");
      }
      f.complete(w);
      const leases = path.join(f.env.HERDR_AXI_STATE_HOME, "writers"), lease = path.join(leases, fs.readdirSync(leases)[0]);
      const original = fs.readFileSync(lease); fs.writeFileSync(lease, "null");
      const accepted = f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      assert.match(accepted, /committed: true/); assert.match(accepted, /LEASE_UNVERIFIED/);
      assert.equal(f.state().tasks[0].state, "accepted"); assert.equal(f.state().tasks[0].summary, "checks passed");
      assert(f.ok(["run", "leases"]).includes(lease));
      f.ok(["run", "close", w.pane]);
      assert.match(f.execute(["run", "finish"]).output, /LEASE_UNVERIFIED/);
      assert(f.state().finishedAt, "archive published; lease cleanup warning must not misreport rollback");
      fs.writeFileSync(lease, original); f.ok(["run", "finish"]); assert(!fs.existsSync(lease));
      const archived = JSON.parse(gunzipSync(fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "detail.json.gz"))));
      assert.equal(JSON.parse(archived.inboxes[w.name]).summary, "checks passed");
      fs.writeFileSync(lease, original); // Legacy archive with a leaked own lease.
      const before = f.calls().length;
      const recovered = f.execute(["run", "recover", "a"], { HERDR_ENV: "" });
      assert.equal(recovered.status, 0, recovered.output); assert.match(recovered.output, /leaseReleased: true/);
      assert(!fs.existsSync(lease)); assert.equal(f.calls().length, before, "archived repair is offline, exact ownership only");
    } finally { f.clean(); }
  });

  test("revise preserves prior evidence and refuses corrupt reports before resubmission", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      const file = `${w.receipt}.inbox`, original = fs.readFileSync(file);
      for (const payload of ["broken", "null", JSON.stringify({ generation: "old", summary: "stale" })]) {
        fs.writeFileSync(file, payload);
        const before = fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "run.json"), "utf8");
        const r = f.execute(["run", "revise", w.pane, "--prompt", "Correction; recheck"]);
        assert.equal(r.status, 1, r.output);
        assert.match(r.output, /RESULT_UNAVAILABLE/);
        assert.equal(fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "run.json"), "utf8"), before);
        assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
      }
      const report = { ...JSON.parse(original), detail: "Prior detailed checks and rationale", truncated: true };
      fs.writeFileSync(file, JSON.stringify(report));
      f.ok(["run", "revise", w.pane, "--prompt", "Correction; recheck"]);
      assert.equal(f.state().tasks[0].revisions[0].result, report.detail);
      assert.equal(f.state().tasks[0].revisions[0].truncated, true);
      assert.equal(f.state().tasks[0].revisions[0].generation, w.generation);
      const next = f.state().workers[0]; f.complete(next);
      fs.writeFileSync(`${next.receipt}.inbox`, "broken");
      const replacement = path.join(f.dir, "reviewed.txt"); fs.writeFileSync(replacement, "Reviewed replacement; exact checks preserved");
      f.ok(["run", "revise", next.pane, "--prompt", "Final correction", "--result-file", replacement]);
      assert.equal(f.state().tasks[0].revisions[1].resultSource, "coordinator-replacement");
      assert.equal(f.state().tasks[0].revisions[1].result, fs.readFileSync(replacement, "utf8"));
    } finally { f.clean(); }
  });

  test("explicit reviewed report replacement survives finish without weakening completion proof", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]); const w = f.state().workers[0];
      const file = path.join(f.dir, "replacement"); fs.writeFileSync(file, "task: a\nchecks: reviewed manually\nlimitations: original report lost\n");
      const args = ["run", "accept", w.pane, "--evidence", "verified artifact", "--result-file", file];
      assert.match(f.execute(args).output, /NOT_COMPLETE/);
      f.complete(w); fs.unlinkSync(`${w.receipt}.inbox`);
      f.ok(args); assert.equal(f.state().tasks[0].resultSource, "coordinator-replacement");
      f.ok(["run", "close", w.pane]); f.ok(["run", "finish"]);
      const history = f.ok(["run", "history", "--task", "a"]);
      assert.match(history, /coordinator-replacement/); assert.match(history, /original report lost/);
    } finally { f.clean(); }
  });

  test("reused tab cosmetics validate the new session, not the old generation", () => {
    const f = fixture();
    try {
      f.queue("a", "shared"); f.ok(["run", "next"]);
      const r = f.state(), w = r.workers[0]; w.session = "original"; f.write(r);
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      a.agent_session = { value: "original" }; fs.writeFileSync(file, JSON.stringify(a));
      f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      fs.writeFileSync(path.join(f.dir, "session-rotate"), ""); f.queue("b", "shared");
      assert.doesNotMatch(f.ok(["run", "next"]), /labelError|uncertain/);
      assert.notEqual(f.state().workers[0].session, "original");
      assert.equal(JSON.parse(fs.readFileSync(file)).label, "b · codex");
    } finally { f.clean(); }
  });

  test("slow tab cosmetics see an already published task and time out promptly", async () => {
    const f = fixture(); let launch;
    try {
      f.queue("a", "shared"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      f.queue("b", "shared"); fs.writeFileSync(path.join(f.dir, "rename-delay"), "");
      launch = f.asyncRun(["run", "next"]);
      const deadline = Date.now() + 10000;
      while (!f.calls().some((c) => c.action === "rename") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert(f.calls().some((c) => c.action === "rename"));
      assert.equal(f.state().tasks[1].state, "running");
      const at = Date.now(), result = await launch;
      assert.equal(result.status, 0, result.output); assert.match(result.output, /labelError/);
      assert(Date.now() - at < 2000, "cosmetic timeout cannot hold publication hostage");
    } finally { if (launch) await launch; f.clean(); }
  });

  test("parked identity drift defers its worktree without aborting prior selections", () => {
    const f = fixture();
    try {
      f.queue("old"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      const r = f.state(); r.workers[0].session = "original"; f.write(r);
      f.queue("fresh"); f.queue("reuse", "old");
      const result = f.ok(["run", "next"]);
      assert.match(result, /worktree busy/);
      assert(result.includes(w.pane)); assert.match(result, /herdr-axi run move/);
      assert.match(f.ok(["run", "status"]), /parkedAttention/);
      assert.equal(f.state().tasks[1].state, "running");
      assert.equal(f.state().tasks[2].state, "queued");
      assert.equal(fs.readdirSync(path.join(f.env.HERDR_AXI_STATE_HOME, "writers")).length, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 2);
    } finally { f.clean(); }
  });
}
