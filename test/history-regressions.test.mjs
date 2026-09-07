import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { history, finishRun } from "../src/archive.mjs";
import { loadRun, PHASES } from "../src/run-state.mjs";

test("history exposes one bounded revision through the offline CLI before and after archival", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-history-"));
  const previous = { HERDR_AXI_RUN: process.env.HERDR_AXI_RUN, HERDR_AXI_STATE_HOME: process.env.HERDR_AXI_STATE_HOME };
  process.env.HERDR_AXI_RUN = dir; process.env.HERDR_AXI_STATE_HOME = path.join(dir, "state");
  const result = "UNIQUE_REVIEW_EVIDENCE\n" + "x".repeat(4000);
  const run = { schema: 1, id: "history-test", project: dir, owner: { pane: "w:p1", tab: "w:t1" }, workspace: "w", phase: "explore", limits: PHASES, workers: [], tasks: [{
    id: "report", cwd: dir, state: "accepted", summary: "current summary", result: "CURRENT_REPORT", prompt: "current prompt", revisions: [
      { at: "2026-09-07T01:00:00Z", generation: "generation1", prompt: "p".repeat(4500), summary: "old summary", result, resultSource: "coordinator-replacement", truncated: true },
      { at: "2026-09-07T02:00:00Z", prompt: "legacy prompt", summary: "legacy summary" },
    ],
  }] };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/herdr-axi.mjs", import.meta.url)), "run", "history", ...args], {
      encoding: "utf8", timeout: 10000, env: { ...process.env, HERDR_ENV: "", HERDR_BIN: "/nonexistent/history-must-be-offline" },
    });
    return { status: r.status, output: r.stdout + r.stderr };
  };
  try {
    for (const archived of [false, true]) {
      if (archived) { finishRun(); assert.equal(loadRun().tasks[0].revisions, undefined); }
      const compact = cli("--task", "report");
      assert.equal(compact.status, 0, compact.output);
      assert.doesNotMatch(compact.output, /UNIQUE_REVIEW_EVIDENCE/);
      assert.match(compact.output, /--revision 2/, "index detail escape hatch remains discoverable");
      const detailed = cli("--task", "report", "--revision", "1");
      assert.equal(detailed.status, 0, detailed.output);
      assert.match(detailed.output, /UNIQUE_REVIEW_EVIDENCE/);
      assert.match(detailed.output, /generation1/);
      assert.match(detailed.output, /coordinator-replacement/);
      assert.match(detailed.output, /truncated: true/);
      assert.doesNotMatch(detailed.output, /CURRENT_REPORT|legacy summary/);
      const projected = history(loadRun(), "report", "1");
      assert.equal(projected.result.length, 3500); assert.equal(projected.prompt.length, 4000);
      assert.equal(projected.promptTruncated, true); assert.equal(projected.truncated, true);
      const legacy = cli("--task", "report", "--revision", "2");
      assert.equal(legacy.status, 0, legacy.output);
      assert.match(legacy.output, /legacy summary/); assert.match(legacy.output, /not retained/);
    }
    for (const args of [["--revision", "1"], ["--all", "--revision", "1"], ...["0", "-1", "1.5", "1e0", "9", ""].map((n) => ["--task", "report", "--revision", n])]) {
      const invalid = cli(...args); assert.equal(invalid.status, 1, JSON.stringify(args) + invalid.output);
    }
    fs.unlinkSync(path.join(dir, "detail.json.gz"));
    const expired = cli("--task", "report", "--revision", "1");
    assert.equal(expired.status, 1); assert.match(expired.output, /DETAIL_EXPIRED/);
    assert.equal(cli("--task", "report").status, 0, "summary survives detail retention");
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
