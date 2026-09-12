#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
const owner = { pane_id: "wTEST:pOWNER", tab_id: "wTEST:tOWNER", workspace_id: "wTEST", terminal_id: "owner-terminal", name: "orchestrator", agent: "codex", agent_status: "working" };

// Dedicated fixture executable: never imports or dispatches a test suite.
if (process.argv.length <= 2) { console.error("fake herdr requires a command"); process.exit(2); }
const [group, action, ...args] = process.argv.slice(2);
if (group === "status") {
  assert.equal(action, "--json");
  console.log(JSON.stringify({
    client: { version: "0.9.0", protocol: 22, endpoint_protocol_generation: 1 },
    server: { status: "running", running: true, version: "0.9.0", protocol: 22, compatible: true, endpoint_compatible: true,
      capabilities: { endpoint_protocol_generation: 1, live_handoff: true, surface_interest: true, health_check: true } },
  }));
  process.exit(0);
}
if (group === "integration") {
  assert.equal(action, "status");
  const missing = process.env.AXI_TEST_MISSING_INTEGRATION;
  const none = process.env.AXI_TEST_NO_INTEGRATIONS === "1";
  console.log(["claude", "codex", "copilot", "cursor", "opencode"].map((kind) =>
    `${kind}: ${none || kind === missing ? "not installed" : "current (v1)"} (/fixture)`).join("\n"));
  process.exit(0);
}
if (!["agent", "tab", "pane"].includes(group)) {
  console.error(JSON.stringify({ error: { code: "unsupported", message: `fake herdr (${process.argv[1].split("/").pop()}): unhandled command ${process.argv.slice(2).join(" ")}` } }));
  process.exit(2);
}
const dir = process.env.AXI_RUN_TEST;
fs.appendFileSync(path.join(dir, "calls"), JSON.stringify({ group, action, args, time: Date.now() }) + "\n");
const emit = (result) => console.log(JSON.stringify({ result }));
const all = () => fs.readdirSync(dir).filter((n) => n.endsWith(".agent")).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n))));
const monitors = () => fs.readdirSync(dir).filter((n) => n.endsWith(".monitor")).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n))));
const save = (a) => {
  const file = path.join(dir, `${a.pane_id}.agent`), temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(a)); fs.renameSync(temp, file);
};
const currentOwner = () => fs.existsSync(path.join(dir, "owner-gone")) ? [] : [fs.existsSync(path.join(dir, "owner.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "owner.json"))) : owner];
const find = (id) => [...currentOwner(), ...all()].find((a) => a.pane_id === id || a.name === id);
const missing = (kind) => { console.error(JSON.stringify({ error: { code: `${kind}_not_found`, message: "resource absent" } })); process.exit(1); };
if (group === "agent") {
  if (action === "list") {
    emit({ agents: [...currentOwner(), ...all().filter((a) => a.agent)] });
    const replacement = path.join(dir, "replace-after-list");
    if (fs.existsSync(replacement)) {
      const worker = find(fs.readFileSync(replacement, "utf8"));
      worker.agent_session = { value: "replacement-session" }; save(worker);
      fs.unlinkSync(replacement);
    }
  }
  else if (action === "get") emit({ agent: find(args[0]) ?? missing("agent") });
  else if (action === "start") {
    const ready = path.join(dir, "startup-delay"), deadline = Date.now() + 10000;
    while (fs.existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert(!fs.existsSync(ready), "startup fixture was not released");
    const a = find(args[args.indexOf("--pane") + 1]);
    a.name = args[0]; a.agent = args[args.indexOf("--kind") + 1]; a.agent_status = "idle";
    a.agent_session = { value: "session-1" };
    if (fs.existsSync(path.join(dir, "startup-no-session")) || fs.existsSync(path.join(dir, "lazy-codex"))) delete a.agent_session;
    if (fs.existsSync(path.join(dir, "startup-blocked"))) {
      a.agent_status = "blocked"; save(a);
      console.error(JSON.stringify({ error: { code: "agent_not_ready", message: "startup blocked" } })); process.exit(1);
    }
    save(a); emit({ agent: a });
  } else if (action === "prompt") {
    assert.notEqual(args[0], owner.pane_id, "must never prompt the owner");
    assert.notEqual(args[0], "orchestrator");
    assert(args.includes("--wait"));
    assert.equal(args[args.indexOf("--timeout") + 1], "15000");
    assert(args.includes("working"), "must acknowledge working rather than wait for settlement");
    if (fs.existsSync(path.join(dir, "prompt-rejected"))) {
      const a = find(args[0]); a.agent_status = "blocked"; save(a);
      console.error(JSON.stringify({ error: { code: "agent_blocked", message: "approval required before any input" } })); process.exit(1);
    }
    const a = find(args[0]); a.agent_status = "working"; save(a);
    if (fs.existsSync(path.join(dir, "lazy-codex")) && args[1].includes("HERDR_AXI_READY_")) {
      const reply = args[1].match(/HERDR_AXI_READY_[A-Za-z0-9_-]+/)[0];
      if (fs.readFileSync(path.join(dir, "lazy-codex"), "utf8") === "pending") {
        console.error(JSON.stringify({ error: { code: "timeout", message: "initialization acknowledgement lost" } })); process.exit(1);
      }
      a.agent_session = { value: randomUUID() }; a.agent_status = "idle"; save(a);
      const sessions = path.join(path.resolve(a.cwd, process.env.CODEX_HOME), "sessions", "2026", "09", "12");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, `rollout-2026-09-12-${a.agent_session.value}.jsonl`), [
        { type: "session_meta", payload: { id: a.agent_session.value } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "bootstrap-turn" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: args[1] }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: reply }] } },
        { type: "event_msg", payload: { type: "task_complete", turn_id: "bootstrap-turn", last_agent_message: reply } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      emit({ agent: a }); process.exit(0);
    }
    if (fs.existsSync(path.join(dir, "session-rotate"))) { a.agent_session = { value: randomUUID() }; save(a); }
    if (fs.existsSync(path.join(dir, "prompt-uncertain"))) {
      console.error(JSON.stringify({ error: { code: "timeout", message: "acknowledgement lost" } })); process.exit(1);
    }
    // Keep first startup in flight so concurrent `next` exercises reservations.
    await new Promise((resolve) => setTimeout(resolve, 150));
    emit({ agent: a });
  } else if (action === "read") {
    if (args.includes("recent-unwrapped") && fs.existsSync(path.join(dir, "history-read-fail"))) {
      console.error("history unavailable"); process.exit(1);
    }
    console.log(fs.existsSync(path.join(dir, `screen-${args[0]}`)) ? fs.readFileSync(path.join(dir, `screen-${args[0]}`), "utf8") : fs.existsSync(path.join(dir, "context-footer")) ? fs.readFileSync(path.join(dir, "context-footer"), "utf8") : find(args[0])?.agent === "claude" ? "Worker result\n⏵⏵ auto mode on (shift+tab to cycle) · for agents" : "Worker result");
  }
  else if (action === "wait") emit({ agent: find(args[0]) ?? missing("agent") });
  else if (action === "send-keys") { const a = find(args[0]); a.agent_status = "idle"; save(a); emit({ sent: true }); }
  else throw Error(`unexpected agent ${action}`);
} else if (group === "tab") {
  if (action === "create") {
    if (fs.existsSync(path.join(dir, "create-fail"))) { console.error("backend unavailable before tab create"); process.exit(1); }
    const id = randomUUID().slice(0, 8);
    const a = { ...owner, pane_id: `wTEST:p${id}`, tab_id: `wTEST:t${id}`, terminal_id: id, name: "", label: args[args.indexOf("--label") + 1], agent: "", agent_status: "idle", cwd: args[args.indexOf("--cwd") + 1] };
    save(a); emit({ tab: { tab_id: a.tab_id }, root_pane: { pane_id: a.pane_id, terminal_id: a.terminal_id } });
  } else if (action === "get") {
    const panes = [...currentOwner(), ...all(), ...monitors()].filter((a) => a.tab_id === args[0]);
    const a = panes[0] ?? missing("tab");
    emit({ tab: { tab_id: a.tab_id, workspace_id: a.workspace_id, pane_count: panes.length + (fs.existsSync(path.join(dir, "extra-pane")) ? 1 : 0) } });
  } else if (action === "rename") {
    assert.notEqual(args[0], owner.tab_id);
    if (fs.existsSync(path.join(dir, "rename-delay"))) await new Promise((r) => setTimeout(r, 5000));
    if (fs.existsSync(path.join(dir, "rename-fail"))) { console.error("rename unavailable"); process.exit(1); }
    const a = all().find((a) => a.tab_id === args[0]) ?? missing("tab");
    a.label = args.slice(1).join(" "); save(a); emit({ renamed: true });
  } else if (action === "close") {
    assert.notEqual(args[0], owner.tab_id);
    if (fs.existsSync(path.join(dir, "close-fail"))) { console.error("temporary close failure"); process.exit(1); }
    for (const a of all().filter((a) => a.tab_id === args[0])) fs.unlinkSync(path.join(dir, `${a.pane_id}.agent`));
    for (const a of monitors().filter((a) => a.tab_id === args[0])) fs.unlinkSync(path.join(dir, `${a.pane_id}.monitor`));
    emit({ closed: true });
  } else throw Error(`unexpected tab ${action}`);
} else if (action === "current") {
  assert(args.includes("--current")); emit({ pane: owner });
} else if (action === "split") {
  const a = find(args[args.indexOf("--pane") + 1]);
  fs.writeFileSync(path.join(dir, `${a.pane_id}MONITOR.monitor`), JSON.stringify({ pane_id: a.pane_id + "MONITOR", tab_id: a.tab_id, workspace_id: a.workspace_id }));
  emit({ pane: { pane_id: a.pane_id + "MONITOR" } });
} else if (action === "get") {
  const a = [...currentOwner(), ...all(), ...monitors()].find((a) => a.pane_id === args[0]) ?? missing("pane");
  emit({ pane: { pane_id: args[0], tab_id: a.tab_id, workspace_id: a.workspace_id } });
} else if (action === "run") {
  if (!fs.existsSync(path.join(dir, "monitor-not-ready"))) {
    const command = args.slice(1).join(" ");
    const generation = command.match(/(?:^|\s)HERDR_MONITOR_READY=([^\s]+)/)?.[1];
    const receipt = command.match(/([^\s]+\.event)(?:\s|$)/)?.[1];
    assert(generation && receipt, "monitor command must carry its generation and receipt");
    const pid = process.env.AXI_TEST_MONITOR_PID;
    const start = spawnSync("ps", ["-p", pid, "-o", "lstart="], { encoding: "utf8" }).stdout.trim().replace(/\s+/g, " ");
    assert(start, "monitor fixture requires a verifiable persistent test process");
    fs.writeFileSync(`${receipt}.monitor-owner`, `${pid}\t${start}\n`);
    fs.writeFileSync(`${receipt}.monitor-ready`, `${generation}\n`);
  }
  emit({ ok: true });
}
else throw Error(`unexpected pane ${action}`);
