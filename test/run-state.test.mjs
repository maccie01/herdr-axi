import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { changeRun, PHASES, loadRun, takeRunWarnings, controlActive, processStart, taskFor } from "../src/run-state.mjs";
import { writerLease } from "../src/project.mjs";

test("pane lookup prefers active work, explicit task IDs preserve historical selection", () => {
  const active = { id: "earlier", pane: "wTEST:p1", name: "worker", state: "running" };
  const archived = { id: "later", pane: active.pane, name: active.name, state: "accepted" };
  const run = { tasks: [active, archived] };
  assert.equal(taskFor(run, active.pane), active);
  assert.equal(taskFor(run, "missing-pane", "worker"), active);
  assert.equal(taskFor(run, "later"), archived);
  assert.equal(taskFor(run, "absent"), undefined);
});

test("process identity fencing preserves live/unknown controls and tolerates a disappearing marker", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-control-")), file = path.join(dir, "control");
  try {
    assert.equal(controlActive(file, process.pid), false);
    const started = processStart(process.pid); assert(started, "process inspection required");
    for (const payload of [JSON.stringify({ pid: process.pid, started }), "legacy action", "null", JSON.stringify({pid:process.pid,started:"invalid"})]) {
      fs.writeFileSync(file, payload); assert.equal(controlActive(file, process.pid), true);
    }
    fs.writeFileSync(file, JSON.stringify({pid:process.pid,started:"Mon Jan 1 00:00:00 2001"}));
    assert.equal(controlActive(file, process.pid), false);
    const read = fs.readFileSync;
    try {
      fs.readFileSync = (target, ...args) => { if (target === file) fs.unlinkSync(file); return read(target, ...args); };
      assert.equal(controlActive(file, process.pid), false, "marker vanished after lstat");
    } finally { fs.readFileSync = read; }
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = dir;
      assert.equal(processStart(process.pid), null, "ps unavailable");
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: null }));
      assert.equal(controlActive(file, process.pid), true, "live identity remains fail-closed without ps");
      const kill = process.kill;
      try {
        process.kill = () => { throw Object.assign(Error("process absent"), { code: "ESRCH" }); };
        assert.equal(controlActive(file, process.pid), false, "dead process marker remains reclaimable without ps");
      } finally { process.kill = kill; }
    } finally { process.env.PATH = oldPath; }
    fs.writeFileSync(file, "legacy action");
    fs.unlinkSync(file); fs.symlinkSync(path.join(dir, "missing"), file);
    assert.equal(controlActive(file, process.pid), true);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test("lease rollback, crash reclaim and release only after durable publication", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-transaction-"));
  const previous = { HERDR_AXI_RUN: process.env.HERDR_AXI_RUN, HERDR_AXI_STATE_HOME: process.env.HERDR_AXI_STATE_HOME };
  process.env.HERDR_AXI_RUN = dir; process.env.HERDR_AXI_STATE_HOME = path.join(dir, "state");
  const task = { id: "a", state: "queued", cwd: dir, access: "write" };
  const run = { schema: 1, id: "test", owner: { pane: "w:p1", tab: "w:t1" }, workspace: "w", phase: "explore", limits: PHASES, tasks: [task], workers: [] };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  try {
    assert.throws(() => changeRun((r, { rollback }) => {
      assert(writerLease(r, r.tasks[0]));
      rollback.push(() => writerLease(r, r.tasks[0], true));
      r.tasks[0].state = "starting";
      throw Error("later iteration failed");
    }), /later iteration failed/);
    assert.equal(loadRun().tasks[0].state, "queued");
    assert.equal(fs.readdirSync(path.join(dir, "state/writers")).length, 0);
    assert(writerLease(run, task)); // Simulated crash before run.json publication.
    assert(writerLease(run, task), "only the same queued task can reclaim");
    assert(!writerLease({ ...run, id: "foreign" }, task));
    assert(!writerLease(run, { ...task, state: "starting" }));
    assert.throws(() => changeRun((r, { afterCommit }) => {
      afterCommit.push(() => writerLease(r, r.tasks[0], true));
      fs.rmSync(path.join(dir, "run.lock")); // Cleanup must not mask this error.
      throw Error("original failure");
    }), /original failure/);
    assert.equal(fs.readdirSync(path.join(dir, "state/writers")).length, 1);
    changeRun((r, { afterCommit }) => {
      r.tasks[0].state = "accepted";
      afterCommit.push(() => {
        assert.equal(loadRun().tasks[0].state, "accepted");
        writerLease(r, r.tasks[0], true);
      });
    });
    assert.equal(fs.readdirSync(path.join(dir, "state/writers")).length, 0);
    const result = changeRun((r, { afterCommit }) => {
      r.tasks[0].evidence = "durable";
      afterCommit.push(() => { throw Object.assign(Error("release unavailable"), { code: "EIO" }); });
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true }, "postcommit failure must not report a failed transaction");
    assert.equal(loadRun().tasks[0].evidence, "durable");
    assert.deepEqual(takeRunWarnings(), [{ code: "EIO", error: "release unavailable" }]);
    assert.deepEqual(takeRunWarnings(), []);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
