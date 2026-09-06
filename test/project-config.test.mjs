import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { projectConfig } from "../src/project.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "axi-config-lookup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, "repo");
  fs.mkdirSync(path.join(repo, "app", "src"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  const put = (dir, config) => {
    const file = path.join(dir, ".herdr-axi.json");
    fs.writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
    return fs.realpathSync(file);
  };
  return { directory, repo: fs.realpathSync(repo), app: fs.realpathSync(path.join(repo, "app")), put };
}

test("nearest subproject config is selected whole without changing project identity or files", (t) => {
  const { directory, repo, app, put } = fixture(t);
  put(repo, { agentRatio: 0.9, phases: { explore: 1 } });
  const file = put(app, { agentRatio: 0.8 });
  const alias = path.join(directory, "alias"); fs.symlinkSync(app, alias);
  const snapshot = () => fs.readdirSync(repo, { recursive: true }).sort()
    .map((entry) => [entry, fs.statSync(path.join(repo, entry)).isFile() ? fs.readFileSync(path.join(repo, entry), "hex") : null]);
  const before = snapshot();
  const selected = projectConfig(path.join(alias, "src"));
  assert.equal(selected.project, repo);
  assert.equal(selected.configFile, file);
  assert.equal(selected.config.agentRatio, 0.8);
  assert.equal(selected.config.phases.explore, 4, "ancestor configuration is not merged");
  assert.deepEqual(snapshot(), before, "lookup never writes project state");
});

test("missing nested config falls back to the worktree root", (t) => {
  const { repo, app, put } = fixture(t);
  const file = put(repo, { agentRatio: 0.8 });
  const selected = projectConfig(path.join(app, "src"));
  assert.equal(selected.project, repo);
  assert.equal(selected.configFile, file);
  assert.equal(selected.config.agentRatio, 0.8);
});

test("config lookup never crosses the git worktree root", (t) => {
  const { directory, repo, app, put } = fixture(t);
  put(directory, { agentRatio: 0.9 });
  const selected = projectConfig(app);
  assert.equal(selected.project, repo);
  assert.equal(selected.configFile, null);
  assert.equal(selected.config.agentRatio, 0.75);
});

test("malformed or invalid nearest config fails instead of selecting its parent", (t) => {
  const { repo, app, put } = fixture(t);
  put(repo, { agentRatio: 0.8 });
  for (const content of ["{broken", "null", { agentRatio: 0.1 }]) {
    put(app, content);
    assert.throws(() => projectConfig(path.join(app, "src")), { code: "CONFIG_INVALID" });
  }
});

test("non-git directories load only their own configuration", (t) => {
  const { directory, put } = fixture(t);
  const scratch = path.join(directory, "scratch"); fs.mkdirSync(scratch);
  put(directory, { agentRatio: 0.9 });
  assert.equal(projectConfig(scratch).configFile, null);
  const file = put(scratch, { agentRatio: 0.8 });
  assert.equal(projectConfig(scratch).configFile, file);
  assert.equal(projectConfig(scratch).project, fs.realpathSync(scratch));
});
