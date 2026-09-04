import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { changeRun, PHASES, loadRun } from "../src/run-state.mjs";
import { writerLease } from "../src/project.mjs";

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
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
