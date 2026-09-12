import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateLaunch, resolveLaunch, checkLaunchScreen } from "../src/launch-policy.mjs";
import { installedIntegrationKinds, parseIntegrationStatus, integrationPolicy } from "../src/integrations.mjs";
import { selectWorker, validateConfig } from "../src/project.mjs";

test("launch resolver opts into built-in defaults while strict validation still requires a model", () => {
  const policy = fileURLToPath(new URL("../src/launch-policy.mjs", import.meta.url));
  for (const [kind, expected] of [
    ["codex", { kind: "codex", model: "gpt-5.6-sol", effort: "high", mode: "approve-for-me" }],
    ["claude", { kind: "claude", model: "opus", effort: "high", mode: "auto" }],
    ["copilot", { kind: "copilot", model: "gpt-5.6-sol", effort: "high", mode: "autopilot" }],
  ]) {
    const resolved = spawnSync(process.execPath, [policy, "--resolve", "--kind", kind], { encoding: "utf8" });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.deepEqual(JSON.parse(resolved.stdout), expected);
    assert.equal(spawnSync(process.execPath, [policy, "--kind", kind]).status, 1);
  }
});

test("launch resolver preserves explicit overrides and rejects explicitly invalid values", () => {
  const policy = fileURLToPath(new URL("../src/launch-policy.mjs", import.meta.url));
  const resolved = spawnSync(process.execPath, [policy, "--resolve", "--kind", "codex", "--model", "gpt-5.6-custom", "--effort", "medium"], { encoding: "utf8" });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.deepEqual(JSON.parse(resolved.stdout), { kind: "codex", model: "gpt-5.6-custom", effort: "medium", mode: "approve-for-me" });
  for (const options of [{ kind: "codex", model: null }, { kind: "codex", effort: null }]) assert.throws(() => resolveLaunch(options), { code: "LAUNCH_POLICY" });
});

test("launch resolver leaves Cursor explicit and generic integrations native", () => {
  const policy = fileURLToPath(new URL("../src/launch-policy.mjs", import.meta.url));
  const run = (args) => spawnSync(process.execPath, [policy, "--resolve", ...args], { encoding: "utf8" });
  assert.equal(run(["--kind", "cursor"]).status, 1);
  assert.deepEqual(JSON.parse(run(["--kind", "cursor", "--model", "composer-2.5"]).stdout), { kind: "cursor", model: "composer-2.5", effort: "model", mode: "auto-review" });
  for (const kind of ["opencode", "future-agent", "constructor"]) {
    assert.deepEqual(JSON.parse(run(["--kind", kind]).stdout), { kind, mode: "native" });
    for (const override of [["--model", "x"], ["--effort", "high"]]) assert.equal(run(["--kind", kind, ...override]).status, 1);
  }
  for (const args of [[], ["--kind", "__proto__"], ["--kind", "codex", "--unknown", "x"], ["--kind", "codex", "--kind", "claude"], ["--kind", "cursor", "--model", "auto"], ["--kind", "codex", "--model"]]) assert.equal(run(args).status, 1);
  assert.equal(spawnSync(process.execPath, [policy, "--kind", "codex", "--resolve"], { encoding: "utf8" }).status, 1);
});

