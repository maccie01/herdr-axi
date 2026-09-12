import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { worktree, projectConfig } from "../src/project.mjs";

test("inherited Git repository-selection variables cannot split identity or bypass root policy", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-git-environment-"));
  const originalEnv = { ...process.env };
  try {
    const repo = path.join(dir, "repo"), source = path.join(repo, "src"), engine = path.join(repo, "engine");
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(engine);
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    fs.writeFileSync(path.join(repo, ".herdr-axi.json"), '{"agentRatio":0.8}');
    for (const overrides of [
      { GIT_DIR: path.join(repo, ".git"), GIT_WORK_TREE: "." },
      { GIT_DIR: path.join(dir, "missing"), GIT_COMMON_DIR: path.join(dir, "missing-common") },
      { GIT_CEILING_DIRECTORIES: repo },
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: "." },
      { GIT_CONFIG_PARAMETERS: "'core.worktree'='.'" },
    ]) {
      Object.assign(process.env, overrides);
      assert.equal(worktree(source), fs.realpathSync(repo), JSON.stringify(overrides));
      assert.equal(worktree(engine), fs.realpathSync(repo));
      assert.equal(projectConfig(source).config.agentRatio, 0.8);
      for (const key of Object.keys(overrides)) {
        assert.equal(process.env[key], overrides[key], "identity probe must not mutate the caller environment");
        if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
      }
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Git operational failures cannot split repository identity or bypass root configuration", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-git-errors-"));
  const oldPath = process.env.PATH;
  try {
    const repo = path.join(dir, "repo"), subdir = path.join(repo, "src"), bin = path.join(dir, "bin");
    fs.mkdirSync(subdir, { recursive: true }); fs.mkdirSync(bin);
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    fs.writeFileSync(path.join(repo, ".herdr-axi.json"), '{"agentRatio":0.8}');
    process.env.PATH = bin;
    for (const script of [null, "echo 'fatal: detected dubious ownership' >&2; exit 128", "echo 'fatal: permission denied' >&2; exit 128", "exec /bin/sleep 3", "exit 1", "echo 'fatal: not a git repository (or any of the parent directories): .git' >&2; exit 128"]) {
      if (script !== null) fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      assert.throws(() => projectConfig(subdir), { code: "WORKTREE_UNVERIFIED" }, String(script));
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical non-Git directories remain supported while broken repository markers fail closed", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-nongit-"));
  try {
    assert.equal(worktree(dir), fs.realpathSync(dir));
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, ".git"));
    assert.throws(() => worktree(path.join(dir, "src")), { code: "WORKTREE_UNVERIFIED" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("linked worktree subdirectories and aliases resolve to their own canonical root", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "axi-linked-tree-"));
  try {
    const repo = path.join(dir, "repo"), linked = path.join(dir, "linked");
    for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"], ["-C", repo, "worktree", "add", "--detach", linked]]) {
      const result = spawnSync("git", args, { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    fs.mkdirSync(path.join(linked, "src"));
    fs.symlinkSync(linked, path.join(dir, "alias"));
    assert.equal(worktree(path.join(dir, "alias/src")), fs.realpathSync(linked));
    assert.notEqual(worktree(repo), worktree(linked));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
