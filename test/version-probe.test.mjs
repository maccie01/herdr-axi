#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const self = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL("../bin/herdr-axi.mjs", import.meta.url));
const pane = "w1:pPROBE";

// This file doubles as an isolated HERDR_BIN. Its strict routing makes the
// test fail if the adapter invents a command such as `herdr server status`.
if (process.argv[2] === "status" || process.argv[2] === "agent") {
  const [action, sub, ...args] = process.argv.slice(2);
  if (action === "status") {
    assert.equal(sub, "--json");
    if (process.env.AXI_FAKE_STATUS === "exit-1") process.exit(1);
    const clientGeneration = Number(process.env.AXI_FAKE_CLIENT_GEN ?? "1");
    const serverGeneration = Number(process.env.AXI_FAKE_SERVER_GEN ?? "1");
    const serverRunning = process.env.AXI_FAKE_SERVER_RUNNING !== "false";
    const protocolCompatible = process.env.AXI_FAKE_PROTOCOL_COMPATIBLE !== "false";
    const endpointCompatible = process.env.AXI_FAKE_ENDPOINT_COMPATIBLE === undefined
      ? clientGeneration === serverGeneration
      : process.env.AXI_FAKE_ENDPOINT_COMPATIBLE !== "false";
    console.log(JSON.stringify({
      client: {
        version: process.env.AXI_FAKE_CLIENT_VERSION,
        protocol: 22,
        endpoint_protocol_generation: clientGeneration,
      },
      server: {
        status: serverRunning ? "running" : "not_running",
        running: serverRunning,
        version: serverRunning ? process.env.AXI_FAKE_SERVER_VERSION : null,
        protocol: serverRunning ? 22 : null,
        capabilities: serverRunning ? { endpoint_protocol_generation: serverGeneration } : null,
        compatible: serverRunning ? protocolCompatible : null,
        endpoint_compatible: serverRunning ? endpointCompatible : null,
        server_binary_stale: process.env.AXI_FAKE_SERVER_STALE === "true",
      },
      update: {
        restart_needed: !endpointCompatible,
        server_binary_stale: process.env.AXI_FAKE_SERVER_STALE === "true",
      },
    }));
  } else {
    assert.equal(sub, "get");
    console.log(JSON.stringify({ id: "cli:test", result: { agent: {
      pane_id: args[0], tab_id: "w1:tPROBE", workspace_id: "w1", terminal_id: "term-probe",
      agent_session: { value: "sess-probe" }, agent: "codex", agent_status: "idle",
    } } }));
  }
  process.exit(0);
}

process.env.HERDR_BIN = self;
const { herdrVersionProbe, EXPECTED_PROTOCOL_GENERATION } = await import("../src/herdr.mjs");

function withBackendEnv(values, fn) {
  const keys = Object.keys(values);
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); }
  finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const backend = (overrides = {}) => ({
  AXI_FAKE_CLIENT_VERSION: "0.9.0",
  AXI_FAKE_SERVER_VERSION: "0.9.0",
  AXI_FAKE_CLIENT_GEN: "1",
  AXI_FAKE_SERVER_GEN: "1",
  AXI_FAKE_SERVER_RUNNING: "true",
  AXI_FAKE_PROTOCOL_COMPATIBLE: "true",
  AXI_FAKE_ENDPOINT_COMPATIBLE: undefined,
  AXI_FAKE_SERVER_STALE: "false",
  AXI_FAKE_STATUS: "ok",
  ...overrides,
});

test("probe reads the real Herdr 0.9 status shape", () => {
  assert.equal(EXPECTED_PROTOCOL_GENERATION, 1);
  const p = withBackendEnv(backend({
    AXI_FAKE_CLIENT_VERSION: "0.10.2-rc.1+build.7",
    AXI_FAKE_SERVER_VERSION: "0.9.4",
    AXI_FAKE_SERVER_STALE: "true",
  }), herdrVersionProbe);
  assert.deepEqual(p, {
    version: "0.10.2", clientVersion: "0.10.2", serverVersion: "0.9.4",
    major: 0, minor: 10, patch: 2,
    protocol: 22, serverProtocol: 22, protocolCompatible: true,
    protocolGeneration: 1, serverProtocolGeneration: 1, endpointCompatible: true,
    restartNeeded: false, serverBinaryStale: true,
  });
});

