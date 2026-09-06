import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runWake } from "../src/run-wake.mjs";

test("run wake ignores telemetry and coalesces persisted inbox events, including events before wait", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-wake-"));
  fs.mkdirSync(path.join(dir, "receipts"));
  const wake = runWake(dir);
  try {
    let resolved = false;
    const waiting = wake.wait(1000).then(() => { resolved = true; });
    for (const file of ["context.json", "watch.json", "run.lock", "run.json.tmp"]) fs.writeFileSync(path.join(dir, file), "{}");
    await delay(60); assert.equal(resolved, false, "self-written telemetry must not wake");
    fs.writeFileSync(path.join(dir, "receipts", "worker.event.inbox"), "{}");
    await delay(100); assert.equal(resolved, true, "durable result must wake before fallback");
    await waiting;
    fs.writeFileSync(path.join(dir, "run.json"), "{}");
    await delay(100);
    const started = Date.now(); await wake.wait(1000);
    assert(Date.now() - started < 200, "event between status and wait is retained");
    const quiet = Date.now(); await wake.wait(80);
    assert(Date.now() - quiet >= 65, "consumed event must not wake repeatedly");
  } finally { wake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unavailable filesystem notifications retain timer reconciliation and release pending waits on close", async () => {
  const wake = runWake(`/missing-axi-watch-${process.pid}`);
  try {
    const started = Date.now(); await wake.wait(60);
    assert(Date.now() - started >= 45);
    const pending = wake.wait(10000); wake.close(); await pending;
  } finally { wake.close(); }
});
