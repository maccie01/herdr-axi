import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { runDir, runError, changeRun, pending, controlActive } from "./run-state.mjs";
import { stateRoot, hash, DEFAULT_CONFIG, writerLease, hasRunLeases } from "./project.mjs";

export const projectRuns = (project) => path.join(stateRoot(), "projects", hash(project), "runs");
const regular = (file) => { try { return fs.lstatSync(file).isFile(); } catch (e) { if (e.code === "ENOENT") return false; throw e; } };

// Finished runs only: crashed watches/controls must not pin archives forever.
// Unknown files and live/unverifiable PIDs remain untouched; never follow links.
function cleanupControls(dir) {
  const candidates = [], operations = path.join(dir, "operations");
  const watch = path.join(dir, "watch.json");
  if (regular(watch)) try { candidates.push([watch, JSON.parse(fs.readFileSync(watch, "utf8"))?.pid]); } catch { /* retain corrupt evidence */ }
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^watch\.json\.([1-9][0-9]*)\.tmp$/);
    if (match) candidates.push([path.join(dir, name), Number(match[1])]);
  }
  const directory = fs.existsSync(operations) && fs.lstatSync(operations).isDirectory();
  if (directory) for (const name of fs.readdirSync(operations)) {
    const pid = name.match(/^([1-9][0-9]*)(?:\.[a-f0-9-]{36})?$/)?.[1];
    if (pid) candidates.push([path.join(operations, name), Number(pid)]);
  }
  for (const [file, pid] of candidates) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !regular(file)) continue;
    if (!controlActive(file, pid)) fs.rmSync(file, { force: true });
  }
  if (directory) try { fs.rmdirSync(operations); } catch (e) { if (!["ENOTEMPTY", "ENOENT", "EEXIST"].includes(e.code)) throw e; }
}
export function history(run, taskId) {
  let detail = run;
  if (taskId && run.finishedAt && regular(path.join(runDir(), "detail.json.gz"))) detail = JSON.parse(gunzipSync(fs.readFileSync(path.join(runDir(), "detail.json.gz")), { maxOutputLength: 100000000 }));
  const tasks = detail.tasks.filter((t) => !taskId || t.id === taskId);
  if (taskId && !tasks.length) throw runError("Unknown task ID");
  return { run: run.id, project: run.project, ...(run.finishedAt ? { finished: run.finishedAt } : {}),
    ...(run.ownerHandoffs?.length ? { ownerHandoffs: run.ownerHandoffs.map((h) => ({ at: h.at, from: h.from.pane, to: h.to.pane, evidence: h.evidence.slice(0, 600) })) } : {}),
    ...(taskId && tasks[0]?.resultSource ? { resultSource: tasks[0].resultSource } : {}),
    ...(taskId && tasks[0]?.cancellation ? { cancellation: { at: tasks[0].cancellation.at, evidence: tasks[0].cancellation.evidence.slice(0, 1000), capture: tasks[0].cancellation.capture } } : {}),
    tasks: tasks.slice(-8).map((t) => ({ task: t.id, phase: t.phase, role: t.role || t.kind, state: t.state, cwd: t.cwd, area: t.area, ...(t.summary && !(taskId && t.result) ? { summary: t.summary } : {}), ...(t.evidence ? { evidence: t.evidence } : {}), ...(t.commit ? { commit: t.commit } : {}), ...(taskId ? { prompt: t.prompt?.slice(0, 4000) || "(detail expired)", ...(t.prompt?.length > 4000 ? { truncated: true } : {}), ...(t.result ? { result: t.result.slice(0, 3500) } : {}), revisions: (t.revisions ?? []).map((v) => ({ at: v.at, prompt: v.prompt.slice(0, 1000), summary: v.summary })) } : {}) })),
    ...(taskId && tasks[0]?.handoffs?.length ? { handoffs: tasks[0].handoffs.map((h) => ({ at: h.at, from: h.from.kind, to: h.to.kind, model: h.to.model, quota: h.quota.scope, state: h.state, summary: h.summary.slice(0, 600), capture: h.capture })) } : {}),
    ...(tasks.length > 8 ? { more: tasks.length - 8 } : {}), events: (detail.events ?? []).filter((e) => !taskId || e.task === taskId).slice(-8),
    help: [tasks.length && !taskId ? `herdr-axi run history --task ${tasks.at(-1).id}` : "herdr-axi run history --all"] };
}

export function projectHistory(project) {
  const root = projectRuns(project);
  const runs = [];
  if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    try {
      const dir = path.join(root, entry.name), r = JSON.parse(fs.readFileSync(path.join(dir, "run.json")));
      if (r.schema === 1 && r.project === project) runs.push({ run: dir, created: r.createdAt, state: r.finishedAt ? "archived" : "active", tasks: r.tasks.length });
    } catch { /* partial creation is not a run */ }
  }
  runs.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return { project, runs: runs.slice(0, 8), ...(runs.length > 8 ? { more: runs.length - 8 } : {}), help: ["Select a listed run with HERDR_AXI_RUN, then: herdr-axi run history"] };
}