test("probe requires 0.9 on both the client and the behavior-owning server", () => {
  for (const overrides of [
    { AXI_FAKE_CLIENT_VERSION: "0.8.7" },
    { AXI_FAKE_SERVER_VERSION: "0.8.7" },
  ]) {
    assert.throws(() => withBackendEnv(backend(overrides), herdrVersionProbe), (error) =>
      error.code === "HERDR_VERSION_UNSUPPORTED" && error.suggestions?.some((s) => s.includes("herdr update")));
  }
});

test("probe rejects an unavailable server and an incompatible private protocol", () => {
  assert.throws(() => withBackendEnv(backend({ AXI_FAKE_SERVER_RUNNING: "false" }), herdrVersionProbe),
    (error) => error.code === "HERDR_UNREACHABLE");
  assert.throws(() => withBackendEnv(backend({ AXI_FAKE_PROTOCOL_COMPATIBLE: "false" }), herdrVersionProbe),
    (error) => error.code === "HERDR_PROTOCOL_INCOMPATIBLE");
  assert.throws(() => withBackendEnv(backend({ AXI_FAKE_STATUS: "exit-1" }), herdrVersionProbe),
    (error) => error.code === "HERDR_UNREACHABLE");
});

function initRun(overrides = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "herdr-axi-probe-init-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const state = path.join(root, "run-state");
  const r = spawnSync(process.execPath, [cli, "run", "init", "--project", project, "--dir", state], {
    encoding: "utf8", timeout: 20_000, cwd: project,
    env: {
      ...process.env, ...backend(overrides), HERDR_BIN: self, HERDR_ENV: "1",
      HERDR_PANE_ID: pane, HERDR_TAB_ID: "w1:tPROBE", HERDR_AXI_RUN: "",
      HERDR_AXI_STATE_HOME: path.join(root, "state"),
    },
  });
  return { r, root, state, output: r.stdout + r.stderr, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("init records client/server compatibility evidence in run.json", () => {
  const { r, state, output, cleanup } = initRun({
    AXI_FAKE_CLIENT_VERSION: "0.9.4", AXI_FAKE_SERVER_VERSION: "0.9.3",
    AXI_FAKE_SERVER_STALE: "true",
  });
  try {
    assert.equal(r.status, 0, output);
    const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
    assert.deepEqual(run.herdr, {
      clientVersion: "0.9.4", serverVersion: "0.9.3", protocol: 22, serverProtocol: 22,
      protocolCompatible: true, endpointProtocolGeneration: 1, serverEndpointProtocolGeneration: 1,
      endpointCompatible: true, restartNeeded: false, serverBinaryStale: true,
    });
    assert.match(output, /prompt behavior is server-owned/);
  } finally { cleanup(); }
});

test("init warns on endpoint mismatch but treats it as UI/SSH compatibility", () => {
  const { r, state, output, cleanup } = initRun({ AXI_FAKE_SERVER_GEN: "2" });
  try {
    assert.equal(r.status, 0, output);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8")).herdr.endpointCompatible, false);
    assert.match(output, /saved SSH\/multi-machine UI compatibility/);
  } finally { cleanup(); }
});

test("init refuses an old server before creating run state", () => {
  const { r, state, output, cleanup } = initRun({ AXI_FAKE_SERVER_VERSION: "0.8.4" });
  try {
    assert.equal(r.status, 1, output);
    assert.match(output, /HERDR_VERSION_UNSUPPORTED/);
    assert.equal(fs.existsSync(path.join(state, "run.json")), false);
  } finally { cleanup(); }
});
