import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AxiError } from "axi-sdk-js";

export const PHASES = { explore: 4, build: 3, integrate: 2, verify: 2, fix: 1 };
export const runError = (message, code = "RUN_ERROR", help) => new AxiError(message, code, help ?? (code === "RUN_REQUIRED"
  ? ["herdr-axi run init", "herdr-axi run init --help"] : ["NOT_RUN_OWNER", "OWNER_CHANGED"].includes(code)
    ? ["herdr-axi run status", "herdr-axi run takeover --help"] : ["herdr-axi run status", "herdr-axi run --help"]));
export const canonicalDir = (dir) => dir ? fs.realpathSync(dir) : null;
const selectionError = (dir, error) => runError(`Cannot read selected run at ${dir}: ${error.message}. Restore the existing HERDR_AXI_RUN path; do not initialize a replacement run to bypass this error.`, "RUN_INVALID", ['printf \'%s\\n\' "$HERDR_AXI_RUN"', "export HERDR_AXI_RUN='/existing/run-directory'"]);
export function runDir() {
  try { return canonicalDir(process.env.HERDR_AXI_RUN); }
  catch (e) { throw selectionError(process.env.HERDR_AXI_RUN, e); }
}
const maintenance = [];
export const takeRunWarnings = () => maintenance.splice(0);

// PID alone is not a process identity. Probe only on registration and rare
// takeover/GC paths, never on every fleet poll. Missing identity stays closed.
export function processStart(pid) {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1000 });
  return r.status === 0 ? r.stdout.trim().replace(/\s+/g, " ") || null : null;
}

export function controlActive(file, pid) {
  try {
    if (!fs.lstatSync(file).isFile()) return true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") return false; return true; }
    let record;
    try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return e.code !== "ENOENT"; }
    if (record?.pid !== pid || typeof record.started !== "string" || !Number.isFinite(Date.parse(record.started))) return true;
    const current = processStart(pid);
    return !current || current === record.started;
  } catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

export function taskFor(run, target, name) {
  const matches = (t) => t.pane === target || (name && t.name === name);
  return run.tasks.find((t) => t.id === target) ?? pending(run).findLast(matches) ?? run.tasks.findLast(matches);
}

