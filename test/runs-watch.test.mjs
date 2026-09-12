import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fixture, exhaustedWorker, replacementOwner, owner } from "./support/run-fixture.mjs";

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
      const close = f.execute(["run", "close", w.pane]);
      assert.notEqual(close.status, 0, close.output);
      assert.match(close.output, /close refused.*state=unknown/);
      assert(!f.calls().some((call) => call.group === "tab" && call.action === "close"));
      a.agent_status = "done"; fs.writeFileSync(file, JSON.stringify(a));
      f.ok(["run", "close", w.pane]);
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

  test("one watch delivers quota across the initial-snapshot race; subsequent status reuses the bounded probe", async () => {
    const f = fixture(); let watching;
    try {
      const w = exhaustedWorker(f), file = path.join(f.dir, `${w.pane}.agent`);
      const a = JSON.parse(fs.readFileSync(file));
      const publish = () => { const temp = file + ".tmp"; fs.writeFileSync(temp, JSON.stringify(a)); fs.renameSync(temp, file); };
      a.agent_status = "working"; publish();
      const before = f.calls().filter((c) => c.action === "list").length;
      watching = f.asyncRun(["watch", "--timeout-ms", "8000"]);
      const deadline = Date.now() + 3000;
      while (f.calls().filter((c) => c.action === "list").length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      a.agent_status = "idle"; publish();
      const result = await watching;
      assert.equal(result.status, 0, result.output);
      // The backend logs list before reading rows: quota may reach the first
      // snapshot. Existing attention and a later transition both deliver it.
      assert.match(result.output, /reason: (state-change|attention)/);
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
      assert.match(f.ok(["watch", "--task", "healthy", "--timeout-ms", "300"]), /reason: missing-proof/, "native settlement alone is diagnosed after the full timeout, not accepted");
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

  test("task-scoped watch rejects malformed proof bytes without repeated immediate attention", () => {
    const f = fixture();
    try {
      f.queue("proof"); f.ok(["run", "next"]); const w = f.state().workers[0];
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      a.agent_status = "idle"; fs.writeFileSync(file, JSON.stringify(a));
      const proof = `${w.receipt}.proof.${w.generation}`;
      for (const value of [`${"x".repeat(w.generation.length)}\n`, w.generation, `${w.generation}\r\n`, `${w.generation}\nextra`, "wrong-generation\n"]) {
        fs.writeFileSync(proof, value);
        const start = Date.now(), output = f.ok(["watch", "--task", "proof", "--timeout-ms", "300"]);
        assert(Date.now() - start >= 300, output);
        assert.match(output, /reason: timeout/); assert.match(output, /INVALID_COMPLETION_PROOF/);
        assert.doesNotMatch(output, /reason: attention|run accept/);
      }
      fs.writeFileSync(proof, `${w.generation}\n`);
      const output = f.ok(["watch", "--task", "proof", "--timeout-ms", "300"]);
      assert.match(output, /reason: attention/);
      assert.doesNotMatch(output, /INVALID_COMPLETION_PROOF/);
    } finally { f.clean(); }
  });

  test("task-scoped watch retains context I/O errors without repeatedly waking on an existing failure", () => {
    const f = fixture();
    try {
      f.queue("context"); f.ok(["run", "next"]);
      const source = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        import { runStatus, watchRun } from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const write = fs.writeFileSync;
        fs.writeFileSync = (file, ...args) => { if (String(file).includes('/context.json.')) throw Object.assign(Error('context disk unavailable'), {code: 'EIO'}); return write(file, ...args); };
        assert.equal(runStatus().contextError, 'context disk unavailable');
        for (let i = 0; i < 2; i++) {
          const start = Date.now(), result = await watchRun(300, 'context');
          assert.equal(result.reason, 'timeout'); assert(Date.now() - start >= 300);
          assert.equal(result.contextError, 'context disk unavailable');
        }`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
    } finally { f.clean(); }
  });

  test("task-scoped watch wakes with a new context I/O diagnostic", () => {
    const f = fixture();
    try {
      f.queue("context"); f.ok(["run", "next"]);
      const source = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        import { watchRun } from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const write = fs.writeFileSync, rename = fs.renameSync;
        let probes = 0;
        // Keep the successful first probe uncached; the next real probe fails.
        fs.renameSync = (from, to) => { if (String(to).endsWith('/context.json')) return; return rename(from, to); };
        fs.writeFileSync = (file, ...args) => { if (String(file).includes('/context.json.') && ++probes > 1) throw Error('new context EIO'); return write(file, ...args); };
        const result = await watchRun(300, 'context');
        assert.equal(result.reason, 'state-change'); assert.equal(result.contextError, 'new context EIO');`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: f.env, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
    } finally { f.clean(); }
  });

  test("task-scoped watch reports a settled turn without proof instead of re-arming itself", () => {
    const f = fixture();
    try {
      f.queue("unproven"); f.ok(["run", "next"]); const w = f.state().workers[0];
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      a.agent_status = "idle"; fs.writeFileSync(file, JSON.stringify(a));
      fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "Earlier context".repeat(1000) + "Final answer; completion proof omitted");
      const start = Date.now(), output = f.ok(["watch", "--task", "unproven", "--timeout-ms", "300"]);
      assert(Date.now() - start >= 300, "the full timeout tolerates intermediate settlement");
      assert.match(output, /reason: missing-proof/); assert.match(output, /state: idle/); assert.match(output, /completion proof omitted/);
      assert(output.includes(`herdr-axi read ${w.pane} --raw --lines 60 --chars 8000`));
      assert.doesNotMatch(output, /herdr-axi watch --task unproven|run accept|reason: attention/);
      assert(Buffer.byteLength(output) < 5000);
      assert.equal(f.state().tasks[0].state, "running", "no synthesized proof or acceptance");
      fs.writeFileSync(`${w.receipt}.proof.${w.generation}`, `${w.generation}\n`);
      assert.match(f.ok(["watch", "--task", "unproven", "--timeout-ms", "300"]), /reason: attention/);
    } finally { f.clean(); }
  });