export function finishRun() {
  const dir = runDir();
  const result = changeRun((r) => {
    if (r.finishedAt) return { finished: r.finishedAt, archived: true };
    if (pending(r).length || r.tasks.some((t) => t.state === "queued") || r.workers.some((w) => !w.closed)) throw runError("Finish requires accepted/cancelled tasks and closed owned workers", "RUN_ACTIVE");
    // These tasks are already terminal. Repair owned reservations before
    // archiving; an unverifiable lease leaves finish retryable and visible.
    for (const t of r.tasks) writerLease(r, t, true);
    r.finishedAt = new Date().toISOString();
    const archive = path.join(dir, "detail.json.gz");
    const inboxes = {};
    for (const w of r.workers) {
      const expected = path.join(dir, "receipts", r.workspace, `${w.name}.event`);
      if (w.receipt !== expected || !/^axi-[a-z0-9-]+$/.test(w.name) || !regular(expected + ".inbox")) continue;
      if (fs.statSync(expected + ".inbox").size > 1048576) throw runError("Inbox exceeds archive safety limit; preserve it explicitly before finish", "RESULT_UNAVAILABLE");
      inboxes[w.name] = fs.readFileSync(expected + ".inbox", "utf8");
    }
    fs.writeFileSync(archive + ".tmp", gzipSync(JSON.stringify({ ...r, inboxes })), { mode: 0o600 });
    fs.renameSync(archive + ".tmp", archive);
    if (r.ownerHandoffs) r.ownerHandoffs = r.ownerHandoffs.map(({ output, ...h }) => ({ ...h, evidence: h.evidence.slice(0, 600) }));
    for (const t of r.tasks) {
      delete t.prompt; delete t.revisions; delete t.result;
      if (t.handoffs) t.handoffs = t.handoffs.map(({ output, gitStatus, ...h }) => ({ ...h, summary: h.summary.slice(0, 600) }));
      if (t.cancellation) { delete t.cancellation.output; delete t.cancellation.gitStatus; }
    }
    r.events = (r.events ?? []).slice(-32);
    return { finished: r.finishedAt, archived: true, detailDays: (r.config ?? DEFAULT_CONFIG).retention.detailDays, summaryDays: (r.config ?? DEFAULT_CONFIG).retention.summaryDays };
  }, { allowFinished: true });
  // Only generated paths, after the archive is durable. No repository scans,
  // recursive deletions, symlink traversal, or cleanup of unknown files.
  const r = JSON.parse(fs.readFileSync(path.join(dir, "run.json")));
  cleanupControls(dir);
  const files = [path.join(dir, "context.json"), ...r.tasks.filter((t) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(t.id)).map((t) => path.join(dir, `task-${t.id}.txt`))];
  for (const w of r.workers) {
    const expected = path.join(dir, "receipts", r.workspace, `${w.name}.event`);
    if (w.receipt !== expected || !/^axi-[a-z0-9-]+$/.test(w.name) || !/^[a-zA-Z0-9]+$/.test(r.workspace)) continue;
    files.push(expected, expected + ".inbox", expected + ".monitor-error", path.join(path.dirname(expected), w.name + ".json"), path.join(path.dirname(expected), w.name + ".task"));
    if (/^[a-zA-Z0-9]+$/.test(w.generation)) files.push(`${expected}.proof.${w.generation}`);
  }
  let removed = 0;
  for (const file of files) if (regular(file)) { fs.unlinkSync(file); removed++; }
  if (/^[a-zA-Z0-9]+$/.test(r.workspace)) for (const folder of [path.join(dir, "receipts", r.workspace), path.join(dir, "receipts")]) {
    try { if (fs.lstatSync(folder).isDirectory() && !fs.readdirSync(folder).length) fs.rmdirSync(folder); }
    catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTEMPTY") throw e; }
  }
  return { ...result, removedRuntimeFiles: removed, help: ["herdr-axi run history"] };
}

// Opportunistic GC on init/finish; finished records only, within one hashed
// project store. Unknown files keep their directory; active runs never expire.
export function collectArchives(project, now = Date.now()) {
  if (!project) return { detailsRemoved: 0, summariesRemoved: 0 };
  const root = projectRuns(project);
  if (!fs.existsSync(root)) return { detailsRemoved: 0, summariesRemoved: 0 };
  let detailsRemoved = 0, summariesRemoved = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name), record = path.join(dir, "run.json");
    if (!regular(record) || fs.existsSync(path.join(dir, "run.lock")) || fs.existsSync(path.join(dir, "run.unlock"))) continue;
    let r;
    try { r = JSON.parse(fs.readFileSync(record)); } catch { continue; }
    if (r.schema !== 1 || r.project !== project || r.storage !== "managed" || !r.finishedAt || !Array.isArray(r.tasks) || !Array.isArray(r.workers) || r.tasks.some((t) => !["accepted", "cancelled"].includes(t.state)) || r.workers.some((w) => !w.closed)) continue;
    if (hasRunLeases(r, dir)) continue;
    const age = (now - Date.parse(r.finishedAt)) / 86400000;
    const policy = r.config?.retention ?? DEFAULT_CONFIG.retention;
    if (!Number.isInteger(policy.detailDays) || !Number.isInteger(policy.summaryDays) || policy.detailDays < 1 || policy.summaryDays < policy.detailDays) continue;
    const detail = path.join(dir, "detail.json.gz");
    try {
      cleanupControls(dir);
      if (age > policy.detailDays && regular(detail)) { fs.unlinkSync(detail); detailsRemoved++; }
      if (age > policy.summaryDays && fs.readdirSync(dir).every((n) => n === "run.json")) { fs.unlinkSync(record); fs.rmdirSync(dir); summariesRemoved++; }
    } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTEMPTY") throw e; }
  }
  return { detailsRemoved, summariesRemoved };
}
