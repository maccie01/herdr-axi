import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaError } from "../src/quota.mjs";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("quota CLI works through relative paths and symlinks with an explicit JSON result", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-quota-cli-"));
  try {
    fs.symlinkSync(fileURLToPath(new URL("../src/quota.mjs", import.meta.url)), path.join(dir, "quota.mjs"));
    for (const file of ["quota.mjs", path.join(dir, "quota.mjs")]) {
      const detected = spawnSync(process.execPath, [file], { cwd: dir, input: "You've hit your session limit", encoding: "utf8" });
      assert.equal(detected.status, 0, detected.stderr);
      assert.equal(JSON.parse(detected.stdout).code, "QUOTA_EXHAUSTED");
      const clear = spawnSync(process.execPath, [file], { cwd: dir, input: "task: running", encoding: "utf8" });
      assert.equal(clear.status, 2); assert.equal(clear.stdout, "");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("permission/trust UI supersedes retained quota text for every provider", () => {
  for (const dialog of ["Do you want to proceed?\n❯ 1. Yes\n  2. No", "Accessing workspace:\nYes, I trust this folder\nEnter to confirm", "Allow tool execution?\n(y/n)", "❯ Allow once\n  Deny"]) {
    assert.equal(quotaError(`You have exceeded your monthly quota\n${dialog}`), null);
    assert.equal(quotaError(`You've hit your session limit\n${dialog}`), null);
  }
});

test("quota detection recognizes native limits, not instructions, costs, retry limits or old errors", () => {
  assert.equal(quotaError(" ✗ You have exceeded your monthly quota (Request ID: abc) ┃\n /commands · GPT-5.6 Sol").scope, "monthly");
  assert.equal(quotaError("! Session limit reached. Try later").scope, "session");
  assert.equal(quotaError("You've hit your usage limit · resets later").scope, "session");
  for (const message of ["You've hit your limit · resets 7pm", "● You've reached your session limit", "■ You’ve hit your usage limit. Try again later", "! You have reached your usage limit"]) assert.equal(quotaError(message).code, "QUOTA_EXHAUSTED");
  assert.equal(quotaError("You've reached your weekly limit").scope, "weekly");
  for (const text of ['Explain "You have exceeded your monthly quota"', '> You have exceeded your monthly quota', '"Session limit reached"', 'Session: 236.28 AIC used', 'Rate limit exceeded; retry in 2s', '✗ You have exceeded your monthly quota\n● Continuing the task', '✗ You have exceeded your monthly quota\n$ Shell run tests']) assert.equal(quotaError(text), null, text);
});