test("launch resolver executes through a symlink", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-launch-resolve-"));
  try {
    const link = path.join(dir, "policy.mjs"); fs.symlinkSync(fileURLToPath(new URL("../src/launch-policy.mjs", import.meta.url)), link);
    const result = spawnSync(process.execPath, [link, "--resolve", "--kind", "claude"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { kind: "claude", model: "opus", effort: "high", mode: "auto" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("prototype names follow native integration policy and cannot impersonate configured roles", () => {
  assert.deepEqual(integrationPolicy("constructor"), { mode: "native", model: false, effort: false });
  assert.deepEqual(validateLaunch({ kind: "constructor" }), { kind: "constructor", mode: "native" });
  assert.deepEqual(selectWorker(validateConfig(), { kind: "constructor" }, ["constructor"]), { kind: "constructor", access: "write" });
  assert.throws(() => selectWorker(validateConfig(), { kind: "constructor", model: "x" }, ["constructor"]), /native configuration/);
  assert.throws(() => selectWorker(validateConfig(), { role: "constructor", kind: "codex" }), { code: "CONFIG_INVALID" });
  assert.equal(integrationPolicy("__proto__"), null);
});

test("provider defaults configure direct queues while explicit role and CLI choices retain precedence", () => {
  const config = validateConfig({
    providerDefaults: { codex: { model: "gpt-5.6-custom", effort: "medium" }, cursor: { model: "composer-2.5" } },
    roles: { implementer: { subagents: [{ role: "verifier", max: 1, when: "review" }] } },
  });
  assert.deepEqual(selectWorker(config, { kind: "codex" }), { kind: "codex", model: "gpt-5.6-custom", effort: "medium", access: "write" });
  assert.equal(selectWorker(config, { role: "implementer" }).model, "gpt-5.6-sol");
  const override = selectWorker(config, { role: "implementer", kind: "codex", model: "gpt-5.6-explicit" });
  assert.equal(override.effort, "medium");
  assert.equal(override.access, "write");
  assert.deepEqual(override.subagents, config.roles.implementer.subagents);
  assert.equal(selectWorker(config, { kind: "codex", model: "gpt-5.6-explicit", effort: "low" }).effort, "low");
  assert.equal(selectWorker(config, { kind: "cursor" }).model, "composer-2.5");
  for (const options of [{ kind: "codex" }, { kind: "cursor" }]) {
    assert.throws(() => selectWorker(config, options, undefined, { requireExplicitModel: true }), /requires --model/);
  }
  assert.throws(() => selectWorker(config, { role: "verifier", kind: "codex" }), /requires --model/);
});

test("provider defaults reject unknown keys, native overrides, invalid models and incompatible effort", () => {
  for (const providerDefaults of [
    { constructor: { model: "x" } }, { opencode: { model: "x" } },
    JSON.parse('{"__proto__":{"model":"x"}}'),
    { codex: { mode: "bypass" } }, { codex: { model: "opus" } },
    { claude: { model: "haiku" } }, { claude: { effort: "minimal" } },
    { cursor: { model: "auto" } }, { cursor: { effort: "high" } },
    { cursor: { model: null } }, { codex: { effort: "unbounded" } },
  ]) assert.throws(() => validateConfig({ providerDefaults }), { code: "CONFIG_INVALID" });
});

test("provider changes use destination effort without losing the role contract", () => {
  const config = validateConfig({
    roles: { cursor: { kind: "cursor", model: "composer-2.5", access: "read", contextWindowTokens: 100000, subagents: [{ role: "verifier", max: 1, when: "review" }] } },
    providerDefaults: { codex: { effort: "medium" } },
  });
  const changed = selectWorker(config, { role: "cursor", kind: "codex", model: "gpt-5.6-sol" });
  assert.equal(changed.effort, "medium");
  assert.equal(changed.access, "read");
  assert.deepEqual(changed.subagents, config.roles.cursor.subagents);
  assert.equal(changed.contextWindowTokens, undefined);
  assert.equal(selectWorker(config, { role: "cursor" }).contextWindowTokens, 100000);
  const same = selectWorker(validateConfig({ roles: { verifier: { effort: "xhigh" } } }), { role: "verifier", model: "sonnet" });
  assert.equal(same.effort, "xhigh");
  const archivedConfig = validateConfig(); delete archivedConfig.providerDefaults;
  assert.equal(selectWorker(archivedConfig, { kind: "codex" }).model, "gpt-5.6-sol");
});

test("Cursor uses explicit native model IDs and Smart Auto without inheriting another provider's effort", () => {
  const selected = selectWorker(validateConfig(), { role: "verifier", kind: "cursor", model: "composer-2.5" });
  assert.equal(selected.kind, "cursor"); assert.equal(selected.access, "read"); assert.equal(selected.effort, "model");
  assert.equal(validateLaunch(selected).mode, "auto-review");
  assert.equal(validateConfig({ roles: { cursor: { kind: "cursor", model: "gpt-5.6-sol-high", access: "read" } } }).roles.cursor.model, "gpt-5.6-sol-high");
  for (const model of [undefined, "auto", "--force", "composer;echo", "opus[1m]"]) assert.throws(() => validateLaunch({ kind: "cursor", model }));
  assert.throws(() => selectWorker(validateConfig(), { kind: "cursor" }), /requires --model/);
  assert.throws(() => validateLaunch({ kind: "cursor", model: "composer-2.5", effort: "high" }), /effort is selected by its model ID/);
  assert.throws(() => validateLaunch({ kind: "codex", model: "gpt-5.6-sol", effort: "model" }), /Unsupported/);
  assert.throws(() => validateConfig({ roles: { cursor: { kind: "cursor", model: "composer-2.5", access: "read", mode: "manual" } } }), /Invalid/);
});

test("Herdr integration status is the worker availability authority", () => {
  const records = parseIntegrationStatus("noise\r\nclaude: current (v9) (/a)\r\ncursor: not installed (/b)\r\nopencode: outdated (v11) (/c)\r\nantigravity-cli: installed (/d)\r\nfuture-agent: current (v2) (/e)\r\nopencode: current (v12) (/f)");
  assert.deepEqual(installedIntegrationKinds(records), ["claude", "opencode", "agy", "future-agent"]);
  assert.deepEqual(records.find((record) => record.kind === "opencode"), { kind: "opencode", name: "opencode", status: "current", installed: true, version: "12" });
  assert.equal(validateLaunch({ kind: "opencode" }).mode, "native");
  for (const options of [{ kind: "opencode", model: "x" }, { kind: "opencode", effort: "high" }]) assert.throws(() => validateLaunch(options), /native configuration/);
  const config = validateConfig({ roles: { implementer: { kind: "opencode", access: "write" } } });
  assert.deepEqual(selectWorker(config, { role: "implementer" }, ["opencode"]), { kind: "opencode", access: "write" });
  assert.throws(() => selectWorker(config, { role: "implementer", model: "ignored" }, ["opencode"]), /omit --model/);
  assert.throws(() => selectWorker(config, {}, ["opencode"]), /Choose a worker role or Herdr integration kind/);
  assert.equal(selectWorker(config, { kind: "codex" }, ["codex"]).model, "gpt-5.6-sol");
  assert.throws(() => selectWorker(config, { kind: "codex" }, ["codex"], { requireExplicitModel: true }), /requires --model/);
  assert.throws(() => selectWorker(config, { role: "implementer" }, ["codex"]), { code: "INTEGRATION_NOT_INSTALLED" });
});

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
    assert.equal(JSON.parse(run(["--check-integration", "opencode"], "opencode: current (v11) (/fixture)").stdout).kind, "opencode");
    assert.equal(run(["--check-integration", "cursor"], "cursor: not installed (/fixture)").status, 1);
    for (const args of [["--kind", "claude", "--model", "haiku"], ["--kind", "codex", "--model", "gpt-5.6-sol", "--permission-mode", "manual"], ["--check-screen"]]) assert.equal(run(args).status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("launch preflight emits named failures on the dedicated engine descriptor", () => {
  const policy = fileURLToPath(new URL("../src/launch-policy.mjs", import.meta.url));
  for (const [args, input, code] of [
    [["--kind", "claude", "--model", "haiku"], "", "AUTO_MODE_UNSUPPORTED"],
    [["--check-screen"], "", "AUTO_MODE_UNVERIFIED"],
    [["--check-integration", "cursor"], "cursor: not installed\n", "INTEGRATION_NOT_INSTALLED"],
  ]) {
    const result = spawnSync(process.execPath, [policy, ...args], {
      input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: { ...process.env, HERDR_AXI_ENGINE_PROTOCOL: "1" },
    });
    assert.equal(result.status, 1);
    assert.notEqual(result.output[3], "", "engine descriptor must carry the named failure");
    const frame = JSON.parse(result.output[3]);
    assert.deepEqual(frame, { schema: 1, code, message: frame.message, submitted: false });
    assert.match(result.stderr, new RegExp(code));
    assert.equal(result.stdout, "");
  }
  for (const protocol of [undefined, "1"]) {
    const env = { ...process.env }; delete env.HERDR_AXI_ENGINE_PROTOCOL;
    if (protocol) env.HERDR_AXI_ENGINE_PROTOCOL = protocol;
    const result = spawnSync(process.execPath, [policy, "--check-screen"], { encoding: "utf8", input: "", env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AUTO_MODE_UNVERIFIED/);
    assert.doesNotMatch(result.stderr, /EBADF|EPIPE/);
    assert.equal(result.stdout, "");
  }
});
