import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { validateConfig, projectConfig, worktree, writerLease, leasePath, leaseStatus, hasRunLeases, unavailableWorkerRoles } from "../src/project.mjs";
import { contextValue } from "../src/context.mjs";
import { collectArchives, projectRuns } from "../src/archive.mjs";

test("unavailable worker roles include defaults and exclude the orchestrator", () => {
  assert.deepEqual(unavailableWorkerRoles(validateConfig(), ["codex"]), [
    { role: "implementer", kind: "copilot" }, { role: "verifier", kind: "claude" },
  ]);
  assert.deepEqual(unavailableWorkerRoles(validateConfig(), undefined), []);
  const config = validateConfig({ roles: { implementer: { kind: "opencode" } } });
  assert.deepEqual(unavailableWorkerRoles(config, ["opencode", "claude"]), []);
});

test("run directory aliases preserve lease ownership, repair legacy paths and fence GC", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-lease-alias-"));
  const previous = { HERDR_AXI_RUN: process.env.HERDR_AXI_RUN, HERDR_AXI_STATE_HOME: process.env.HERDR_AXI_STATE_HOME };
  const real = path.join(dir, "real"), alias = path.join(dir, "alias");
  fs.mkdirSync(real); fs.symlinkSync(real, alias); process.env.HERDR_AXI_STATE_HOME = path.join(dir, "state");
  const task = { id: "a", cwd: dir }, run = { id: "alias-test", tasks: [task] };
  try {
    process.env.HERDR_AXI_RUN = alias; assert(writerLease(run, task));
    const file = leasePath(task), saved = JSON.parse(fs.readFileSync(file));
    assert.equal(saved.directory, fs.realpathSync(real));
    saved.directory = alias; fs.writeFileSync(file, JSON.stringify(saved)); // pre-fix lease
    process.env.HERDR_AXI_RUN = fs.realpathSync(real);
    assert.equal(leaseStatus(run).leases[0].state, "owned");
    assert(hasRunLeases(run, alias)); assert(hasRunLeases(run, real));
    assert(writerLease(run, task, true)); assert(!fs.existsSync(file));
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("project config rejects typos, recursive/write delegates and impossible budgets", () => {
  const c = validateConfig({ roles: { implementer: { subagents: [{ role: "verifier", max: 1, when: "review" }] } } });
  assert.equal(c.agentRatio, 0.75); assert.equal(c.roles.implementer.model, "gpt-5.6-sol");
  assert.equal(c.sharedReadWorktree, false);
  assert.throws(() => validateConfig({ sharedReadWorktree: "true" }), /boolean/);
  for (const config of [{ agentsRatio: 0.5 }, { phases: { fix: 0 } }, { context: { warnPercent: 90, criticalPercent: 80 } }, { retention: { detailDays: 90, summaryDays: 30 } }, { roles: { verifier: { typo: 1 } } }, { roles: { implementer: { subagents: [{ role: "implementer", max: 1, when: "recurse" }] } } }, { nativeSubagentLimit: 0, roles: { implementer: { subagents: [{ role: "verifier", max: 1, when: "review" }] } } }]) assert.throws(() => validateConfig(config), /Invalid|require|exceeds/i);
});

test("canonical worktree and cross-run leases register readers and fail closed on corrupt release", () => {
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
    assert(!writerLease({ id: "second" }, { ...task, access: "read" }), "read contracts are not isolation");
    assert(!writerLease({ id: "second", config: { sharedReadWorktree: true } }, { ...task, access: "read" }));
    writerLease({ id: "second" }, task, true);
    assert(!writerLease({ id: "second" }, task), "wrong owner cannot release lease");
    writerLease({ id: "first" }, task, true);
    assert(writerLease({ id: "second" }, task));
    const leases = path.join(dir, "state/writers");
    for (const invalid of ["", "partial lease", "null", JSON.stringify({ run: "second", directory: null, task: "a", holders: 42 })]) {
      const file = path.join(leases, fs.readdirSync(leases)[0]);
      fs.writeFileSync(file, invalid);
      assert(!writerLease({ id: "third" }, { ...task, state: "queued" }), "unknown lease defers, never aborts unrelated selections");
      assert.throws(() => writerLease({ id: "second" }, task, true), { code: "LEASE_UNVERIFIED" });
      assert.equal(fs.readFileSync(file, "utf8"), invalid, "unknown ownership must survive recovery");
    }
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

test("shared holders stay registered until the last release; cross-run settings cannot bypass exclusion", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-holders-"));
  const previous = process.env.HERDR_AXI_STATE_HOME; process.env.HERDR_AXI_STATE_HOME = dir;
  try {
    const run = { id: "a", config: { sharedReadWorktree: true } };
    const reader = { id: "read", cwd: dir, access: "read" }, writer = { ...reader, id: "write", access: "write" };
    for (const order of [[reader, writer], [writer, reader]]) {
      assert(writerLease(run, order[0])); assert(writerLease(run, order[1]));
      assert(!writerLease(run, { ...writer, id: "collision" }));
      for (const sharedReadWorktree of [false, true]) {
        const foreign = { id: "b", config: { sharedReadWorktree } };
        assert(!writerLease(foreign, reader)); assert(!writerLease(foreign, writer));
      }
      assert(writerLease(run, order[0], true));
      assert(!writerLease({ id: "b" }, writer), "remaining reader/writer still excludes other runs");
      assert(writerLease(run, order[1], true));
      assert(writerLease({ id: "b" }, writer)); assert(writerLease({ id: "b" }, writer, true));
    }
  } finally {
    if (previous === undefined) delete process.env.HERDR_AXI_STATE_HOME; else process.env.HERDR_AXI_STATE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retention expires only verified archived records; active/unknown/symlink data survives", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-retention-"));
  const previous = process.env.HERDR_AXI_STATE_HOME; process.env.HERDR_AXI_STATE_HOME = dir;
  try {
    const project = "/fixture/project", root = projectRuns(project);
    const record = { schema: 1, storage: "managed", project, finishedAt: "2020-01-01T00:00:00.000Z", tasks: [{ id: "a", cwd: project, state: "accepted" }], workers: [{ closed: true }], config: validateConfig() };
    const create = (r) => { const d = path.join(root, randomUUID()); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "run.json"), JSON.stringify(r)); fs.writeFileSync(path.join(d, "detail.json.gz"), "archive"); return d; };
    const archived = create(record), active = create({ ...record, finishedAt: null }), foreign = create({ ...record, project: "/other" }), locked = create(record), unknown = create(record);
    const stopped = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
    assert.equal(stopped.status, 0); assert.throws(() => process.kill(stopped.pid, 0), { code: "ESRCH" });
    fs.writeFileSync(path.join(archived, "watch.json"), JSON.stringify({ pid: stopped.pid }));
    fs.writeFileSync(path.join(archived, `watch.json.${stopped.pid}.tmp`), "partial");
    fs.mkdirSync(path.join(archived, "operations")); fs.writeFileSync(path.join(archived, "operations", String(stopped.pid)), "next");
    fs.writeFileSync(path.join(active, "watch.json"), JSON.stringify({ pid: stopped.pid }));
    fs.writeFileSync(path.join(unknown, "watch.json"), JSON.stringify({ pid: process.pid }));
    fs.writeFileSync(path.join(locked, "run.lock"), "123"); fs.writeFileSync(path.join(unknown, "user-notes"), "keep");
    const outside = fs.mkdtempSync(path.join(tmpdir(), "axi-outside-"));
    fs.symlinkSync(outside, path.join(root, randomUUID()));
    try {
      assert.deepEqual(collectArchives(project, Date.parse("2021-01-01")), { detailsRemoved: 2, summariesRemoved: 1 });
      assert(!fs.existsSync(archived));
      for (const d of [active, foreign, locked]) assert(fs.existsSync(path.join(d, "detail.json.gz")));
      assert(fs.existsSync(path.join(unknown, "user-notes"))); assert(fs.existsSync(outside));
      assert(fs.existsSync(path.join(unknown, "watch.json")), "live watchers survive cleanup");
      assert(fs.existsSync(path.join(active, "watch.json")), "active run diagnostics are retained");
      const retained = create({ ...record, id: "retained" });
      const lease = leasePath(record.tasks[0]); fs.mkdirSync(path.dirname(lease), { recursive: true });
      for (const value of [JSON.stringify({ run: "retained", directory: retained, task: "a" }), "null"]) {
        fs.writeFileSync(lease, value);
        collectArchives(project, Date.parse("2021-01-01"));
        assert(fs.existsSync(path.join(retained, "run.json")), "lease recovery provenance survives GC");
        assert(fs.existsSync(path.join(retained, "detail.json.gz")));
      }
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { if (previous === undefined) delete process.env.HERDR_AXI_STATE_HOME; else process.env.HERDR_AXI_STATE_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); }
});
