import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runHerdr, requireHerdrEnv } from "./herdr.mjs";
import { runError, runDir, loadRun, changeRun, pending, processStart, controlActive } from "./run-state.mjs";
import { engine } from "./engine-client.mjs";
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

export const liveAgent = (pane) => runHerdr(["agent", "get", pane]).agent;
export const callerPane = () => process.env.HERDR_PANE_ID || runHerdr(["pane", "current", "--current"]).pane?.pane_id;
export const launcherAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
};

export function startupProcessAbsent(task) {
  if (launcherAlive(task.launcher)) throw runError("Launcher still active", "RUN_BUSY");
  // A killed CLI can leave its engine child running before registry creation.
  // Check only this unique launch name; no signals or global fleet operations.
  const processes = spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8", timeout: 2000, maxBuffer: 4194304 });
  if (processes.status !== 0) throw runError("Cannot verify startup process absence; retain reservation", "STARTUP_UNVERIFIED");
  if (processes.stdout.split("\n").some((line) => line.includes(path.dirname(engine) + "/herdr-") && line.split(/\s+/).includes(task.name))) throw runError("Startup engine still active after launcher exit; retain reservation until it stops", "RUN_BUSY");
}

export function ownerCheck(run) {
  if (!run) throw runError("Initialize/select a run first", "RUN_REQUIRED");
  if (callerPane() !== run.owner.pane)
    throw runError("This pane is not the run owner", "NOT_RUN_OWNER");
  const a = liveAgent(run.owner.pane);
  if (a?.workspace_id !== run.workspace || a?.tab_id !== run.owner.tab || (run.owner.terminal && a.terminal_id !== run.owner.terminal) || (run.owner.session && a.agent_session?.value !== run.owner.session))
    throw runError("Owner identity changed; refusing to control this run", "OWNER_CHANGED");
}

// Register controls under the short run lock, without rewriting run.json.
// Ordinary controls remain concurrent. Takeover alone waits for quiescence.
export function beginControl(action) {
  const run = loadRun();
  if (!run || run.finishedAt) return () => {};
  requireHerdrEnv();
  if (callerPane() !== run.owner.pane) throw runError("This pane is not the run owner", "NOT_RUN_OWNER");
  const folder = path.join(runDir(), "operations"), file = path.join(folder, `${process.pid}.${randomUUID()}`);
  const started = processStart(process.pid);
  changeRun((current) => {
    if (JSON.stringify(current.owner) !== JSON.stringify(run.owner)) throw runError("Owner changed before control started", "OWNER_CHANGED");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started, action }), { flag: "wx", mode: 0o600 });
  }, { readOnly: true });
  return () => {
    fs.rmSync(file, { force: true });
    // Keep the active run's directory stable for concurrent registrations.
    if (loadRun()?.finishedAt) try { fs.rmdirSync(folder); } catch (e) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(e.code)) throw e; }
  };
}

export function assertQuiescent(run) {
  const folder = path.join(runDir(), "operations");
  if (fs.existsSync(folder)) for (const name of fs.readdirSync(folder)) {
    const pid = name.match(/^([1-9][0-9]*)(?:\.[a-f0-9-]{36})?$/)?.[1];
    if (!pid || controlActive(path.join(folder, name), Number(pid))) throw runError(`Run control active or identity unverifiable: ${path.join(folder, name)}. Inspect identity; do not blindly retry or delete the marker.`, "RUN_BUSY", [`cat ${quote(path.join(folder, name))}`, ...(pid ? [`ps -p ${pid} -o pid=,lstart=,command=`] : []), "herdr-axi run takeover --help"]);
    fs.rmSync(path.join(folder, name), { force: true });
  }
  if (pending(run).some((t) => ["starting", "switching", "cancelling"].includes(t.state) && launcherAlive(t.launcher))) throw runError("Launcher still active; wait for it before takeover", "RUN_BUSY");
}

export function unlockRun() {
  // Shared by owner recovery and a fully validated replacement. Serialize
  // unlockers; a live/unknown lock holder is never displaced.
  const guard = path.join(runDir(), "run.unlock");
  let fd;
  try { fd = fs.openSync(guard, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") throw runError("Another unlock is active; inspect run.unlock after a crash", "RUN_BUSY"); throw e; }
  try {
    const file = path.join(runDir(), "run.lock");
    let pid;
    try { pid = Number(fs.readFileSync(file, "utf8")); }
    catch (e) { if (e.code === "ENOENT") return { unlocked: false, note: "Already unlocked; no transaction lock present." }; throw e; }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw runError("Lock owner is unknown; inspect run.lock manually");
    try { process.kill(pid, 0); throw runError("Lock holder is still live", "RUN_BUSY"); }
    catch (e) { if (e.code !== "ESRCH") throw e; }
    fs.unlinkSync(file);
    return { unlocked: true };
  } finally { fs.closeSync(fd); fs.unlinkSync(guard); }
}


// Retry publication only, never the engine call or prompt delivery.
export async function publishRun(fn) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { return changeRun(fn); }
    catch (e) { if (e.code !== "RUN_BUSY" || Date.now() >= deadline) throw e; }
    await delay(50);
  }
}
