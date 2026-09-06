import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaError } from "../src/quota.mjs";

test("quota detection recognizes native limits, not instructions, costs, retry limits or old errors", () => {
  assert.equal(quotaError(" ✗ You have exceeded your monthly quota (Request ID: abc) ┃\n /commands · GPT-5.6 Sol").scope, "monthly");
  assert.equal(quotaError("! Session limit reached. Try later").scope, "session");
  assert.equal(quotaError("You've hit your usage limit · resets later").scope, "session");
  for (const message of ["You've hit your limit · resets 7pm", "● You've reached your session limit", "■ You’ve hit your usage limit. Try again later", "! You have reached your usage limit"]) assert.equal(quotaError(message).code, "QUOTA_EXHAUSTED");
  assert.equal(quotaError("You've reached your weekly limit").scope, "weekly");
  for (const text of ['Explain "You have exceeded your monthly quota"', '> You have exceeded your monthly quota', '"Session limit reached"', 'Session: 236.28 AIC used', 'Rate limit exceeded; retry in 2s', '✗ You have exceeded your monthly quota\n● Continuing the task', '✗ You have exceeded your monthly quota\n$ Shell run tests']) assert.equal(quotaError(text), null, text);
});
