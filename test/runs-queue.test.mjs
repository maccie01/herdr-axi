import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fixture } from "./support/run-fixture.mjs";

  test("queue-start failure reports durable queued task; invalid legacy models consume no slot or lease", () => {
    const f = fixture();
    try {
      const code = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        import {AxiError} from 'axi-sdk-js';
        import {runCommand} from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const rename = fs.renameSync; let commits=0;
        fs.renameSync = (a,b) => { if (b.endsWith('/run.json') && ++commits === 2) throw new AxiError('next publication failed','RUN_UNCERTAIN',['herdr-axi run recover persisted','herdr-axi run leases']); return rename(a,b); };
        await assert.rejects(runCommand('queue',{_:['persisted'],role:'implementer',cwd:${JSON.stringify(f.state().project)},area:'.',prompt:'bounded task',start:true}), (e) => {
          assert.match(e.message, /already queued; do not queue again/);
          assert.match(e.message, /next publication failed/);
          assert.equal(e.code, 'RUN_UNCERTAIN');
          assert.deepEqual(e.suggestions, ['herdr-axi run recover persisted','herdr-axi run leases']);
          return true;
        });`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); assert.equal(f.state().tasks[0].state, "queued");
      const r = f.state(); r.tasks[0].kind = "claude"; r.tasks[0].model = "haiku"; f.write(r);
      const output = f.ok(["run", "next"]); assert.match(output, /auto-capable/);
      assert(!f.calls().some((c) => c.action === "create")); assert.equal(f.state().tasks[0].state, "queued");
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
      assert.doesNotMatch(compact, /integrationStatus/);
      assert.match(full, /integrationStatus/);
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

  test("compact role preview preserves custom contracts and discloses overflow", () => {
    const f = fixture();
    try {
      const r = f.state();
      r.limits.explore = 2;
      r.config.roles.implementer.subagents = [{ role: "verifier", max: 1, when: "review only" }];
      r.config.roles.unavailable = { kind: "not-installed", access: "write" };
      for (let i = 0; i < 10; i++) r.config.roles[`reviewer${i}`] = { ...r.config.roles.verifier, model: "claude-opus-5" };
      f.write(r);
      const compact = f.ok(["run", "config"]);
      assert.match(compact, /roles\[8\]/);
      assert.match(compact, /moreRoles: 4/);
      assert.match(compact, /unavailableRoles\[1\]\{role,kind\}/);
      assert.match(compact, /unavailable,not-installed/);
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
