import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { changeRun, PHASES, loadRun, takeRunWarnings, controlActive, processStart, taskFor } from "../src/run-state.mjs";
import { writerLease } from "../src/project.mjs";
import { finishRun } from "../src/archive.mjs";

test("invalid selected run explains restoration, not an identical failing status retry", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-selection-"));
  const previous = process.env.HERDR_AXI_RUN;
  try {
    for (const selected of [path.join(dir, "missing"), dir]) {
      process.env.HERDR_AXI_RUN = selected;
      assert.throws(() => loadRun(), (e) => e.code === "RUN_INVALID" && /Restore the existing/.test(e.message) && !e.suggestions.some((s) => /run status|run init/.test(s)));
    }
    fs.writeFileSync(path.join(dir, "run.json"), "null");
    assert.throws(() => loadRun(), { code: "RUN_INVALID" });
  } finally {
    if (previous === undefined) delete process.env.HERDR_AXI_RUN; else process.env.HERDR_AXI_RUN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only lock cleanup errors surface without masking the operation error", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-readonly-lock-"));
  const previous = process.env.HERDR_AXI_RUN; process.env.HERDR_AXI_RUN = dir;
  const run = { schema: 1, owner: { pane: "w:p1", tab: "w:t1" }, workspace: "w", phase: "explore", limits: PHASES, tasks: [], workers: [] };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  const rm = fs.rmSync;
  try {
    fs.rmSync = (file, ...args) => { if (String(file).endsWith("/run.lock")) throw Object.assign(Error("lock cleanup failed"), { code: "EIO" }); return rm(file, ...args); };
    assert.throws(() => changeRun(() => "ok", { readOnly: true }), { code: "EIO" });
    rm(path.join(dir, "run.lock"));
    assert.throws(() => changeRun(() => { throw Error("original failure"); }, { readOnly: true }), /original failure/);
  } finally {
    fs.rmSync = rm;
    if (previous === undefined) delete process.env.HERDR_AXI_RUN; else process.env.HERDR_AXI_RUN = previous;
    rm(dir, { recursive: true, force: true });
  }
});

test("finish retains leases on archive/publication failure and repairs postcommit failures", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-finish-lease-"));
  const previous = { HERDR_AXI_RUN: process.env.HERDR_AXI_RUN, HERDR_AXI_STATE_HOME: process.env.HERDR_AXI_STATE_HOME };
  process.env.HERDR_AXI_RUN = dir; process.env.HERDR_AXI_STATE_HOME = path.join(dir, "state");
  const task = { id: "a", cwd: dir, state: "accepted" };
  const run = { schema: 1, id: "finish-test", owner: { pane: "w:p1", tab: "w:t1" }, workspace: "w", phase: "explore", limits: PHASES, tasks: [task], workers: [] };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  const rename = fs.renameSync;
  try {
    assert(writerLease(run, task));
    for (const suffix of ["detail.json.gz", "run.json"]) {
      fs.renameSync = (from, to) => { if (String(to).endsWith('/' + suffix)) throw Object.assign(Error("disk unavailable"), { code: "ENOSPC" }); return rename(from, to); };
      assert.throws(finishRun, { code: "ENOSPC" });
      assert(!loadRun().finishedAt);
      assert(!writerLease({ ...run, id: "other" }, task), "other run remains excluded");
    }
    fs.renameSync = rename;
    finishRun(); assert(loadRun().finishedAt);
    assert(writerLease({ ...run, id: "other" }, task), "release only after durable archive publication");
  } finally {
    fs.renameSync = rename;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
