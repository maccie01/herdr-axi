import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../src/codex-bootstrap.mjs", import.meta.url));
const session = "019a0966-080f-7983-8d0f-1effeb97c229";

function fixture() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "axi-codex-bootstrap-"));
  const codexHome = path.join(directory, "codex");
  const nonce = randomUUID();
  const response = `HERDR_AXI_READY_${nonce}`;
  const prompt = `Initialization handshake only. Do not use tools, read or change files, start agents, or perform any task. Reply exactly ${response} and then stop.`;
  const registryPath = path.join(directory, "registry.json");
  const registry = { native_identity: { session }, bootstrap: { schema: 1, nonce, prompt, state: "sending" } };
  const transcript = path.join(codexHome, "sessions/2026/09/12", `rollout-2026-09-12T16-23-08-${session}.jsonl`);
  const records = [
    { type: "session_meta", payload: { id: session, session_id: session, source: "cli", parent_thread_id: null } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "bootstrap-turn" } },
    { type: "event_msg", payload: { type: "user_message", message: prompt } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: response }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "bootstrap-turn", last_agent_message: response } },
  ];
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const save = (events = records) => {
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(transcript, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  };
  const run = (extraEnv = {}) => spawnSync(process.execPath, [cli, registryPath], {
    encoding: "utf8", timeout: 3000,
    env: { ...process.env, CODEX_HOME: codexHome, ...extraEnv },
  });
  save();
  return { directory, codexHome, nonce, prompt, response, registry, registryPath, transcript, records, save, run,
    clean: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("Codex bootstrap CLI verifies the exact root-session prompt and completed response", () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally { f.clean(); }
});

const invalidCases = {
  "unsupported schema": (f) => { f.registry.bootstrap.schema = 2; },
  "unsafe nonce": (f) => { f.registry.bootstrap.nonce = "../marker"; },
  "unsupported checkpoint state": (f) => { f.registry.bootstrap.state = "ready"; },
  "missing session metadata": (f) => { f.records.shift(); },
  "wrong native metadata": (f) => { f.records[0].payload.id = randomUUID(); },
  "helper session": (f) => { f.records[0].payload.parent_thread_id = randomUUID(); },
  "helper source": (f) => { f.records[0].payload.source = { subagent: "review" }; },
  "nontext native user context": (f) => { f.records.splice(2, 0, { type: "response_item", payload: {
    type: "message", role: "user", content: [{ type: "input_image", image_url: "fixture" }],
  } }); },
  "changed registered session": (f) => { f.registry.bootstrap.session = randomUUID(); },
  "unsafe session path": (f) => { f.registry.native_identity.session = "../../evil"; },
  "wrong prompt": (f) => { f.records[2].payload.message += " extra"; },
  "noncanonical registry prompt": (f) => { f.registry.bootstrap.prompt = f.records[2].payload.message = "Do another task"; },
  "wrong nonce response": (f) => { f.records[3].payload.content[0].text += " extra"; },
  "nontext response content": (f) => { f.records[3].payload.content.push({ type: "refusal", refusal: "No" }); },
  "wrong complete turn": (f) => { f.records[4].payload.turn_id = "other-turn"; },
  "wrong complete response": (f) => { f.records[4].payload.last_agent_message = "other"; },
  "failed complete": (f) => { f.records[4].payload.error = { message: "failed" }; },
  "later user input": (f) => { f.records.push(f.records[2]); },
  "later turn": (f) => { f.records.push(f.records[1]); },
  "tool call": (f) => { f.records.splice(3, 0, { type: "response_item", payload: { type: "function_call", name: "shell" } }); },
  "missing turn start": (f) => { f.records.splice(1, 1); },
};
for (const [name, change] of Object.entries(invalidCases)) {
  test(`Codex bootstrap rejects ${name}`, () => {
    const f = fixture();
    try {
      change(f); f.save();
      const result = f.run();
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /CODEX_BOOTSTRAP_INVALID/);
    } finally { f.clean(); }
  });
}