function taskHints(run) {
  if (run.finishedAt || !/^[a-zA-Z0-9]+$/.test(run.workspace)) return;
  const latest = new Map([...run.tasks, ...pending(run)].filter((t) => /^axi-[a-z0-9-]+$/.test(t.name ?? "")).map((t) => [t.name, t]));
  for (const t of latest.values()) {
    const w = run.workers.find((w) => w.name === t.name && w.pane === t.pane);
    if (w?.closed) continue;
    const file = path.join(runDir(), "receipts", run.workspace, `${t.name}.task`);
    const value = `herdr-task/1\t${t.state}\t${w?.generation || "-"}\n`;
    try { if (fs.readFileSync(file, "utf8") === value) continue; } catch (e) { if (e.code !== "ENOENT") throw e; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(temp, value, { mode: 0o600 }); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
  }
}

export function loadRun(dir = runDir()) {
  if (!dir) return null;
  try {
    const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
    if (run.schema !== 1 || !run.owner?.pane || !run.owner.tab || !run.workspace || !Object.hasOwn(PHASES, run.phase) || !run.limits || Object.keys(PHASES).some((p) => !Number.isInteger(run.limits[p]) || run.limits[p] < 1 || run.limits[p] > 16) || !Array.isArray(run.tasks) || !Array.isArray(run.workers)) throw Error("invalid schema");
    return run;
  } catch (e) { throw selectionError(dir, e); }
}

// Short local transaction only: never hold this lock across a backend call.
// Fail closed after a crash; explicit unlock checks that the holder is dead.
export function changeRun(fn, { allowFinished = false, readOnly = false } = {}) {
  const dir = runDir();
  if (!dir) throw runError("Set HERDR_AXI_RUN to the directory returned by run init", "RUN_REQUIRED");
  const lock = path.join(dir, "run.lock");
  let fd;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") throw runError("Run transaction busy; retry. After a crash: herdr-axi run unlock", "RUN_BUSY"); throw e; }
  const temp = path.join(dir, `run.${process.pid}.tmp`);
  const rollback = [], afterCommit = [];
  let committed = false, succeeded = false;
  try {
    fs.writeFileSync(fd, String(process.pid));
    if (fs.existsSync(path.join(dir, "run.unlock"))) throw runError("Run lock recovery in progress; retry", "RUN_BUSY");
    const run = loadRun(dir);
    if (run.finishedAt && !allowFinished) throw runError("Archived run is read-only", "RUN_FINISHED");
    if (readOnly) { const result = fn(run); succeeded = true; return result; }
    const before = new Map(run.tasks.map((t) => [t.id, t.state]));
    const phase = run.phase;
    const result = fn(run, { rollback, afterCommit });
    const at = new Date().toISOString();
    run.events ??= [];
    for (const t of run.tasks) if (before.get(t.id) !== t.state) run.events.push({ at, task: t.id, state: t.state, ...(t.pane ? { pane: t.pane } : {}), ...(t.error ? { error: t.error } : {}) });
    if (phase !== run.phase) run.events.push({ at, phase: run.phase });
    fs.writeFileSync(temp, JSON.stringify(run) + "\n", { mode: 0o600 });
    fs.renameSync(temp, path.join(dir, "run.json"));
    committed = true;
    // Publication has succeeded. Never turn maintenance failure into a failed
    // transaction or retry its business operation. Surface it separately.
    for (const effect of [...afterCommit, () => taskHints(run)]) {
      try { effect(); }
      catch (e) { maintenance.push({ code: e.code || "MAINTENANCE_FAILED", error: e.message.slice(0, 600) }); }
    }
    return result;
  } finally {
    // Undo reservations before unlocking; crashes remain fail-closed.
    if (!committed) for (const undo of rollback.reverse()) { try { undo(); } catch { /* lease retained */ } }
    let cleanupError;
    for (const cleanup of [() => fs.closeSync(fd), () => fs.rmSync(temp, { force: true }), () => fs.rmSync(lock, { force: true })]) {
      try { cleanup(); }
      catch (e) { if (committed) maintenance.push({ code: e.code || "MAINTENANCE_FAILED", error: e.message.slice(0, 600) }); else cleanupError ??= e; }
    }
    if (succeeded && cleanupError) throw cleanupError;
  }
}

export function isSelf(pane, run = loadRun()) {
  return pane === process.env.HERDR_PANE_ID || pane === run?.owner.pane;
}

export function ownedRows(rows, { all = false } = {}) {
  const run = loadRun();
  const issues = [];
  const workers = run && !all ? ownedWorkers(run, { issues }) : [];
  const result = rows.filter((a) => !isSelf(a.pane, run) && (all || !run || workers.some((w) => !w.closed && w.tab !== run.owner.tab && w.pane === a.pane && w.workspace === a.workspace && w.tab === a.tab && w.name === a.backendName && (!w.terminal || w.terminal === a.terminal) && (!w.session || w.session === a.session))));
  result.issues = issues.map((e) => {
    const candidate = rows.find((a) => a.backendName === e.name && a.workspace === run.workspace && !isSelf(a.pane, run));
    return { ...e, pane: e.pane || candidate?.pane || "unresolved" };
  });
  return result;
}

export function registeredWorker(run, task) {
  if (!task.name) return null;
  const file = path.join(runDir(), "receipts", run.workspace, `${task.name}.json`);
  let r;
  try { r = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw runError(`Cannot verify worker registry ${file}: ${e.message}`, "WORKER_CHANGED"); }
  if (!r || r.name !== task.name || r.workspace_id !== run.workspace || !r.agent_pane || !r.tab_id || !r.generation || r.receipt_file !== path.join(path.dirname(file), `${task.name}.event`)) throw runError(`Malformed worker registry: ${file}`, "WORKER_CHANGED");
  return { name: task.name, pane: r.agent_pane, tab: r.tab_id, monitor: r.monitor_pane, workspace: run.workspace, kind: task.kind, cwd: task.cwd, model: task.model, effort: task.effort, policy: task.policy, contextWindowTokens: task.contextWindowTokens, receipt: r.receipt_file, generation: r.generation, stage: r.stage,
    ...(r.native_identity ? { terminal: r.native_identity.terminal || undefined, session: r.native_identity.session || undefined } : {}), ...(r.previous_generation ? { previousGeneration: r.previous_generation } : {}) };
}

export function ownedWorkers(run, { issues } = {}) {
  const workers = [...run.workers];
  for (const t of pending(run)) if (!workers.some((w) => w.name === t.name)) {
    try {
      const w = registeredWorker(run, t);
      if (w) workers.push(w);
    } catch (e) {
      if (!issues) throw e;
      issues.push({ task: t.id, name: t.name, pane: t.pane, error: e.message.slice(0, 400) });
    }
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
