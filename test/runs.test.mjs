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
  const save = (a) => {
    const file = path.join(dir, `${a.pane_id}.agent`), temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(a)); fs.renameSync(temp, file);
  };
  const find = (id) => [owner, ...all()].find((a) => a.pane_id === id || a.name === id);
  const missing = (kind) => { console.error(JSON.stringify({ error: { code: `${kind}_not_found`, message: "not found" } })); process.exit(1); };
  if (group === "agent") {
    if (action === "list") emit({ agents: [owner, ...all().filter((a) => a.agent)] });
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
    } else if (action === "read") console.log(fs.existsSync(path.join(dir, "context-footer")) ? fs.readFileSync(path.join(dir, "context-footer"), "utf8") : "Worker result");
    else if (action === "wait") emit({ agent: find(args[0]) ?? missing("agent") });
    else if (action === "send-keys") { const a = find(args[0]); a.agent_status = "idle"; save(a); emit({ sent: true }); }
    else throw Error(`unexpected agent ${action}`);
  } else if (group === "tab") {
    if (action === "create") {
      const id = randomUUID().slice(0, 8);
      const a = { ...owner, pane_id: `wTEST:p${id}`, tab_id: `wTEST:t${id}`, terminal_id: id, name: "", label: args[args.indexOf("--label") + 1], agent: "", agent_status: "idle", cwd: args[args.indexOf("--cwd") + 1] };
      save(a); emit({ tab: { tab_id: a.tab_id }, root_pane: { pane_id: a.pane_id } });
    } else if (action === "get") {
      const a = [owner, ...all()].find((a) => a.tab_id === args[0]) ?? missing("tab");
      emit({ tab: { tab_id: a.tab_id, workspace_id: a.workspace_id, pane_count: 2 } });
    } else if (action === "rename") {
      assert.notEqual(args[0], owner.tab_id);
      if (fs.existsSync(path.join(dir, "rename-delay"))) await new Promise((r) => setTimeout(r, 5000));
      if (fs.existsSync(path.join(dir, "rename-fail"))) { console.error("rename unavailable"); process.exit(1); }
      const a = all().find((a) => a.tab_id === args[0]) ?? missing("tab");
      a.label = args.slice(1).join(" "); save(a); emit({ renamed: true });
    } else if (action === "close") {
      assert.notEqual(args[0], owner.tab_id);
      for (const a of all().filter((a) => a.tab_id === args[0])) fs.unlinkSync(path.join(dir, `${a.pane_id}.agent`));
      emit({ closed: true });
    } else throw Error(`unexpected tab ${action}`);
  } else if (action === "current") {
    assert(args.includes("--current")); emit({ pane: owner });
  } else if (action === "split") {
    const a = find(args[args.indexOf("--pane") + 1]);
    emit({ pane: { pane_id: a.pane_id + "MONITOR" } });
  } else if (action === "get") {
    const a = find(args[0].replace(/MONITOR$/, "")) ?? missing("pane");
    emit({ pane: { pane_id: args[0], tab_id: a.tab_id } });
  } else if (["run", "wait-output"].includes(action)) emit({ ok: true });
  else throw Error(`unexpected pane ${action}`);
} else {
  function fixture() {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "herdr-axi-run-test-"));
    const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
    for (const [name, target] of [["herdr", self], ["node", process.execPath], ["jq", "/opt/homebrew/bin/jq"], ["rg", "/opt/homebrew/bin/rg"]]) fs.symlinkSync(target, path.join(bin, name));
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HERDR_BIN: self, HERDR_ENV: "1", HERDR_PANE_ID: owner.pane_id, HERDR_TAB_ID: owner.tab_id, HERDR_AXI_RUN: path.join(dir, "run"), HERDR_AXI_STATE_HOME: path.join(dir, "state"), AXI_RUN_TEST: dir };
    const execute = (args, extra = {}) => {
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
    return { dir, env, execute, ok, asyncRun, state, write, calls, queue, complete, initialized, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  test("init exposes worker choices and queue syntax; config is compact with explicit full detail", () => {
    const f = fixture();
    try {
      assert.match(f.initialized, /roles\[2\]/);
      assert.match(f.initialized, /implementer,copilot,gpt-5.6-sol,high,write/);
      assert.match(f.initialized, /verifier,claude,opus,high,read/);
      assert.match(f.initialized, /--prompt-file/);
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
      for (let i = 0; i < 10; i++) r.config.roles[`reviewer${i}`] = { ...r.config.roles.verifier, model: `model-${i}` };
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
      assert.equal(f.state().tasks[0].model, "model-9");
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
      const w = f.state().workers[0];
      assert.match(result, new RegExp(`herdr-axi read ${w.pane} --raw`));
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, `${w.pane}.agent`))).label, "a · codex");
      assert.equal(f.calls().filter((c) => ["prompt", "send-keys"].includes(c.action)).length, 0);
      assert.match(f.ok(["read", w.pane]), /Worker result/);
      assert.equal(f.execute(["run", "recover", "a"]).status, 1);
      f.ok(["dispatch", w.pane, "--keys", "enter"]);
      assert.match(f.ok(["run", "recover", "a"]), /running/);
      assert.equal(f.calls().filter((c) => c.action === "create").length, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
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
      assert(!f.state().finishedAt, "failed release must leave finish retryable");
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
      assert(result.includes(w.pane)); assert.match(result, /herdr-axi read/);
      assert.match(f.ok(["run", "status"]), /parkedAttention/);
      assert.equal(f.state().tasks[1].state, "running");
      assert.equal(f.state().tasks[2].state, "queued");
      assert.equal(fs.readdirSync(path.join(f.env.HERDR_AXI_STATE_HOME, "writers")).length, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 2);
    } finally { f.clean(); }
  });
}
