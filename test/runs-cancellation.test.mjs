import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fixture, exhaustedWorker, owner } from "./support/run-fixture.mjs";

test("cancellation checkpoints visible 60 lines when history is unavailable", () => {
  const f = fixture();
  try {
    f.queue("fallback"); f.ok(["run", "next"]);
    const worker = f.state().workers[0];
    fs.writeFileSync(path.join(f.dir, "history-read-fail"), "");
    fs.writeFileSync(path.join(f.dir, `screen-${worker.pane}`), "Saved partial output");
    const before = f.calls().length;
    f.ok(["run", "cancel", "fallback", "--evidence", "Authorized stop; partial work inspected"]);
    const checkpoint = f.state().tasks[0].cancellation;
    assert.equal(checkpoint.output, "Saved partial output");
    assert.deepEqual(checkpoint.capture, { source: "visible", truncated: true });
    const reads = f.calls().slice(before).filter((c) => c.action === "read");
    assert.deepEqual(reads.map((c) => c.args.slice(1)), [
      ["--source", "recent-unwrapped", "--lines", "2000"],
      ["--source", "visible", "--lines", "60"],
    ]);
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
