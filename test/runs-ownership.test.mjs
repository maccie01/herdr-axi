import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fixture, exhaustedWorker, replacementOwner, owner } from "./support/run-fixture.mjs";

  test("ordinary close fences a session replaced after the coordinator fleet snapshot", () => {
    const f = fixture();
    try {
      f.queue("close-race"); f.ok(["run", "next"]);
      const worker = f.state().workers[0];
      f.complete(worker); f.ok(["run", "accept", worker.pane, "--evidence", "Verified completed fixture"]);
      fs.writeFileSync(path.join(f.dir, "replace-after-list"), worker.pane);
      const result = f.execute(["run", "close", worker.pane]);
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /identity changed/i);
      assert(!f.calls().some((call) => call.group === "tab" && call.action === "close"));
      assert(!f.state().workers[0].closed);
      const live = JSON.parse(fs.readFileSync(path.join(f.dir, `${worker.pane}.agent`)));
      assert.equal(live.agent_session.value, "replacement-session");
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

  test("unknown/lost never releases capacity; stale proof cannot be accepted; owner tab cannot close", () => {
    const f = fixture();
    try {
      const r = f.state();
      const w = { pane: "wTEST:pWORKER", tab: "wTEST:tWORKER", workspace: "wTEST", terminal: "worker", session: "worker-session", kind: "codex", cwd: f.dir, name: "worker", receipt: path.join(f.dir, "receipt"), generation: "new" };
      fs.writeFileSync(path.join(f.dir, `${w.pane}.agent`), JSON.stringify({ ...owner, name: w.name, pane_id: w.pane, tab_id: w.tab, terminal_id: w.terminal, agent_session: { value: w.session }, agent_status: "unknown" }));
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
