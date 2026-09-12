import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fixture } from "./support/run-fixture.mjs";

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

  for (const legacy of [false, true]) test(`startup dialogs stay inspectable; recover submits once in the same owned pane${legacy ? " with legacy registry" : ""}`, () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "startup-blocked"), "");
      f.queue("a"); const result = f.ok(["run", "next"]);
      assert.match(result, /blocked/); assert.match(result, /submitted: false/);
      assert.match(result, /startupOutput: Worker result/);
      const w = f.state().workers[0];
      if (legacy) {
        const registry = path.join(path.dirname(w.receipt), w.name + ".json"), value = JSON.parse(fs.readFileSync(registry));
        delete value.native_identity; fs.writeFileSync(registry, JSON.stringify(value));
      }
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

  for (const followup of [false, true]) test(`definite pre-submit rejection recovers ${followup ? "followup" : "startup"} in the existing pane and monitor`, () => {
    const f = fixture();
    try {
      f.queue("first", "shared");
      if (followup) {
        f.ok(["run", "next"]); const w = f.state().workers[0]; f.complete(w);
        f.ok(["run", "accept", w.pane, "--evidence", "First result verified"]);
        f.queue("second", "shared");
      }
      fs.writeFileSync(path.join(f.dir, "prompt-rejected"), "");
      const rejected = f.ok(["run", "next"]), w = f.state().workers[0], task = f.state().tasks.at(-1);
      assert.match(rejected, /submitted: false/); assert.match(rejected, /PROMPT_REJECTED/);
      assert.match(rejected, /run recover/); assert.doesNotMatch(rejected, /Monitor startup unconfirmed|run cancel/);
      assert.equal(w.stage, "rejected");
      const attempts = f.calls().filter((c) => c.action === "prompt").length;
      assert(!f.calls().some((c) => c.action === "send-keys"), "no automatic trust approval");
      assert.match(f.execute(["run", "recover", task.id]).output, /STARTUP_NOT_READY/);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, attempts);
      f.ok(["dispatch", w.pane, "--keys", "enter"]);
      fs.unlinkSync(path.join(f.dir, "prompt-rejected"));
      fs.writeFileSync(path.join(f.dir, "session-rotate"), "");
      const inbox = f.ok(["run", "inbox"]); assert.match(inbox, /not_submitted/); assert.match(inbox, /run recover/);
      assert.match(f.ok(["run", "recover", task.id]), /running/);
      const recovered = f.state().workers[0];
      assert.equal(recovered.pane, w.pane); assert.equal(recovered.monitor, w.monitor);
      assert.notEqual(recovered.generation, w.generation); assert(recovered.session);
      assert.equal(f.calls().filter((c) => c.action === "create").length, 1);
      assert.equal(f.calls().filter((c) => c.action === "split").length, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, attempts + 1);
      assert.equal(f.execute(["run", "recover", task.id]).status, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, attempts + 1);
    } finally { f.clean(); }
  });

  test("rejected followup lost publication persists its verified generation before retry rearm", () => {
    const f = fixture();
    try {
      f.queue("first", "shared"); f.ok(["run", "next"]);
      const original = f.state().workers[0]; f.complete(original);
      f.ok(["run", "accept", original.pane, "--evidence", "Initial task verified"]);
      f.queue("second", "shared"); fs.writeFileSync(path.join(f.dir, "prompt-rejected"), "");
      const code = `import fs from 'node:fs'; import {runCommand} from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const rename=fs.renameSync; fs.renameSync=(from,to)=>{
          if(String(to).endsWith('/run.json') && JSON.parse(fs.readFileSync(from)).tasks.some(t=>t.state==='uncertain'))
            throw Object.assign(Error('injected rejected publication failure'),{code:'EIO'});
          return rename(from,to);
        }; console.log(JSON.stringify(await runCommand('next',{_:[]})));`;
      const launched = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: f.env, encoding: "utf8", timeout: 20000 });
      assert.equal(launched.status, 0, launched.stderr); assert.match(launched.stdout, /record_pending/);
      const registry = path.join(path.dirname(original.receipt), original.name + ".json");
      const rejected = JSON.parse(fs.readFileSync(registry));
      assert.equal(rejected.stage, "rejected"); assert.equal(rejected.previous_generation, original.generation);
      assert.equal(f.state().workers[0].generation, original.generation);
      f.ok(["dispatch", original.pane, "--keys", "enter"]); fs.unlinkSync(path.join(f.dir, "prompt-rejected"));
      fs.writeFileSync(path.join(f.dir, "session-rotate"), "");
      assert.match(f.ok(["run", "recover", "second"]), /running/);
      assert.equal(f.state().tasks.at(-1).state, "running");
      assert.equal(f.state().workers[0].previousGeneration, rejected.generation);
      assert(f.state().workers[0].session);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 3);
      assert.equal(f.calls().filter((c) => c.action === "split").length, 1);
    } finally { f.clean(); }
  });

  test("ambiguous acknowledgement after rejected retry never authorizes another prompt", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "prompt-rejected"), "");
      f.queue("task"); f.ok(["run", "next"]); const w = f.state().workers[0];
      f.ok(["dispatch", w.pane, "--keys", "enter"]); fs.unlinkSync(path.join(f.dir, "prompt-rejected"));
      fs.writeFileSync(path.join(f.dir, "prompt-uncertain"), "");
      const retry = f.ok(["run", "recover", "task"]); assert.match(retry, /uncertain/); assert.doesNotMatch(retry, /submitted: false/);
      assert.equal(f.state().workers[0].stage, "submitting");
      const attempts = f.calls().filter((c) => c.action === "prompt").length;
      f.ok(["run", "recover", "task"]);
      assert.equal(f.state().tasks[0].state, "running");
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, attempts);
    } finally { f.clean(); }
  });

  for (const field of ["terminal", "session"]) test(`uncertain recovery cannot adopt replacement ${field} or authorize its cancellation`, () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "session-rotate"), "");
      fs.writeFileSync(path.join(f.dir, "prompt-uncertain"), "");
      f.queue("identity"); f.ok(["run", "next"]);
      const before = f.state(), w = before.workers[0];
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      if (field === "terminal") a.terminal_id = "replacement-terminal";
      else a.agent_session.value = "replacement-session";
      fs.writeFileSync(file, JSON.stringify(a));
      assert.match(f.ok(["run", "status"]), /lost/);
      for (const args of [["run", "recover", "identity"], ["run", "cancel", "identity", "--evidence", "Authorized original task only"]]) {
        const failed = f.execute(args);
        assert.equal(failed.status, 1, failed.output); assert.match(failed.output, /WORKER_CHANGED/);
      }
      assert.deepEqual(f.state().workers, before.workers);
      assert.equal(f.state().tasks[0].state, "uncertain");
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
      assert(!f.calls().some((c) => c.action === "close"));
    } finally { f.clean(); }
  });

  for (const followup of [false, true]) test(`durable native identity fences recovery after ${followup ? "followup" : "initial"} publication failure`, () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "session-rotate"), "");
      f.queue("identity");
      if (followup) {
        f.ok(["run", "next"]); const w = f.state().workers[0]; f.complete(w);
        f.ok(["run", "accept", w.pane, "--evidence", "Original result reviewed"]);
        f.queue("next-task", "identity");
      }
      const code = `import fs from 'node:fs'; import {runCommand} from ${JSON.stringify(new URL("../src/runs.mjs", import.meta.url).href)};
        const rename=fs.renameSync; fs.renameSync=(from,to)=>{
          if(String(to).endsWith('/run.json') && JSON.parse(fs.readFileSync(from)).tasks.some(t=>t.state==='running'))
            throw Object.assign(Error('injected publication failure'),{code:'EIO'});
          return rename(from,to);
        }; console.log(JSON.stringify(await runCommand('next',{_:[]})));`;
      const launched = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: f.env, encoding: "utf8", timeout: 20000 });
      assert.equal(launched.status, 0, launched.stderr); assert.match(launched.stdout, /record_pending/);
      const r = f.state(), t = r.tasks.at(-1), registryFile = path.join(f.env.HERDR_AXI_RUN, "receipts", r.workspace, t.name + ".json");
      const registry = JSON.parse(fs.readFileSync(registryFile));
      assert(registry.native_identity.terminal); assert(registry.native_identity.session);
      if (followup) assert.equal(registry.previous_generation, r.workers[0].generation);
      assert.doesNotMatch(f.ok(["run", "status"]), /ASSIGNMENT_NOT_SUBMITTED/, "durably rearmed delivery is not an old-assignment preflight failure");
      const native = path.join(f.dir, registry.agent_pane + ".agent"), original = JSON.parse(fs.readFileSync(native));
      for (const field of ["terminal", "session"]) {
        const replacement = structuredClone(original);
        if (field === "terminal") replacement.terminal_id = "replacement-terminal";
        else replacement.agent_session.value = "replacement-session";
        fs.writeFileSync(native, JSON.stringify(replacement));
        for (const args of [["run", "recover", t.id], ["run", "cancel", t.id, "--evidence", "Original task only"]]) {
          const refused = f.execute(args); assert.equal(refused.status, 1, refused.output); assert.match(refused.output, /WORKER_CHANGED/);
        }
        assert(!f.calls().some((c) => c.action === "close"));
      }
      fs.writeFileSync(native, JSON.stringify(original));
      const prompts = f.calls().filter((c) => c.action === "prompt").length;
      f.ok(["run", "recover", t.id]);
      assert.equal(f.state().tasks.at(-1).state, "running");
      assert.equal(f.state().workers[0].session, original.agent_session.value);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, prompts, "recovery never resends");
    } finally { f.clean(); }
  });

  test("missing native identity never authorizes control of a live registry-only worker", () => {
    const f = fixture();
    try {
      f.queue("uncaptured"); f.ok(["run", "next"]);
      const r = f.state(), w = r.workers[0]; r.workers = []; r.tasks[0].state = "uncertain"; f.write(r);
      const file = path.join(path.dirname(w.receipt), w.name + ".json"), registry = JSON.parse(fs.readFileSync(file));
      delete registry.native_identity; fs.writeFileSync(file, JSON.stringify(registry));
      for (const args of [["run", "recover", "uncaptured"], ["run", "cancel", "uncaptured", "--evidence", "Original task only"]]) {
        const refused = f.execute(args); assert.equal(refused.status, 1, refused.output); assert.match(refused.output, /WORKER_CHANGED/);
      }
      assert(!f.calls().some((c) => c.action === "close"));
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

  for (const reuse of [false, true]) for (const failure of ["task-file", "monitor-missing"]) test(`assignment-generation fence retains the old report after ${reuse ? "reuse" : "revision"} fails before rearm: ${failure}`, () => {
    const f = fixture();
    try {
      f.queue("original", "shared"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      const id = reuse ? "replacement" : "original";
      if (reuse) {
        f.ok(["run", "accept", w.pane, "--evidence", "Original report independently checked"]);
        f.queue(id, "shared");
      }
      const file = path.join(f.env.HERDR_AXI_RUN, `task-${id}.txt`);
      if (failure === "task-file") { fs.rmSync(file, { force: true }); fs.mkdirSync(file); }
      else fs.unlinkSync(path.join(f.dir, `${w.monitor}.monitor`));
      const failed = f.ok(reuse ? ["run", "next"] : ["run", "revise", w.pane, "--prompt", "NEW assignment, never delivered"]);
      assert.match(failed, /uncertain/);
      if (failure === "monitor-missing") assert.match(failed, /MONITOR_SUPERVISION_LOST/);
      assert.match(failed, /submitted: false/); assert.doesNotMatch(failed, /herdr-axi watch/);
      assert.equal(f.state().tasks.at(-1).assignmentAfter, w.generation);
      assert.equal(f.state().workers[0].generation, w.generation);
      if (failure === "task-file") fs.rmdirSync(file);
      for (const args of [["run", "recover", id], ["run", "accept", w.pane, "--evidence", "Old report cannot prove new work"]]) {
        const rejected = f.execute(args); assert.equal(rejected.status, 1, rejected.output); assert.match(rejected.output, /ASSIGNMENT_NOT_SUBMITTED/); assert.match(rejected.output, /run cancel/);
      }
      for (const args of [["run", "status"], ["run", "inbox"], ["watch", "--task", id, "--timeout-ms", "100"]]) {
        const status = f.ok(args); assert.match(status, /ASSIGNMENT_NOT_SUBMITTED/); assert.doesNotMatch(status, /,review|checks passed/); assert.match(status, /run cancel/);
      }
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
      assert.equal(JSON.parse(fs.readFileSync(`${w.receipt}.inbox`)).summary, "checks passed");
      assert.equal(reuse ? f.state().tasks[0].result : f.state().tasks[0].revisions[0].result, "checks passed");
      f.ok(["run", "cancel", id, "--evidence", "Unsubmitted new assignment; preserved original result reviewed; authorized stop"]);
      assert.equal(f.state().tasks.at(-1).state, "cancelled");
      assert.equal(f.calls().filter((c) => c.action === "close").length, 1, "explicit cancellation closes the whole owned tab");
    } finally { f.clean(); }
  });

  test("successful recovery stops labelling a running task with its old delivery error", () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.dir, "prompt-uncertain"), "");
      f.queue("stale"); f.ok(["run", "next"]);
      assert.equal(f.state().tasks[0].errorCode, "PROMPT_DELIVERY_UNVERIFIED");
      fs.unlinkSync(path.join(f.dir, "prompt-uncertain"));
      const attempts = f.calls().filter((c) => c.action === "prompt").length;
      assert.match(f.ok(["run", "recover", "stale"]), /recovered/);
      const t = f.state().tasks[0];
      assert.equal(t.state, "running"); assert.equal(t.errorCode, undefined); assert.equal(t.error, undefined);
      assert.doesNotMatch(f.ok(["run", "status"]), /PROMPT_DELIVERY_UNVERIFIED/);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, attempts, "recovery never resends the prompt");
    } finally { f.clean(); }
  });
