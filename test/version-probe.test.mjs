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
// Dual role: with arguments this file is the fake herdr on the fixture PATH,
// without them it is the test suite (node --test passes no extra argv).
// Never fall through to the suite on an unknown verb. That is what happened on
// 12.09.2026: `run init` probes `herdr status --json`, the fake did not know
// `status`, re-ran the suite, and each suite opened a new run. 4148 node
// processes in 39 s, machine dead. Unknown verb must exit non-zero, loudly.
if (process.argv.length > 2) {
  const [action, sub, ...args] = process.argv.slice(2);
  if (!["status", "agent", "integration"].includes(action)) {
    console.error(JSON.stringify({ error: { code: "unsupported", message: `fake herdr (${process.argv[1].split("/").pop()}): unhandled command ${process.argv.slice(2).join(" ")}` } }));
    process.exit(2);
  }

  if (action === "integration") {
    assert.equal(sub, "status");
    if (process.env.AXI_FAKE_NO_INTEGRATIONS === "true") console.log("codex: not installed (/fixture)");
    else {
      const kind = process.env.AXI_FAKE_INTEGRATION_KIND ?? "codex";
      console.log(`${kind}: current (v8) (/fixture)`);
    }
  } else if (action === "status") {
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
        capabilities: serverRunning ? {
          endpoint_protocol_generation: serverGeneration,
          live_handoff: true,
          surface_interest: true,
          health_check: true,
        } : null,
        compatible: serverRunning ? protocolCompatible : null,
        endpoint_compatible: serverRunning ? endpointCompatible : null,
        server_binary_stale: process.env.AXI_FAKE_SERVER_STALE === "true",
        socket: process.env.AXI_FAKE_SOCKET ?? "/tmp/herdr-test.sock",
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
const { herdrVersionProbe } = await import("../src/herdr.mjs");

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
  AXI_FAKE_SOCKET: "/tmp/herdr-test.sock",
  ...overrides,
});

test("probe reads the real Herdr 0.9 status shape", () => {
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
    restartNeeded: false, serverBinaryStale: true, socket: "/tmp/herdr-test.sock",
    endpointCapabilities: { liveHandoff: true, surfaceInterest: true, healthCheck: true },
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

function initRun(overrides = {}, config) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "herdr-axi-probe-init-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  if (config) fs.writeFileSync(path.join(project, ".herdr-axi.json"), JSON.stringify(config));
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
      socket: "/tmp/herdr-test.sock",
      endpointCapabilities: { liveHandoff: true, surfaceInterest: true, healthCheck: true },
    });
    assert.deepEqual(run.integrations, ["codex"]);
    assert.deepEqual(run.integrationStatus, [{ kind: "codex", name: "codex", status: "current", installed: true, version: "8" }]);
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

test("init accepts a matched future endpoint generation without claiming a dependency", () => {
  const { r, state, output, cleanup } = initRun({
    AXI_FAKE_CLIENT_GEN: "2", AXI_FAKE_SERVER_GEN: "2",
  });
  try {
    assert.equal(r.status, 0, output);
    const herdr = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8")).herdr;
    assert.equal(herdr.endpointProtocolGeneration, 2);
    assert.equal(herdr.serverEndpointProtocolGeneration, 2);
    assert.equal(herdr.endpointCompatible, true);
    assert.doesNotMatch(output, /warning/);
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

test("init refuses an empty Herdr integration inventory before creating run state", () => {
  const { r, state, output, cleanup } = initRun({ AXI_FAKE_NO_INTEGRATIONS: "true" });
  try {
    assert.equal(r.status, 1, output);
    assert.match(output, /INTEGRATION_NOT_INSTALLED/);
    assert.equal(fs.existsSync(path.join(state, "run.json")), false);
  } finally { cleanup(); }
});

test("cursor-only init does not print a queue command with an invented model", () => {
  const { r, output, cleanup } = initRun({ AXI_FAKE_INTEGRATION_KIND: "cursor" });
  try {
    assert.equal(r.status, 0, output);
    assert.match(output, /herdr-axi guide cursor/);
    assert.doesNotMatch(output, /run queue TASK --kind cursor/);
  } finally { cleanup(); }
});

test("core-only init keeps a valid direct queue recipe", () => {
  for (const kind of ["claude", "codex", "copilot"]) {
    const { r, output, cleanup } = initRun({ AXI_FAKE_INTEGRATION_KIND: kind });
    try {
      assert.equal(r.status, 0, output);
      assert.match(output, kind === "copilot" ? /run queue TASK --role implementer/ : new RegExp(`run queue TASK --kind ${kind}`));
      assert.doesNotMatch(output, /herdr-axi guide cursor/);
    } finally { cleanup(); }
  }
});

test("custom roles with unavailable or misspelled integrations remain visible as warnings", () => {
  const { r, output, cleanup } = initRun({}, { roles: { implementer: { kind: "opencodee", access: "write" } } });
  try {
    assert.equal(r.status, 0, output);
    assert.match(output, /Configured worker roles are unavailable and were omitted: implementer:opencodee/);
    assert.match(output, /role kind spelling/);
  } finally { cleanup(); }
});
