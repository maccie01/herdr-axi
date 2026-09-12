#!/usr/bin/env node
import assert from "node:assert/strict";

// Dedicated fixture executable: never imports or dispatches a test suite.
if (process.argv.length <= 2) { console.error("fake herdr requires a command"); process.exit(2); }
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
