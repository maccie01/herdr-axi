import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runWake } from "../src/run-wake.mjs";

class WakeSocket extends EventEmitter {
  writes = [];
  setEncoding() {}
  setNoDelay() {}
  write(value) { this.writes.push(value); }
  destroy() { queueMicrotask(() => this.emit("close")); }
}

class FakeWatcher extends EventEmitter {
  closed = false;
  close() { this.closed = true; }
}

test("run wake ignores telemetry and coalesces persisted inbox events, including events before wait", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-wake-"));
  fs.mkdirSync(path.join(dir, "receipts"));
  let watcher, notify;
  const wake = runWake(dir, { watch: (_dir, _options, callback) => {
    watcher = new FakeWatcher();
    notify = callback;
    return watcher;
  } });
  try {
    let resolved = false;
    const waiting = wake.wait(1000).then(() => { resolved = true; });
    for (const file of ["context.json", "watch.json", "run.lock", "run.json.tmp"]) notify("change", file);
    await delay(60); assert.equal(resolved, false, "self-written telemetry must not wake");
    notify("rename", "receipts/worker.event.inbox");
    await delay(100); assert.equal(resolved, true, "durable result must wake before fallback");
    await waiting;
    notify("change", "run.json");
    await delay(100);
    const started = Date.now(); await wake.wait(1000);
    assert(Date.now() - started < 200, "event between status and wait is retained");
    const quiet = Date.now(); await wake.wait(80);
    assert(Date.now() - quiet >= 65, "consumed event must not wake repeatedly");
    let proofWoke = false;
    const proof = wake.wait(1000).then(() => { proofWoke = true; });
    notify("change", "receipts/worker.event.proof.testgen.tmp");
    await delay(60); assert.equal(proofWoke, false, "partial proof is not published evidence");
    notify("rename", "receipts/worker.event.proof.testgen");
    await delay(100); assert.equal(proofWoke, true, "published late proof wakes before fallback");
    await proof;
  } finally { wake.close(); assert.equal(watcher.closed, true); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unavailable filesystem notifications retain timer reconciliation and release pending waits on close", async () => {
  const wake = runWake(`/missing-axi-watch-${process.pid}`, { watch: () => { throw Error("unsupported"); } });
  try {
    assert.deepEqual(wake.status().filesystem, { available: false, error: "unsupported" });
    const started = Date.now(); await wake.wait(60);
    assert(Date.now() - started >= 45);
    const pending = wake.wait(10000); wake.close(); await pending;
  } finally { wake.close(); }
});

test("filesystem watcher errors degrade reported transport without losing timer wake", async () => {
  const watcher = new FakeWatcher();
  const wake = runWake("/tmp/fake", { watch: () => watcher });
  try {
    watcher.emit("error", Error("descriptor exhausted"));
    assert.deepEqual(wake.status().filesystem, { available: false, error: "descriptor exhausted" });
    const started = Date.now(); await wake.wait(50);
    assert(Date.now() - started >= 35);
  } finally { wake.close(); }
});

test("Herdr events and reconnect resync enter the same coalescing wake path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-event-wake-"));
  const socket = new WakeSocket();
  const wake = runWake(dir, {
    herdr: { socketPath: "/tmp/fake.sock", subscriptions: [{ type: "pane.closed" }] },
    createConnection: () => { queueMicrotask(() => socket.emit("connect")); return socket; },
    watch: () => new FakeWatcher(),
  });
  try {
    for (let i = 0; i < 20 && !socket.writes.length; i += 1) await delay(1);
    const request = JSON.parse(socket.writes[0]);
    socket.emit("data", `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
    assert.equal((await wake.ready(50)).connected, true);
    assert.equal(wake.status().herdr.connected, true);
    const pending = wake.wait(1000);
    socket.emit("data", `${JSON.stringify({ event: "pane.closed", data: { pane_id: "w1:p1" } })}\n`);
    assert.equal(await pending, "herdr-event");
  } finally { wake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
