import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fixture, cli, owner } from "./support/run-fixture.mjs";

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
      for (const w of started.workers) assert(!fs.existsSync(`${w.receipt}.monitor-owner`), "finished runtime removes the monitor owner identity");
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
