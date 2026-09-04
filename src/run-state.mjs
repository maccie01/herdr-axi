import fs from "node:fs";
import path from "node:path";
import { AxiError } from "axi-sdk-js";

export const PHASES = { explore: 4, build: 3, integrate: 2, verify: 2, fix: 1 };
export const runError = (message, code = "RUN_ERROR") => new AxiError(message, code, ["herdr-axi run status", "herdr-axi run --help"]);
export const runDir = () => process.env.HERDR_AXI_RUN ? path.resolve(process.env.HERDR_AXI_RUN) : null;

export function loadRun(dir = runDir()) {
  if (!dir) return null;
  try {
    const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
    if (run.schema !== 1 || !run.owner?.pane || !run.owner.tab || !run.workspace || !Object.hasOwn(PHASES, run.phase) || !run.limits || Object.keys(PHASES).some((p) => !Number.isInteger(run.limits[p]) || run.limits[p] < 1 || run.limits[p] > 16) || !Array.isArray(run.tasks) || !Array.isArray(run.workers)) throw Error("invalid schema");
    return run;
  } catch (e) { throw runError(`Cannot read run at ${dir}: ${e.message}`, "RUN_INVALID"); }
}

// Short local transaction only: never hold this lock across a backend call.
// Fail closed after a crash; explicit unlock checks that the holder is dead.
export function changeRun(fn, { allowFinished = false } = {}) {
  const dir = runDir();
  if (!dir) throw runError("Set HERDR_AXI_RUN to the directory returned by run init", "RUN_REQUIRED");
  const lock = path.join(dir, "run.lock");
  let fd;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") throw runError("Run transaction busy; retry. After a crash: herdr-axi run unlock", "RUN_BUSY"); throw e; }
  const temp = path.join(dir, `run.${process.pid}.tmp`);
  try {
    fs.writeFileSync(fd, String(process.pid));
    if (fs.existsSync(path.join(dir, "run.unlock"))) throw runError("Run lock recovery in progress; retry", "RUN_BUSY");
    const run = loadRun(dir);
    if (run.finishedAt && !allowFinished) throw runError("Archived run is read-only", "RUN_FINISHED");
    const before = new Map(run.tasks.map((t) => [t.id, t.state]));
    const phase = run.phase;
    const result = fn(run);
    const at = new Date().toISOString();
    run.events ??= [];
    for (const t of run.tasks) if (before.get(t.id) !== t.state) run.events.push({ at, task: t.id, state: t.state, ...(t.pane ? { pane: t.pane } : {}), ...(t.error ? { error: t.error } : {}) });
    if (phase !== run.phase) run.events.push({ at, phase: run.phase });
    fs.writeFileSync(temp, JSON.stringify(run) + "\n", { mode: 0o600 });
    fs.renameSync(temp, path.join(dir, "run.json"));
    return result;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    fs.unlinkSync(lock);
  }
}

export function isSelf(pane, run = loadRun()) {
  return pane === process.env.HERDR_PANE_ID || pane === run?.owner.pane;
}

export function ownedRows(rows, { all = false } = {}) {
  const run = loadRun();
  const workers = run ? ownedWorkers(run) : [];
  return rows.filter((a) => !isSelf(a.pane, run) && (all || !run || workers.some((w) => !w.closed && w.tab !== run.owner.tab && w.pane === a.pane && w.workspace === a.workspace && w.tab === a.tab && w.name === a.backendName && (!w.terminal || w.terminal === a.terminal) && (!w.session || w.session === a.session))));
}

export function registeredWorker(run, task) {
  if (!task.name) return null;
  const file = path.join(runDir(), "receipts", run.workspace, `${task.name}.json`);
  let r;
  try { r = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (r.name !== task.name || r.workspace_id !== run.workspace || !r.agent_pane || !r.tab_id || !r.generation || r.receipt_file !== path.join(path.dirname(file), `${task.name}.event`)) throw runError("Malformed worker registry", "WORKER_CHANGED");
  return { name: task.name, pane: r.agent_pane, tab: r.tab_id, monitor: r.monitor_pane, workspace: run.workspace, kind: task.kind, cwd: task.cwd, model: task.model, effort: task.effort, policy: task.policy, contextWindowTokens: task.contextWindowTokens, receipt: r.receipt_file, generation: r.generation, stage: r.stage };
}

export function ownedWorkers(run) {
  const workers = [...run.workers];
  for (const t of pending(run)) if (!workers.some((w) => w.name === t.name)) {
    const w = registeredWorker(run, t);
    if (w) workers.push(w);
  }
  return workers;
}

export const pending = (run) => run.tasks.filter((t) => !["queued", "accepted", "cancelled"].includes(t.state));
export const limit = (run) => run.limits[run.phase];

export function receipt(worker) {
  try {
    const fields = fs.readFileSync(worker.receipt, "utf8").trimEnd().split("\t");
    if (fields[0] !== "herdr-receipt/3" || fields[9] !== worker.generation) return null;
    return { complete: fields[7] === `generation:${worker.generation}`, closed: fields[8] === "closed" };
  } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
