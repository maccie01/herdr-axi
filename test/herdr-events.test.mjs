import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createHerdrEventSource, runSubscriptions } from "../src/herdr-events.mjs";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes = [];
  setEncoding() {}
  setNoDelay() {}
  write(value) { this.writes.push(value); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
  }
}

const connectFake = (sockets) => () => {
  const socket = new FakeSocket();
  sockets.push(socket);
  queueMicrotask(() => socket.emit("connect"));
  return socket;
};

async function requestFrom(socket) {
  for (let i = 0; i < 20 && !socket.writes.length; i += 1) await delay(1);
  assert.equal(socket.writes.length, 1);
  return JSON.parse(socket.writes[0]);
}

test("subscription acknowledges before events become wake hints", async () => {
  const sockets = [], signals = [];
  const source = createHerdrEventSource({
    socketPath: "/tmp/fake-herdr.sock",
    subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
    signal: (reason) => signals.push(reason),
    createConnection: connectFake(sockets),
  });
  try {
    const request = await requestFrom(sockets[0]);
    assert.equal(request.method, "events.subscribe");
    assert.deepEqual(request.params.subscriptions, [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }]);
    sockets[0].emit("data", `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
    assert.equal((await source.ready(50)).connected, true);
    assert.deepEqual(signals, [], "initial acknowledgement is a barrier, not a state change");
    const event = JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "blocked" } });
    sockets[0].emit("data", `${event.slice(0, 17)}`);
    sockets[0].emit("data", `${event.slice(17)}\n`);
    assert.deepEqual(signals, ["herdr-event"]);
  } finally { source.close(); }
});

test("reconnect acknowledgement emits resync because events cannot resume", async () => {
  const sockets = [], signals = [];
  const source = createHerdrEventSource({
    socketPath: "/tmp/fake-herdr.sock",
    subscriptions: [{ type: "pane.closed" }],
    signal: (reason) => signals.push(reason),
    createConnection: connectFake(sockets),
    reconnectDelays: [1],
  });
  try {
    const first = await requestFrom(sockets[0]);
    sockets[0].emit("data", `${JSON.stringify({ id: first.id, result: { type: "subscription_started" } })}\n`);
    await source.ready(50);
    sockets[0].destroy();
    for (let i = 0; i < 50 && sockets.length < 2; i += 1) await delay(1);
    const second = await requestFrom(sockets[1]);
    assert.equal(second.id, first.id);
    sockets[1].emit("data", `${JSON.stringify({ id: second.id, result: { type: "subscription_started" } })}\n`);
    await delay(1);
    assert.deepEqual(signals, ["herdr-resync"]);
    assert.equal(source.status().reconnects, 1);
  } finally { source.close(); }
});

test("late initial acknowledgement requests a resync after the bootstrap barrier timed out", async () => {
  const sockets = [], signals = [];
  const source = createHerdrEventSource({
    socketPath: "/tmp/fake-herdr.sock",
    subscriptions: [{ type: "pane.closed" }],
    signal: (reason) => signals.push(reason),
    createConnection: connectFake(sockets),
  });
  try {
    const request = await requestFrom(sockets[0]);
    assert.equal((await source.ready(0)).connected, false);
    sockets[0].emit("data", `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
    await delay(1);
    assert.deepEqual(signals, ["herdr-resync"]);
  } finally { source.close(); }
});

test("subscription rejection degrades permanently without a reconnect loop", async () => {
  const sockets = [];
  const source = createHerdrEventSource({
    socketPath: "/tmp/fake-herdr.sock",
    subscriptions: [{ type: "pane.closed" }],
    signal() {},
    createConnection: connectFake(sockets),
    reconnectDelays: [1],
  });
  try {
    const request = await requestFrom(sockets[0]);
    sockets[0].emit("data", `${JSON.stringify({ id: request.id, error: { code: "unknown_method", message: "unsupported" } })}\n`);
    const status = await source.ready(50);
    assert.equal(status.available, false);
    assert.match(status.lastError, /unknown_method/);
    await delay(5);
    assert.equal(sockets.length, 1);
  } finally { source.close(); }
});

test("malformed and oversized frames are rejected before event delivery", async () => {
  for (const payload of ["not-json\n", `${"x".repeat(1025)}`]) {
    const sockets = [], signals = [];
    const source = createHerdrEventSource({
      socketPath: "/tmp/fake-herdr.sock",
      subscriptions: [{ type: "pane.closed" }],
      signal: (reason) => signals.push(reason),
      createConnection: connectFake(sockets),
      reconnectDelays: [1],
      maxLineBytes: 1024,
    });
    try {
      await requestFrom(sockets[0]);
      sockets[0].emit("data", payload);
      for (let i = 0; i < 50 && sockets.length < 2; i += 1) await delay(1);
      assert.equal(sockets.length, 2);
      assert.match(source.status().lastError, /invalid JSON|configured limit/);
      assert.deepEqual(signals, []);
    } finally { source.close(); }
  }
});

test("run subscriptions are deduplicated and scoped to live owned panes", () => {
  assert.deepEqual(runSubscriptions({ workers: [
    { pane: "w1:p1" }, { pane: "w1:p1" }, { pane: "w1:p2", closed: true }, { pane: "w1:p3" },
  ] }), [
    { type: "pane.agent_status_changed", pane_id: "w1:p1" },
    { type: "pane.agent_status_changed", pane_id: "w1:p3" },
    { type: "pane.agent_detected" }, { type: "pane.exited" }, { type: "pane.closed" }, { type: "tab.closed" },
  ]);
  assert.deepEqual(runSubscriptions({ workers: [] }), [
    { type: "pane.agent_detected" }, { type: "pane.exited" }, { type: "pane.closed" }, { type: "tab.closed" },
  ]);
});
