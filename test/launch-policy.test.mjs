import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateLaunch, checkLaunchScreen } from "../src/launch-policy.mjs";
import { selectWorker, validateConfig } from "../src/project.mjs";

test("worker choices preserve access and child limits; incompatible unattended models fail before launch", () => {
  const config = validateConfig({ roles: { implementer: { contextWindowTokens: 100000, subagents: [{ role: "verifier", max: 1, when: "review" }] } } });
  const selected = selectWorker(config, { role: "implementer", kind: "claude", model: "claude-opus-5", effort: "xhigh" });
  assert.equal(selected.access, "write"); assert.equal(selected.effort, "xhigh");
  assert.deepEqual(selected.subagents, config.roles.implementer.subagents);
  assert.equal(selected.contextWindowTokens, undefined);
  assert.equal(config.roles.implementer.kind, "copilot");
  assert.equal(selectWorker(config, { role: "verifier", model: "claude-opus-5" }).access, "read");
  for (const model of ["opus", "sonnet", "fable", "opus[1m]", "sonnet[1m]", "claude-opus-5", "claude-opus-4-6", "claude-sonnet-4-6-20260101", "claude-opus-5[1m]"]) assert.equal(validateLaunch({ kind: "claude", model, effort: "high" }).mode, "auto");
  for (const model of ["haiku", "claude-haiku-4-5", "claude-opus-4-5", "claude-3-7-sonnet", "opusplan", "gpt-5.6-sol", "manual", "claude-opus-4-5-anything"]) assert.throws(() => validateLaunch({ kind: "claude", model }), /auto-capable|explicit model/);
  assert.throws(() => validateLaunch({ kind: "codex", model: "claude-opus-5" }), /Codex/);
  assert.throws(() => selectWorker(config, { role: "implementer", kind: "claude" }), /requires --model/);
  assert.throws(() => selectWorker(config, { role: "orchestrator" }), /worker role/);
  assert.throws(() => validateConfig({ roles: { verifier: { model: "haiku" } } }), /auto-capable/);
  assert.throws(() => validateConfig({ roles: { verifier: { permissionMode: "manual" } } }), /Invalid/);
});

test("current explicit auto footer required; prose, old auto footer and missing mode cannot authorize submission", () => {
  for (const text of ["auto mode on", "⏵⏵ auto mode on (shift+tab to cycle) · for agents", "\x1b[32m▶▶ auto mode on\x1b[0m", "│ ⏵⏵ auto mode on │", "\x1b(B⏵⏵ auto mode on", "\x1b]0;title\x07⏵⏵ auto mode on"]) assert.equal(checkLaunchScreen(text).verified, true);
  for (const text of ["", "Worker says auto mode on", '"auto mode on"', "⏵⏵ auto mode on\n⏸ manual mode on", "⏵⏵ accept edits on", "⏸ plan mode on", "⏵⏵ bypass permissions on"]) assert.throws(() => checkLaunchScreen(text), /No task submitted|no task submitted/);
});

test("launch preflight executes via symlink and rejects unknown/native mode overrides", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-launch-policy-"));
  try {
    const link = path.join(dir, "policy.mjs"); fs.symlinkSync(fileURLToPath(new URL("../src/launch-policy.mjs", import.meta.url)), link);
    const run = (args, input = "") => spawnSync(process.execPath, [link, ...args], { encoding: "utf8", input });
    assert.equal(JSON.parse(run(["--kind", "claude", "--model", "opus", "--effort", "high"]).stdout).mode, "auto");
    assert.equal(JSON.parse(run(["--check-screen"], "⏵⏵ auto mode on").stdout).verified, true);
    for (const args of [["--kind", "claude", "--model", "haiku"], ["--kind", "codex", "--model", "gpt-5.6-sol", "--permission-mode", "manual"], ["--check-screen"]]) assert.equal(run(args).status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
