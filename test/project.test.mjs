import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { validateConfig, projectConfig, worktree, writerLease } from "../src/project.mjs";
import { contextValue } from "../src/context.mjs";
import { collectArchives, projectRuns } from "../src/archive.mjs";

test("project config rejects typos, recursive/write delegates and impossible budgets", () => {
  const c = validateConfig({ roles: { implementer: { subagents: [{ role: "verifier", max: 1, when: "review" }] } } });
  assert.equal(c.agentRatio, 0.75); assert.equal(c.roles.implementer.model, "gpt-5.6-sol");
  for (const config of [{ agentsRatio: 0.5 }, { phases: { fix: 0 } }, { context: { warnPercent: 90, criticalPercent: 80 } }, { retention: { detailDays: 90, summaryDays: 30 } }, { roles: { verifier: { typo: 1 } } }, { roles: { implementer: { subagents: [{ role: "implementer", max: 1, when: "recurse" }] } } }, { nativeSubagentLimit: 0, roles: { implementer: { subagents: [{ role: "verifier", max: 1, when: "review" }] } } }]) assert.throws(() => validateConfig(config), /Invalid|require|exceeds/i);
});

test("canonical worktree and cross-run writer leases, read-only exception", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-project-"));
  const previous = process.env.HERDR_AXI_STATE_HOME; process.env.HERDR_AXI_STATE_HOME = path.join(dir, "state");
  try {
    const repo = path.join(dir, "repo"); fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, "src"));
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    assert.equal(worktree(repo), worktree(path.join(repo, "src")));
    fs.writeFileSync(path.join(repo, ".herdr-axi.json"), JSON.stringify({ agentRatio: 0.8 }));
    assert.equal(projectConfig(path.join(repo, "src")).config.agentRatio, 0.8);
    const task = { id: "a", cwd: repo, worktree: worktree(repo), access: "write" };
    assert(writerLease({ id: "first" }, task));
    assert(!writerLease({ id: "second" }, task));
    assert(writerLease({ id: "second" }, { ...task, access: "read" }));
    writerLease({ id: "second" }, task, true);
    assert(!writerLease({ id: "second" }, task), "wrong owner cannot release lease");
    writerLease({ id: "first" }, task, true);
    assert(writerLease({ id: "second" }, task));
  } finally { if (previous === undefined) delete process.env.HERDR_AXI_STATE_HOME; else process.env.HERDR_AXI_STATE_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("context uses explicit context or last input, never cost, cumulative usage or quota", () => {
  assert.deepEqual(contextValue("codex", "Context 14% left · weekly 91% left"), { percent: 86, source: "native-context" });
  assert.deepEqual(contextValue("codex", "weekly 91% left · 50%"), { source: "unknown" });
  const claude = JSON.stringify({ message: { usage: { input_tokens: 2, cache_creation_input_tokens: 366, cache_read_input_tokens: 53149, output_tokens: 164 } } });
  assert.equal(contextValue("claude", claude, 100000).percent, 54);
  assert.equal(contextValue("claude", claude).percent, undefined);
  const copilot = JSON.stringify({ type: "session.usage_checkpoint", data: { totalNanoAiu: 999999, promptCacheBreakState: [{ conversation: "main", lastActiveModel: "sol", models: { sol: { prompt_tokens: 21955, cache_read: 21504 } } }] } });
  assert.equal(contextValue("copilot", copilot, 100000).percent, 22);
  assert.equal(contextValue("copilot", JSON.stringify({ totalNanoAiu: 999999 })).percent, undefined);
});

test("retention expires only verified archived records; active/unknown/symlink data survives", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-retention-"));
  const previous = process.env.HERDR_AXI_STATE_HOME; process.env.HERDR_AXI_STATE_HOME = dir;
  try {
    const project = "/fixture/project", root = projectRuns(project);
    const record = { schema: 1, storage: "managed", project, finishedAt: "2020-01-01T00:00:00.000Z", tasks: [{ state: "accepted" }], workers: [{ closed: true }], config: validateConfig() };
    const create = (r) => { const d = path.join(root, randomUUID()); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "run.json"), JSON.stringify(r)); fs.writeFileSync(path.join(d, "detail.json.gz"), "archive"); return d; };
    const archived = create(record), active = create({ ...record, finishedAt: null }), foreign = create({ ...record, project: "/other" }), locked = create(record), unknown = create(record);
    fs.writeFileSync(path.join(locked, "run.lock"), "123"); fs.writeFileSync(path.join(unknown, "user-notes"), "keep");
    const outside = fs.mkdtempSync(path.join(tmpdir(), "axi-outside-"));
    fs.symlinkSync(outside, path.join(root, randomUUID()));
    try {
      assert.deepEqual(collectArchives(project, Date.parse("2021-01-01")), { detailsRemoved: 2, summariesRemoved: 1 });
      assert(!fs.existsSync(archived));
      for (const d of [active, foreign, locked]) assert(fs.existsSync(path.join(d, "detail.json.gz")));
      assert(fs.existsSync(path.join(unknown, "user-notes"))); assert(fs.existsSync(outside));
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { if (previous === undefined) delete process.env.HERDR_AXI_STATE_HOME; else process.env.HERDR_AXI_STATE_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); }
});
