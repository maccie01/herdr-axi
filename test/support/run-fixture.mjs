import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "./executables.mjs";

const self = fileURLToPath(new URL("../fixtures/runs-herdr.mjs", import.meta.url));
export const cli = fileURLToPath(new URL("../../bin/herdr-axi.mjs", import.meta.url));
export const owner = { pane_id: "wTEST:pOWNER", tab_id: "wTEST:tOWNER", workspace_id: "wTEST", terminal_id: "owner-terminal", name: "orchestrator", agent: "codex", agent_status: "working" };

export function fixture() {
  const dependencies = ["jq", "rg"].map((name) => [name, resolveExecutable(name)]);
  const dir = fs.mkdtempSync(path.join(tmpdir(), "herdr-axi-run-test-"));
  const clean = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
    for (const [name, target] of [["herdr", self], ["node", process.execPath], ...dependencies]) fs.symlinkSync(target, path.join(bin, name));
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HERDR_BIN: self, HERDR_ENV: "1", HERDR_PANE_ID: owner.pane_id, HERDR_TAB_ID: owner.tab_id, HERDR_AXI_RUN: path.join(dir, "run"), HERDR_AXI_STATE_HOME: path.join(dir, "state"), AXI_RUN_TEST: dir, AXI_TEST_MONITOR_PID: String(process.pid) };
    const cliCalls = [];
    const execute = (args, extra = {}) => {
      cliCalls.push(args);
      const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20000, env: { ...env, ...extra } });
      assert.ifError(r.error); return { ...r, output: r.stdout + r.stderr };
    };
    const ok = (args) => { const r = execute(args); assert.equal(r.status, 0, r.output); return r.output; };
    const asyncRun = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { env }); let output = "";
      child.stdout.on("data", (b) => { output += b; }); child.stderr.on("data", (b) => { output += b; });
      child.on("error", reject); child.on("close", (status) => resolve({ status, output }));
    });
    const state = () => JSON.parse(fs.readFileSync(path.join(env.HERDR_AXI_RUN, "run.json")));
    const write = (r) => fs.writeFileSync(path.join(env.HERDR_AXI_RUN, "run.json"), JSON.stringify(r));
    const calls = () => fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    const queue = (id, area = id, after) => {
      const cwd = path.join(dir, "work", area.split("/")[0]); fs.mkdirSync(cwd, { recursive: true });
      return ok(["run", "queue", id, "--kind", "codex", "--cwd", cwd, "--area", area.includes("/") ? area.split("/").slice(1).join("/") : ".", "--prompt-file", path.join(dir, "prompt"), ...(after ? ["--after", after] : [])]);
    };
    const complete = (w, state = "done") => {
      const file = path.join(dir, `${w.pane}.agent`);
      const a = JSON.parse(fs.readFileSync(file)); a.agent_status = state; fs.writeFileSync(file, JSON.stringify(a));
      fs.writeFileSync(w.receipt, ["herdr-receipt/3", "1", "settled", "delivered", `generation:${w.generation}`, "settled", `generation:${w.generation}`, `generation:${w.generation}`, "open", w.generation, "delivered"].join("\t") + "\n");
      fs.writeFileSync(`${w.receipt}.inbox`, JSON.stringify({ generation: w.generation, event: "settled", summary: "checks passed" }));
    };
    fs.writeFileSync(path.join(dir, "prompt"), "Write hello. Check its contents. Report file and check.");
    const project = path.join(dir, "project"); fs.mkdirSync(project);
    const initialized = ok(["run", "init", "--dir", env.HERDR_AXI_RUN, "--project", project]);
    return { dir, env, execute, ok, asyncRun, state, write, calls, cliCalls, queue, complete, initialized, clean };
  } catch (error) {
    clean();
    throw error;
  }
}

export function exhaustedWorker(f) {
  f.ok(["run", "phase", "explore", "--cap", "1"]);
  f.ok(["run", "queue", "quota-task", "--role", "implementer", "--cwd", f.state().project, "--area", ".", "--prompt", "Finish the partial implementation; check its contents."]);
  const started = f.ok(["run", "next"]);
  const w = f.state().workers[0];
  assert(w, `quota fixture did not launch a worker:\n${started}`);
  const file = path.join(f.dir, `${w.pane}.agent`);
  const a = JSON.parse(fs.readFileSync(file)); a.agent_status = "idle"; fs.writeFileSync(file, JSON.stringify(a));
  fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "● Partial implementation; checks pending\n✗ You have exceeded your monthly quota (Request ID: fixture)\n /commands · autopilot");
  return w;
}


export function replacementOwner(f) {
  const a = { ...owner, pane_id: "wTEST:pNEW", tab_id: "wTEST:tNEW", terminal_id: "new-terminal", name: "replacement", agent: "claude" };
  fs.writeFileSync(path.join(f.dir, `${a.pane_id}.agent`), JSON.stringify(a));
  return { HERDR_PANE_ID: a.pane_id, HERDR_TAB_ID: a.tab_id };
}