for (const state of ["missing session", "missing transcript", "incomplete turn", "partial JSON", "partial UTF-8"]) {
  test(`Codex bootstrap remains pending for ${state}`, () => {
    const f = fixture();
    try {
      if (state === "missing session") { f.registry.native_identity.session = null; f.save(); }
      if (state === "missing transcript") fs.unlinkSync(f.transcript);
      if (state === "incomplete turn") f.save(f.records.slice(0, -1));
      if (state === "partial JSON") fs.appendFileSync(f.transcript, '{"type":');
      if (state === "partial UTF-8") fs.appendFileSync(f.transcript, Buffer.from([0xe2, 0x82]));
      const result = f.run();
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
    } finally { f.clean(); }
  });
}

test("Codex bootstrap enforces verification when invoked through a symlink", () => {
  const f = fixture();
  try {
    const link = path.join(f.directory, "bootstrap.mjs");
    fs.symlinkSync(cli, link); fs.unlinkSync(f.transcript);
    const result = spawnSync(process.execPath, [link, f.registryPath], {
      encoding: "utf8", env: { ...process.env, CODEX_HOME: f.codexHome },
    });
    assert.equal(result.status, 1, result.stderr);
  } finally { f.clean(); }
});

test("Codex bootstrap enforces verification with preserve-symlinks-main", () => {
  const f = fixture();
  try {
    const link = path.join(f.directory, "bootstrap.mjs");
    fs.symlinkSync(cli, link);
    const result = spawnSync(process.execPath, ["--preserve-symlinks-main", link, path.join(f.directory, "missing-registry")], {
      encoding: "utf8", env: { ...process.env, CODEX_HOME: f.codexHome },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /CODEX_BOOTSTRAP_INVALID/);
  } finally { f.clean(); }
});

for (const state of ["malformed JSON", "oversized line", "oversized file", "duplicate transcript", "symlink transcript"]) {
  test(`Codex bootstrap rejects ${state}`, () => {
    const f = fixture();
    try {
      if (state === "malformed JSON") fs.appendFileSync(f.transcript, "{broken}\n");
      if (state === "oversized line") fs.appendFileSync(f.transcript, " ".repeat(1024 * 1024 + 1) + "\n");
      if (state === "oversized file") fs.truncateSync(f.transcript, 32 * 1024 * 1024 + 1);
      if (state === "duplicate transcript") fs.copyFileSync(f.transcript, path.join(f.codexHome, "sessions", `other-${session}.jsonl`));
      if (state === "symlink transcript") {
        const other = path.join(f.directory, "other.jsonl"); fs.renameSync(f.transcript, other); fs.symlinkSync(other, f.transcript);
      }
      const result = f.run();
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
    } finally { f.clean(); }
  });
}

test("Codex bootstrap supports HOME fallback and native event aliases", () => {
  const f = fixture();
  try {
    f.records[1].payload.type = "turn_started";
    f.records[4].payload.type = "turn_complete";
    f.save(); fs.renameSync(f.codexHome, path.join(f.directory, ".codex"));
    const result = f.run({ CODEX_HOME: "", HOME: f.directory });
    assert.equal(result.status, 0, result.stderr);
  } finally { f.clean(); }
});

test("Codex bootstrap streams chunk boundaries and tolerates native context records", () => {
  const f = fixture();
  try {
    f.registry.bootstrap.state = "settled";
    f.registry.bootstrap.session = session;
    f.records.splice(1, 0, { type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: "Context ".repeat(12000) }],
    } });
    f.save();
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally { f.clean(); }
});

for (const representation of ["response only", "response then event", "event then response"]) {
  test(`Codex bootstrap verifies native user input: ${representation}`, () => {
    const f = fixture();
    try {
      const input = { type: "response_item", payload: { type: "message", role: "user",
        content: [{ type: "input_text", text: f.prompt }] } };
      if (representation === "response only") f.records[2] = input;
      if (representation === "response then event") f.records.splice(2, 0, input);
      if (representation === "event then response") f.records.splice(3, 0, input);
      f.records.splice(2, 0, { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "# AGENTS.md instructions" }, { type: "input_text", text: "<environment_context>fixture</environment_context>" },
      ] } });
      f.save();
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
    } finally { f.clean(); }
  });
}
