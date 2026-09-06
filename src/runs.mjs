import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runHerdr, listAgents, requireHerdrEnv, projectAgent } from "./herdr.mjs";
import { PHASES, runError, runDir, loadRun, changeRun, pending, limit, receipt, registeredWorker, ownedWorkers, takeRunWarnings, processStart, controlActive, taskFor } from "./run-state.mjs";
import { projectConfig, validateConfig, worktree, nativeSlots, workerRoleSummary, writerLease, leasePath, leaseStatus, hash, DEFAULT_CONFIG } from "./project.mjs";
import { projectRuns, projectHistory, history, finishRun, collectArchives } from "./archive.mjs";
import { contextStatus } from "./context.mjs";
import { quotaError, switchHelp } from "./quota.mjs";

const engine = fileURLToPath(new URL("../engine/herdr-orchestrator.sh", import.meta.url));
const idOK = (id) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(id ?? "");
const liveAgent = (pane) => runHerdr(["agent", "get", pane]).agent;
const callerPane = () => process.env.HERDR_PANE_ID || runHerdr(["pane", "current", "--current"]).pane?.pane_id;
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

function taskPrompt(o) {
  if ((o.prompt !== undefined) === (o["prompt-file"] !== undefined)) throw runError("Provide exactly one of --prompt TEXT or --prompt-file PATH");
  const prompt = o.prompt ?? fs.readFileSync(o["prompt-file"], "utf8");
  if (!prompt.trim() || Buffer.byteLength(prompt) > 64000) throw runError("Task prompt must be nonempty and at most 64KB");
  return prompt;
}

function taskLocation(cwd, relativeArea) {
  cwd = fs.realpathSync(cwd);
  if (!fs.statSync(cwd).isDirectory()) throw runError("--cwd must be a directory");
  const area = path.resolve(cwd, relativeArea);
  if (cwd !== area && !area.startsWith(cwd + path.sep)) throw runError("--area must be within --cwd");
  const tree = worktree(cwd);
  const state = fs.realpathSync(runDir());
  if (state === tree || state.startsWith(tree + path.sep)) throw runError("Worker worktree must not contain run state", "STATE_IN_PROJECT");
  return { cwd, area, worktree: tree };
}
const launcherAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
};

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
function beginControl(action) {
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

function assertQuiescent(run) {
  const folder = path.join(runDir(), "operations");
  if (fs.existsSync(folder)) for (const name of fs.readdirSync(folder)) {
    const pid = name.match(/^([1-9][0-9]*)(?:\.[a-f0-9-]{36})?$/)?.[1];
    if (!pid || controlActive(path.join(folder, name), Number(pid))) throw runError(`Run control active or identity unverifiable: ${path.join(folder, name)}. Inspect identity; do not blindly retry or delete the marker.`, "RUN_BUSY", [`cat ${quote(path.join(folder, name))}`, ...(pid ? [`ps -p ${pid} -o pid=,lstart=,command=`] : []), "herdr-axi run takeover --help"]);
    fs.rmSync(path.join(folder, name), { force: true });
  }
  if (pending(run).some((t) => ["starting", "switching", "cancelling"].includes(t.state) && launcherAlive(t.launcher))) throw runError("Launcher still active; wait for it before takeover", "RUN_BUSY");
}

function unlockRun() {
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

function safeWorker(run, worker, rows, { observe = false } = {}) {
  try {
    if (!worker || worker.closed) throw runError("Pane is not a live owned worker", "NOT_OWNED");
    if ([run.owner, ...(run.ownerHandoffs ?? []).map((h) => h.from)].some((o) => worker.pane === o.pane || worker.tab === o.tab) || worker.pane === process.env.HERDR_PANE_ID || worker.tab === process.env.HERDR_TAB_ID)
      throw runError("Refusing an operation on the orchestrator or its tab", "SELF_TARGET");
    const a = rows.find((a) => a.pane === worker.pane);
    if (a && (a.workspace !== run.workspace || a.tab !== worker.tab || a.backendName !== worker.name || (worker.terminal && a.terminal !== worker.terminal) || (worker.session && a.session !== worker.session)))
      throw runError("Worker identity changed", "WORKER_CHANGED");
    return a;
  } catch (e) {
    if (observe && ["NOT_OWNED", "SELF_TARGET", "WORKER_CHANGED"].includes(e.code)) return null;
    throw e;
  }
}

// Retry publication only, never the engine call or prompt delivery.
async function publishRun(fn) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { return changeRun(fn); }
    catch (e) { if (e.code !== "RUN_BUSY" || Date.now() >= deadline) throw e; }
    await delay(50);
  }
}

function engineCall(args, run) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [engine, ...args], {
      cwd: runDir(),
      env: { ...process.env, HERDR_ENV: "1", HERDR_RECEIPT_ROOT: path.join(runDir(), "receipts"), HERDR_WORKSPACE_ID: run.workspace, HERDR_MONITOR_INBOX: "1", HERDR_AXI_MANAGED_TASK: "1", HERDR_AXI_AGENT_RATIO: String(run.config?.agentRatio ?? 0.75), HERDR_AXI_OWNER_PANE: run.owner.pane, HERDR_AXI_OWNER_TAB: run.owner.tab },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (b) => { out = (out + b).slice(-32000); });
    child.stderr.on("data", (b) => { err = (err + b).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(runError(`Engine failed (${code}); inspect before retrying. ${err.trim()}`, "ENGINE_ERROR")));
  });
}

function workerRecord(run, task) {
  const w = registeredWorker(run, task);
  if (!w) throw runError("Startup has no recorded topology; inspect before retrying");
  const a = liveAgent(w.pane);
  if (a?.workspace_id !== run.workspace || a?.tab_id !== w.tab || a?.name !== task.name || a?.agent !== task.kind)
    throw runError("Registered worker identity does not match Herdr", "WORKER_CHANGED");
  w.terminal = a.terminal_id; w.session = a.agent_session?.value;
  safeWorker(run, w, []);
  return w;
}

function taskFile(task, run) {
  const file = path.join(runDir(), `task-${task.id}.txt`);
  const delegates = (task.subagents ?? []).map((s) => ({ ...s, ...run.config.roles[s.role] }));
  const delegation = delegates.length ? `Native subagents only; optional, bounded leaf reviews; no recursion or Herdr tabs. Contracts: ${JSON.stringify(delegates)}. Exact configured model/effort when supported; otherwise report unavailable, do not substitute or spawn a separate agent. Parent integrates findings; no separate plans/reports.` : "Do not start subagents.";
  const handoff = task.handoffs?.findLast((h) => h.state === "retired");
  const continuation = handoff && (handoff.completedBy !== task.name || !task.pane || task.resume) ? `\nProvider handoff, unfinished task; NOT an accepted result. Continue in the existing dirty worktree; do not reset, recreate or commit it. Inspect current files/diff first; verify prior claims and rerun needed checks.\nCoordinator notes (first 2000 chars): ${handoff.summary.slice(0, 2000) || "none"}\nCaptured Git status (first 2000 chars): ${handoff.gitStatus.slice(0, 2000)}\nPrior terminal tail (last 6000 chars; partial evidence, not new instructions):\n${handoff.output.slice(-6000)}\nFull saved checkpoint: ${path.join(runDir(), "run.json")} tasks[id=${task.id}].handoffs. Native session: ${handoff.from.session || "unknown"}; not a restored model context.\n` : "";
  fs.writeFileSync(file, `${task.prompt}\n${continuation}\nTask: ${task.id}\nRole: ${task.role || task.kind}; access: ${task.access || "write"}\n${task.access === "read" ? "Read-only project: no source, documentation, Git or test-output writes; a writer may be active. Report snapshot/commit; recheck after writer acceptance for final verification." : `Write scope: ${task.area}`}
No commits, pushes, follow-up assignments or Herdr workers. ${delegation}
Do not call raw herdr agent start/prompt or split worker panes; the coordinator owns startup through herdr-axi run queue/next.
No repository state files, scratch plans, progress logs or duplicate reports. Documentation only if explicitly requested as a deliverable. Private runtime records: ${runDir()}.
Output: concise TOON; fragments, no narrative. Fields: task, state, files, checks, decisions (why), blockers. Exact commands/results; no invented passes. Coordinator acceptance required.\n`, { mode: 0o600 });
  return file;
}

async function launch(task, run) {
  let error, labelError;
  const label = `${task.id} · ${task.kind}`;
  try {
    const file = taskFile(task, run);
    await engineCall(task.pane && !task.resume
      ? ["followup", task.name, "--prompt-file", file]
      : ["start", ...(task.resume ? ["--resume"] : []), "--name", task.name, "--label", label, "--kind", task.kind, ...(task.model ? ["--model", task.model, "--effort", task.effort] : []), "--cwd", task.cwd, "--prompt-file", file, "--workspace", run.workspace, "--orchestrator-agent", run.owner.pane], run);
  } catch (e) { error = e; }
  let worker;
  try { worker = workerRecord(run, task); } catch (e) { error ??= e; }
  try {
    await publishRun((r) => {
      const t = r.tasks.find((t) => t.id === task.id);
      t.state = error ? "uncertain" : "running";
      if (error) t.error = error.message.slice(0, 600); else delete t.error;
      if (worker) {
        t.pane = worker.pane;
        r.workers = [...r.workers.filter((w) => w.pane !== worker.pane), worker];
      }
    });
  } catch (e) {
    return { task: task.id, ...(worker ? { pane: worker.pane } : {}), state: "uncertain", delivery: "record_pending", error: e.message.slice(0, 600), note: "Worker registry retained. Inspect, then recover; do not resend the prompt.", help: [`herdr-axi run recover ${task.id}`] };
  }
  // Publish first. Cosmetics get a small, separate budget and use the newly
  // verified identity, not the previous assignment's session.
  if (!error && task.pane && worker) {
    try {
      const fresh = projectAgent(runHerdr(["agent", "get", worker.pane], { timeoutMs: 750 }).agent);
      if (!safeWorker(run, worker, [fresh])) throw runError("Cannot relabel an absent worker", "WORKER_CHANGED");
      runHerdr(["tab", "rename", worker.tab, label], { timeoutMs: 750 });
    } catch (e) { labelError = e.message.slice(0, 300); }
  }
  const startup = error && worker?.stage === "created";
  const blocked = startup && error.message.includes("agent_not_ready");
  let startupOutput;
  if (startup) {
    try { startupOutput = runHerdr(["agent", "read", worker.pane, "--source", "visible", "--lines", "24"], { timeoutMs: 1000, text: true }).slice(-2400); }
    catch { /* diagnostic only; recorded startup remains recoverable */ }
  }
  return { task: task.id, ...(worker ? { pane: worker.pane } : {}), state: blocked ? "blocked" : error ? "uncertain" : "running", ...(error ? { error: error.message.slice(0, 600) } : {}), ...(labelError ? { labelError } : {}),
    ...(startup ? { submitted: false, ...(startupOutput ? { startupOutput, startupLimit: "last 24 lines / 2400 characters; expand only if insufficient" } : {}), note: "Startup needs attention. Inspect the dialog; approve only with authorization, then recover once idle. No automatic trust or updates.", help: [`herdr-axi read ${worker.pane} --raw --lines 60 --chars 8000`, `herdr-axi run recover ${worker.pane}`] } : {}) };
}

export function runStatus() {
  const run = loadRun();
  if (!run) throw runError("Select a run with HERDR_AXI_RUN", "RUN_REQUIRED");
  if (run.finishedAt) return { finished: run.finishedAt, complete: true, help: ["herdr-axi run history"] };
  const rows = listAgents({ all: true });
  const issues = [];
  const workers = ownedWorkers(run, { issues });
  const tasks = pending(run).map((t) => {
    const w = workers.find((w) => (t.pane ? w.pane === t.pane : w.name === t.name) && !w.closed);
    const a = w ? safeWorker(run, w, rows, { observe: true }) : null;
    let current;
    try { current = !w || w.stage === "created" ? registeredWorker(run, t) : null; }
    catch (e) { return { task: t.id, pane: w?.pane ?? t.pane ?? rows.find((a) => a.backendName === t.name && a.workspace === run.workspace)?.pane ?? "pending", state: "unverified", error: e.message.slice(0, 300) }; }
    const stage = w?.stage === "created"
      ? (current?.pane === w.pane && current?.tab === w.tab ? current.stage : undefined) : w?.stage;
    const state = ["switching", "cancelling"].includes(t.state) ? t.state : a?.state === "blocked" ? "blocked" : t.state === "starting" && launcherAlive(t.launcher) ? "starting" : w && !a ? "lost" : a?.state ?? (t.state === "starting" ? "uncertain" : t.state);
    const complete = t.state === "running" && w && receipt(w)?.complete && ["idle", "done"].includes(state);
    return { task: t.id, pane: w?.pane ?? t.pane ?? "pending", state: complete ? "review" : state, ...(stage === "created" ? { delivery: "not_submitted" } : t.state === "uncertain" ? { delivery: "uncertain" } : {}) };
  });
  const queued = run.tasks.filter((t) => t.state === "queued");
  const parked = run.workers.filter((w) => !w.closed && !pending(run).some((t) => t.pane === w.pane)).map((w) => w.pane);
  const parkedAttention = run.workers.filter((w) => parked.includes(w.pane)).flatMap((w) => {
    const live = safeWorker(run, w, rows, { observe: true });
    return live && ["idle", "done"].includes(live.state) ? [] : [{ pane: w.pane, state: live?.state ?? "unverified", help: live ? `herdr-axi read ${w.pane} --raw` : `env HERDR_AXI_RUN= herdr-axi read ${w.pane} --raw` }];
  });
  const verified = rows.filter((a) => workers.some((w) => w.pane === a.pane && !w.closed && safeWorker(run, w, rows, { observe: true })));
  const context = run.config ? contextStatus(run, workers, verified) : null;
  for (const t of tasks) {
    const quota = context?.quotas.find((q) => q.pane === t.pane);
    if (quota && !["review", "switching", "cancelling"].includes(t.state)) { t.state = "blocked"; t.quota = quota.scope; }
  }
  const exhausted = tasks.find((t) => t.quota);
  const switching = tasks.find((t) => t.state === "switching");
  const cancelling = tasks.find((t) => t.state === "cancelling");
  const blocked = tasks.find((t) => t.state === "blocked");
  const ready = tasks.find((t) => t.delivery === "not_submitted" && ["idle", "done"].includes(t.state));
  return { owner: run.owner.pane, phase: run.phase, capacity: limit(run), occupied: tasks.length, queued: queued.length, tasks,
    ...(run.config ? { nativeReserved: pending(run).reduce((n, t) => n + (t.nativeSlots ?? 0), 0), nativeCapacity: run.config.nativeSubagentLimit } : {}),
    ...(context?.warnings.length ? { contextWarnings: context.warnings, contextAction: "Checkpoint at a safe boundary; review, then replace/compact the accepted worker. Never interrupt unfinished work automatically." } : {}),
    ...(context?.unknown ? { contextUnknown: context.unknown } : {}),
    ...(context?.stale ? { contextStale: context.stale } : {}),
    ...(context?.lastKnown.length ? { contextLastKnown: context.lastKnown } : {}),
    ...(context?.error ? { contextError: context.error } : {}),
    ...(parkedAttention.length ? { parkedAttention } : {}),
    ...(issues.length ? { ownershipIssues: issues.slice(0, 8) } : {}),
    parked,
    ...(!tasks.length && queued.length ? { backlog: queued.slice(0, 8).map((t) => ({ task: t.id, phase: t.phase, after: t.deps })), ...(queued.length > 8 ? { more: queued.length - 8 } : {}) } : {}),
    ...(!tasks.length && !queued.length && !parked.length ? { complete: true } : {}),
    ...(exhausted ? { quota: "Provider capacity exhausted, not task completion. Switch in this run; preserve worktree and lease. No WIP commit or new run needed." } : {}),
    help: cancelling ? [`herdr-axi run cancel ${cancelling.task}`] : exhausted ? switchHelp(run, exhausted.pane, workers.find((w) => w.pane === exhausted.pane)?.kind) : switching ? [`herdr-axi run switch ${switching.task}`] : [blocked ? `herdr-axi read ${blocked.pane} --raw` : ready ? `herdr-axi run recover ${ready.pane}` : parkedAttention[0]?.help ?? (tasks.some((t) => !["working", "starting"].includes(t.state)) ? "herdr-axi run inbox" : context?.warnings.length ? `herdr-axi read ${context.warnings[0].pane}` : queued.length && tasks.length < limit(run) ? "herdr-axi run next" : tasks.length ? "herdr-axi watch" : parked.length ? `herdr-axi run close ${parked[0]}` : run.tasks.length ? "herdr-axi run finish" : "herdr-axi run --help")] };
}

// Compare actionable state, not telemetry timestamps/percentages or display text.
const watchKey = (s) => JSON.stringify({ phase: s.phase, capacity: s.capacity, occupied: s.occupied, queued: s.queued, tasks: s.tasks, parked: s.parked, parkedAttention: s.parkedAttention, ownershipIssues: s.ownershipIssues, finished: s.finished, contextError: s.contextError, contextWarnings: s.contextWarnings?.map(({ pane, level }) => ({ pane, level })) });
const needsAttention = (s) => s.contextWarnings?.length || s.contextError || s.ownershipIssues?.length || s.parkedAttention?.length || s.tasks?.some((t) => !["working", "starting"].includes(t.state));
const waitingNote = "Continue independent work. Use one notification-backed background watch if supported; otherwise wait only when dependent. No inbox/read polling.";

export async function watchRun(timeout = 30000) {
  const selected = loadRun();
  if (!selected?.finishedAt) ownerCheck(selected);
  const file = path.join(runDir() ?? ".", "watch.json");
  changeRun(() => {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw runError("Unverifiable watch record; inspect watch.json", "WATCH_ACTIVE"); }
    if (previous && (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || launcherAlive(previous.pid))) throw runError("One watch is active or its identity is unverifiable; keep the existing job handle and continue independent work", "WATCH_ACTIVE", ["herdr-axi watch --help"]);
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }, { readOnly: true, allowFinished: true });
  try {
    const first = runStatus();
    const attention = async (s, changed, reason) => ({ changed, reason, ...(s.tasks?.some((t) => ["review", "idle", "done"].includes(t.state) || t.quota) && s.owner === callerPane() ? await runCommand("inbox", { _: [] }) : s) });
    if (!first.tasks?.length || needsAttention(first)) return await attention(first, false, "attention");
    const key = watchKey(first);
    let latest = first;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await delay(Math.min(2000, timeout - (Date.now() - start)));
      latest = runStatus();
      if (!latest.finished && latest.owner !== first.owner) return { changed: true, reason: "owner-changed", owner: latest.owner, note: "Stop old-owner supervision; replacement owns this run." };
      if (key !== watchKey(latest)) return await attention(latest, true, "state-change");
    }
    return { changed: false, reason: "timeout", pending: latest.occupied, note: waitingNote, help: latest.help };
  } finally { fs.rmSync(file, { force: true }); }
}

// A bounded queue and a reusable worker pool, not a background scheduler.
// `next` reserves all available slots atomically, then starts them concurrently.
export async function runCommand(action, o) {
  let result, release, cleanupError;
  try {
    if (!["init", "status", "config", "history", "gc", "leases", "takeover", "unlock"].includes(action)) release = beginControl(action);
    result = await executeRunCommand(action, o);
  }
  catch (e) {
    const warnings = takeRunWarnings();
    if (warnings.length) e.message += `; earlier changes committed; maintenance: ${warnings.slice(0, 8).map((w) => w.error).join("; ")}`;
    throw e;
  }
  finally { try { if (release) release(); } catch (e) { cleanupError = { code: "CONTROL_CLEANUP_FAILED", error: e.message.slice(0, 600) }; } }
  const warnings = takeRunWarnings();
  if (cleanupError) warnings.push(cleanupError);
  return warnings.length ? { ...result, committed: true, maintenance: warnings.slice(0, 8), ...(warnings.length > 8 ? { moreMaintenance: warnings.length - 8 } : {}), help: ["herdr-axi run leases", ...(result.help ?? [])] } : result;
}

async function executeRunCommand(action, o) {
  if (!["status", "history", "config", "gc", "leases", "recover"].includes(action)) requireHerdrEnv();
  if (action === "init") {
    if (process.env.HERDR_AXI_WORKER === "1") throw runError("Managed workers cannot become nested orchestrators", "NESTED_RUN");
    const caller = callerPane();
    const ownerPane = o.owner ?? caller;
    if (!ownerPane) throw runError("init needs a resolvable caller pane");
    if (caller !== ownerPane) throw runError("--owner must be this pane", "SELF_TARGET");
    const a = liveAgent(ownerPane);
    if (a?.pane_id !== ownerPane || !a.workspace_id || !a.tab_id) throw runError("Owner must be an exact live pane ID");
    const project = projectConfig(o.project || process.cwd());
    let dir = o.dir ? path.resolve(o.dir) : path.join(projectRuns(project.project), randomUUID());
    if (dir === project.project || dir.startsWith(project.project + path.sep)) throw runError("Run state must be outside the project/worktree; omit --dir for managed storage", "STATE_IN_PROJECT");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    dir = fs.realpathSync(dir);
    if (dir === project.project || dir.startsWith(project.project + path.sep)) throw runError("Run state resolves inside the project/worktree", "STATE_IN_PROJECT");
    const run = { schema: 1, id: randomUUID().slice(0, 8), ...project, storage: o.dir ? "explicit" : "managed", createdAt: new Date().toISOString(), workspace: a.workspace_id, owner: { pane: ownerPane, tab: a.tab_id, terminal: a.terminal_id, session: a.agent_session?.value }, phase: "explore", limits: { ...project.config.phases }, tasks: [], workers: [] };
    try { fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (e) { if (e.code === "EEXIST") throw runError("Run already exists; select it, do not overwrite it"); throw e; }
    const roles = workerRoleSummary(run.config);
    return { run: dir, owner: ownerPane, workspace: run.workspace, project: project.project, config: project.configFile || "defaults", phase: run.phase, capacity: limit(run), ...roles, cleanup: collectArchives(project.project),
      queue: 'herdr-axi run queue TASK --role ROLE --cwd WORKTREE --area AREA --prompt "task and checks"',
      note: "Replace queue placeholders; inline task and checks, no project task file. Roles/policy already loaded, no config/fleet/layout preflight. Then herdr-axi run next.",
      help: [`export HERDR_AXI_RUN='${dir.replaceAll("'", "'\\''")}'`, ...(roles.moreRoles ? ["herdr-axi run config --full"] : [])] };
  }
  const run = loadRun();
  if (!run) throw runError("Initialize/select a run first", "RUN_REQUIRED");
  if (action === "status") return runStatus();
  if (action === "config") {
    const config = run.config ?? DEFAULT_CONFIG;
    return { project: run.project, source: run.configFile || "defaults",
      ...(o.full ? { config } : { ...workerRoleSummary(config), phase: run.phase, capacity: limit(run), nativeSubagentLimit: config.nativeSubagentLimit, sharedReadWorktree: config.sharedReadWorktree }),
      note: "Init snapshot; read-only/native child limits are instructions, not a sandbox. Owner model is a launch contract, never changed here.",
      help: [o.full ? "herdr-axi run queue --help" : "herdr-axi run config --full"] };
  }
  if (action === "history") {
    if (o.all && o.task) throw runError("history --all and --task conflict");
    return o.all ? projectHistory(run.project || worktree(process.cwd())) : history(run, o.task);
  }
  if (action === "gc") return collectArchives(run.project);
  if (action === "leases") return leaseStatus(run);
  if (action === "recover") {
    const task = taskFor(run, o._[0]);
    if (task && ["accepted", "cancelled"].includes(task.state)) {
      if (!run.finishedAt) { requireHerdrEnv(); ownerCheck(run); }
      return changeRun((r, { afterCommit }) => {
        const current = r.tasks.find((t) => t.id === task.id);
        if (current.state !== task.state) throw runError("Task changed; retry");
        const result = { task: task.id, leaseReleased: false, file: leasePath(current) };
        afterCommit.push(() => { result.leaseReleased = writerLease(r, current, true); if (result.leaseReleased) result.releasedLease = task.id; });
        return result;
      }, { allowFinished: true });
    }
    requireHerdrEnv();
  }
  if (run.finishedAt && action !== "finish") throw runError("Archived run is read-only; initialize a new run", "RUN_FINISHED");
  if (action === "takeover") {
    if (process.env.HERDR_AXI_WORKER === "1") throw runError("Workers cannot take over their supervisor", "NESTED_RUN");
    if (o.from !== run.owner.pane || !o.evidence?.trim() || o.evidence.length > 4000)
      throw runError("Takeover requires --from <current-owner-pane> and --evidence (1..4000 chars): authorization and remaining work", "INVALID_TAKEOVER", ["herdr-axi run takeover --help"]);
    if ((run.ownerHandoffs?.length ?? 0) >= 8) throw runError("Eight owner transfers reached; inspect the run", "TAKEOVER_LIMIT");
    const pane = callerPane(), a = liveAgent(pane);
    if (!a || a.pane_id !== pane || a.workspace_id !== run.workspace || !a.tab_id || !a.terminal_id || !["claude", "codex", "copilot"].includes(a.agent)) throw runError("Replacement must be a live agent in the same workspace", "INVALID_TAKEOVER");
    if (pane === run.owner.pane || a.tab_id === run.owner.tab || ownedWorkers(run).some((w) => !w.closed && (w.pane === pane || w.tab === a.tab_id))) throw runError("Replacement must be a separate non-worker pane/tab", "SELF_TARGET");
    let old, quota, output = "", absent = false;
    try { old = liveAgent(run.owner.pane); }
    catch (e) { if (e.code !== "UNKNOWN_AGENT") throw e; }
    if (old?.agent) {
      if (old.workspace_id !== run.workspace || old.tab_id !== run.owner.tab || (run.owner.terminal && old.terminal_id !== run.owner.terminal) || (run.owner.session && old.agent_session?.value !== run.owner.session)) throw runError("Previous owner identity changed; do not adopt its replacement", "OWNER_CHANGED");
      if (old.agent_status === "working") throw runError("Previous owner is still working", "OWNER_BUSY");
      output = runHerdr(["agent", "read", run.owner.pane, "--source", "visible", "--lines", "60"], { timeoutMs: 2000, text: true });
      quota = quotaError(output);
      if (!quota) throw runError("Previous owner has no current quota error", "QUOTA_NOT_CONFIRMED");
      try { output = runHerdr(["agent", "read", run.owner.pane, "--source", "recent-unwrapped", "--lines", "2000"], { timeoutMs: 3000, text: true }); } catch { /* visible checkpoint remains */ }
    } else {
      // Agent-not-found alone may mean a different occupant or a transient gap.
      try { runHerdr(["pane", "get", run.owner.pane]); throw runError("Old pane still exists without a verified owner; inspect it", "OWNER_CHANGED"); }
      catch (e) { if (e.code !== "UNKNOWN_AGENT") throw e; absent = true; }
    }
    const owner = { pane, tab: a.tab_id, terminal: a.terminal_id, session: a.agent_session?.value };
    const identity = (a) => JSON.stringify([a?.pane_id, a?.workspace_id, a?.tab_id, a?.terminal_id, a?.agent_session?.value, a?.agent, a?.name]);
    if (identity(liveAgent(pane)) !== identity(a)) throw runError("Replacement identity changed while checkpointing", "OWNER_CHANGED");
    if (!absent) {
      const fresh = liveAgent(run.owner.pane);
      if (identity(fresh) !== identity(old) || fresh?.agent_status === "working") throw runError("Previous owner changed or resumed while checkpointing", "OWNER_CHANGED");
    }
    if (fs.existsSync(path.join(runDir(), "run.lock"))) unlockRun();
    changeRun((r) => {
      if (JSON.stringify(r.owner) !== JSON.stringify(run.owner)) throw runError("Owner changed concurrently", "OWNER_CHANGED");
      assertQuiescent(r);
      (r.ownerHandoffs ??= []).push({ at: new Date().toISOString(), from: r.owner, to: owner, evidence: o.evidence, quota, absent, output: output.slice(-32000), truncated: true });
      r.owner = owner;
      (r.events ??= []).push({ at: new Date().toISOString(), action: "takeover", from: run.owner.pane, to: pane });
    });
    return { owner: pane, previous: run.owner.pane, phase: run.phase, pending: pending(run).length, queued: run.tasks.filter((t) => t.state === "queued").length,
      note: "Same run, tasks, receipts and leases. Previous owner fenced from CLI controls, never closed or sent input; old external jobs are not stopped. Review the checkpoint and inbox before dispatching. No automatic billing change.",
      checkpoint: { evidence: o.evidence, output: output.slice(-4000), truncated: true }, help: ["herdr-axi run inbox"] };
  }
  if (action === "inbox") {
    ownerCheck(run);
    let status = runStatus();
    // Native hooks can precede the final idle snapshot/session metadata. Pull
    // late proofs on demand instead of waiting for another lifecycle change.
    const late = status.tasks.filter((t) => ["idle", "done"].includes(t.state) || t.quota)
      .map((t) => run.workers.find((w) => w.pane === t.pane))
      .filter((w) => w && fs.existsSync(`${w.receipt}.proof.${w.generation}`));
    const collected = await Promise.allSettled(late.map((w) => engineCall(["collect", w.name], run)));
    const errors = collected.flatMap((r, i) => r.status === "rejected" ? [{ pane: late[i].pane, error: r.reason.message.slice(0, 300) }] : []);
    if (late.length) status = runStatus();
    const events = [];
    for (const t of pending(run)) {
      const w = run.workers.find((w) => w.pane === t.pane && !w.closed);
      if (!w) continue;
      try {
        const e = JSON.parse(fs.readFileSync(`${w.receipt}.inbox`, "utf8"));
        if (e.generation === w.generation) events.push({ task: t.id, pane: w.pane, event: e.event, summary: String(e.summary).slice(0, 600), ...(e.quota?.code === "QUOTA_EXHAUSTED" ? { reportedQuota: e.quota.scope } : {}), ...(e.truncated ? { truncated: true } : {}) });
      } catch (e) { if (e.code !== "ENOENT") errors.push({ pane: w.pane, error: e.message.slice(0, 300) }); }
      try {
        const notice = fs.readFileSync(`${w.receipt}.monitor-error`, "utf8");
        if (notice.startsWith(`${w.generation}\t`) || notice.startsWith("-\t")) errors.push({ pane: w.pane, error: notice.split("\t").slice(1).join("\t").trim().slice(0, 300) });
      } catch (e) { if (e.code !== "ENOENT") errors.push({ pane: w.pane, error: e.message.slice(0, 300) }); }
    }
    if (!events.length && !errors.length && status.occupied && !needsAttention(status))
      return { events: [], pending: status.occupied, queued: status.queued, note: waitingNote, help: status.help };
    const first = status.tasks.find((t) => t.state === "blocked") ?? status.tasks.find((t) => !["working", "starting"].includes(t.state) && t.pane !== "pending");
    const report = events.find((e) => e.pane === first?.pane);
    const quotaEvent = events.find((e) => e.reportedQuota && status.tasks.some((t) => t.pane === e.pane && !["working", "starting", "review"].includes(t.state)));
    const help = status.tasks.some((t) => t.quota || t.state === "switching") ? status.help : quotaEvent ? switchHelp(run, quotaEvent.pane, run.workers.find((w) => w.pane === quotaEvent.pane)?.kind) : errors.length ? [`herdr-axi read ${errors[0].pane} --raw`, "herdr-axi run --help"]
      : first?.state === "review" && report ? [report.truncated ? `herdr-axi read ${first.pane}` : `herdr-axi run accept ${first.pane} --evidence "<verified checks>"`]
      : ["lost", "unverified"].includes(first?.state) ? ["herdr-axi agents --all", "herdr-axi run --help"]
      : first ? [`herdr-axi read ${first.pane} --raw`] : status.help;
    return { ...status, events, ...(errors.length ? { errors: errors.slice(0, 8), ...(errors.length > 8 ? { moreErrors: errors.length - 8 } : {}), note: "Collection/report error: inspect and repair before acceptance; do not repeatedly fetch the same error." } : report ? { note: "Review result/checks, then accept or revise. Read only if evidence is insufficient; do not re-fetch the same report." } : {}), help };
  }
  ownerCheck(run);
  if (action === "finish") return { ...finishRun(), cleanup: collectArchives(run.project) };
  if (action === "unlock") return unlockRun();
  if (action === "queue") {
    const id = o._[0];
    const role = o.role ? (run.config ?? DEFAULT_CONFIG).roles[o.role] : null;
    if (o.role && (!role || o.role === "orchestrator" || (o.kind && o.kind !== role.kind))) throw runError("Unknown/owner role or conflicting --kind", "CONFIG_INVALID");
    const kind = role?.kind ?? o.kind;
    if (!idOK(id) || !["claude", "codex", "copilot"].includes(kind) || !o.cwd || !o.area) throw runError("queue needs a short task ID, --role or --kind, --cwd, --area and --prompt TEXT or --prompt-file PATH");
    const location = taskLocation(o.cwd, o.area);
    const prompt = taskPrompt(o);
    const deps = o.after ? o.after.split(",") : [];
    changeRun((r) => {
      if (r.tasks.length >= 128 || r.tasks.some((t) => t.id === id)) throw runError("Duplicate task ID or 128-task run limit");
      if (deps.some((id) => !r.tasks.some((t) => t.id === id))) throw runError("Dependencies must reference existing tasks");
      r.tasks.push({ id, ...(role || {}), kind, role: o.role, policy: hash(JSON.stringify(role || { kind, access: "write" })), access: role?.access ?? "write", nativeSlots: role ? nativeSlots(role) : 0, ...location, prompt, deps, phase: r.phase, state: "queued" });
    });
    return { queued: id, cwd: location.cwd, area: location.area, help: ["herdr-axi run next"] };
  }
  if (action === "move") {
    if (!o.cwd) throw runError("move requires --cwd pointing to an existing isolated worktree");
    const original = run.tasks.find((t) => t.id === o._[0]);
    if (!original || original.state !== "queued" || original.name || original.pane) throw runError("Only queued tasks without registered resources can move");
    const location = taskLocation(o.cwd, o.area ?? path.relative(original.cwd, original.area));
    const result = changeRun((r) => {
      const t = r.tasks.find((t) => t.id === o._[0]);
      if (!t || t.state !== "queued" || t.name || t.pane) throw runError("Only queued tasks without registered resources can move");
      if (t.cwd !== original.cwd || t.area !== original.area) throw runError("Task moved concurrently; inspect before retrying");
      // No live work can hold this reservation. Release before publication so
      // failure leaves a repeatable queued task, not an orphaned old-tree lease.
      writerLease(r, t, true);
      (r.events ??= []).push({ at: new Date().toISOString(), task: t.id, action: "move", from: t.cwd, to: location.cwd });
      Object.assign(t, location);
      return { moved: t.id, cwd: t.cwd, area: t.area, phase: t.phase, help: [t.phase === r.phase ? "herdr-axi run next" : `herdr-axi run phase ${t.phase}`] };
    });
    return { ...result, note: "Prompt, role, phase and dependencies preserved; check any absolute paths in the prompt. No worker started; next rechecks conflicts. External worktree cleanup remains yours after worker closure." };
  }
  if (action === "phase") {
    const phase = o._[0];
    if (!Object.hasOwn(PHASES, phase)) throw runError(`Phases: ${Object.keys(PHASES).join(", ")}`);
    const cap = o.cap === undefined ? run.limits[phase] : Number(o.cap);
    if (!Number.isInteger(cap) || cap < 1 || cap > 16) throw runError("--cap must be 1..16");
    changeRun((r) => {
      if (pending(r).length > cap) throw runError("Review/accept current results before narrowing capacity", "CAPACITY_FULL");
      r.phase = phase; r.limits[phase] = cap;
    });
    const updated = loadRun();
    const workers = updated.workers.filter((w) => !w.closed);
    const retire = workers.filter((w) => !pending(updated).some((t) => t.pane === w.pane)).slice(0, Math.max(0, workers.length - cap));
    const retired = await Promise.all(retire.map(async (w) => {
      try { return await executeRunCommand("close", { _: [w.pane] }); }
      catch (e) { return { pane: w.pane, error: e.message.slice(0, 600) }; }
    }));
    return { phase, capacity: cap, ...(retired.length ? { retired } : {}), help: [retired.some((w) => w.error) ? "herdr-axi run inbox" : updated.tasks.some((t) => t.state === "queued" && t.phase === phase) ? "herdr-axi run next" : pending(updated).length ? "herdr-axi watch" : "herdr-axi run queue --help"] };
  }
  if (action === "cancel") {
    const task = taskFor(run, o._[0]);
    if (!task || task.state === "accepted") throw runError("Cancel requires an unfinished owned task; accepted workers use run close", "NOT_CANCELLABLE", ["herdr-axi run cancel --help"]);
    if (["queued", "cancelled"].includes(task.state)) {
      changeRun((r, { afterCommit }) => {
        const t = r.tasks.find((t) => t.id === task.id);
        if (t.state !== task.state) throw runError("Task changed; retry", "RUN_BUSY");
        t.state = "cancelled";
        afterCommit.push(() => writerLease(r, t, true));
      });
      return { cancelled: task.id, help: ["herdr-axi run status"] };
    }
    const retry = `herdr-axi run cancel ${task.id}`;
    if (["starting", "switching", "cancelling"].includes(task.state) && launcherAlive(task.launcher)) throw runError("Task control still running; wait before cancelling", "RUN_BUSY", [retry]);
    if (task.state !== "cancelling" && (!o.evidence?.trim() || o.evidence.length > 4000)) throw runError("Stopping unfinished work requires --evidence (1..4000 chars): authorization, saved partial state and background jobs. No acceptance required.", "CANCEL_EVIDENCE_REQUIRED", [`${retry} --evidence 'Authorized stop; partial state and background jobs reviewed'`]);
    if (task.state === "cancelling" && o.evidence && o.evidence !== task.cancellation.evidence) throw runError("Cancellation already checkpointed; resume without changing evidence", "CANCEL_PENDING", [retry]);
    const rows = listAgents({ all: true });
    const worker = task.cancellation?.from ?? ownedWorkers(run).find((w) => w.name === task.name && !w.closed);
    const live = safeWorker(run, worker, rows);
    let checkpoint = task.cancellation;
    if (!checkpoint) {
      let output = "", source = "unavailable";
      if (live) {
        try { output = runHerdr(["agent", "read", worker.pane, "--source", "recent-unwrapped", "--lines", "2000"], { timeoutMs: 3000, text: true }); source = "history"; }
        catch { output = runHerdr(["agent", "read", worker.pane, "--source", "visible", "--lines", "60"], { timeoutMs: 2000, text: true }); source = "visible"; }
      }
      const git = spawnSync("git", ["-C", task.cwd, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", timeout: 3000, maxBuffer: 262144, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      if (git.error) throw runError(`Cannot checkpoint worktree status: ${git.error.message}`, "CHECKPOINT_FAILED");
      checkpoint = { at: new Date().toISOString(), from: worker, evidence: o.evidence, output: output.slice(-32000), capture: { source, truncated: true }, gitStatus: git.status === 0 ? git.stdout.slice(0, 8000) : `unavailable: ${git.stderr.slice(0, 600)}` };
    }
    changeRun((r) => {
      const t = r.tasks.find((t) => t.id === task.id);
      if (t.state !== task.state || t.launcher !== task.launcher || t.name !== task.name) throw runError("Task changed; retry", "RUN_BUSY");
      t.cancellation = checkpoint; t.state = "cancelling"; t.launcher = process.pid; t.pane = worker.pane;
      if (!r.workers.some((w) => w.name === worker.name)) r.workers.push(worker);
    });
    try {
      await engineCall(["close", worker.name, "--cancel", path.join(runDir(), "run.json")], run);
      for (const [kind, id] of [["tab", worker.tab], ["pane", worker.pane], ["pane", worker.monitor]]) {
        if (!id && kind === "pane" && worker.stage === "created") continue;
        try { runHerdr([kind, "get", id]); throw runError("Registered resources remain", "CANCEL_PENDING"); }
        catch (e) { if (e.code !== "UNKNOWN_AGENT") throw e; }
      }
      await publishRun((r, { afterCommit }) => {
        const t = r.tasks.find((t) => t.id === task.id);
        if (t.state !== "cancelling" || t.cancellation.from.generation !== worker.generation) throw runError("Cancellation changed", "CANCEL_PENDING");
        r.workers.find((w) => w.name === worker.name).closed = true;
        t.state = "cancelled"; t.evidence = checkpoint.evidence.slice(0, 1000);
        delete t.launcher; delete t.error;
        afterCommit.push(() => writerLease(r, t, true));
      });
    } catch (e) {
      try { await publishRun((r) => { const t = r.tasks.find((t) => t.id === task.id); if (t.state === "cancelling") { delete t.launcher; t.error = e.message.slice(0, 600); } }); } catch { /* durable checkpoint retains capacity and lease */ }
      throw runError(`Cancellation incomplete; checkpoint and reservation retained: ${e.message}`, "CANCEL_PENDING", [retry]);
    }
    return { cancelled: task.id, closed: worker.pane, tab: worker.tab, capture: checkpoint.capture.source, note: "Owned tab, agent and monitor verified absent. Not accepted; files/worktree untouched. Bounded checkpoint saved; detached jobs are not stopped. Remove external worktrees only after reviewing saved/dirty work, never as a way to close panes.", help: ["herdr-axi run status"] };
  }
  const rows = listAgents({ all: true });
  if (action === "keys") {
    const worker = ownedWorkers(run).find((w) => w.pane === o._[0] && !w.closed);
    const live = safeWorker(run, worker, rows);
    if (!live || live.state === "working") throw runError("Worker absent or busy; inspect before sending UI keys", "AGENT_BUSY");
    runHerdr(["agent", "send-keys", live.pane, ...o._.slice(1)]);
    return { pane: live.pane, keys: o._.slice(1), help: [`herdr-axi read ${live.pane}`] };
  }
  if (action === "switch") {
    const workers = ownedWorkers(run);
    const targetWorker = workers.find((w) => w.pane === o._[0] && !w.closed);
    const task = taskFor(run, o._[0], targetWorker?.name);
    if (!task || !["running", "uncertain", "switching"].includes(task.state)) throw runError("Switch requires an unfinished quota-blocked task", "NOT_SWITCHABLE", ["herdr-axi run switch --help"]);
    if (task.state === "switching" && launcherAlive(task.launcher)) throw runError("A switch is still running; do not duplicate it", "RUN_BUSY");
    let handoff = task.handoffs?.at(-1);
    if (o.cancel) {
      if (task.state !== "switching" || o.role || o.kind || o.model || o.effort || o.summary) throw runError("Use switch <task-id> --cancel only for a pending switch", "SWITCH_PENDING");
      if (!safeWorker(run, handoff.from, rows) || receipt(handoff.from)?.closed || registeredWorker(run, task)?.generation !== handoff.from.generation) throw runError("Old worker is absent/changed; cannot cancel retirement", "SWITCH_PENDING");
      changeRun((r) => {
        const t = r.tasks.find((t) => t.id === task.id);
        if (t.state !== "switching" || t.launcher !== task.launcher) throw runError("Switch changed concurrently", "RUN_BUSY");
        t.handoffs.at(-1).state = "cancelled"; t.state = handoff.priorState;
        delete t.launcher; delete t.error;
      });
      return { switchCancelled: task.id, note: "Old owned worker retained; task remains unfinished and lease retained.", help: ["herdr-axi run inbox"] };
    }
    if (task.state !== "switching") {
      const worker = workers.find((w) => (task.pane ? w.pane === task.pane : w.name === task.name) && !w.closed);
      const live = safeWorker(run, worker, rows);
      if (!live || !["idle", "done", "blocked", "unknown"].includes(live.state)) throw runError("Switch refuses working or absent workers; inspect first", "NOT_SWITCHABLE");
      if (fs.existsSync(`${worker.receipt}.proof.${worker.generation}`)) await engineCall(["collect", worker.name], run);
      if (receipt(worker)?.complete) throw runError("Completed result: review and accept/revise, not a quota switch", "NOT_SWITCHABLE");
      if ((task.handoffs?.length ?? 0) >= 4) throw runError("Four provider switches reached; re-scope explicitly", "SWITCH_LIMIT");
      if (o.role && (o.kind || o.model || o.effort)) throw runError("Choose --role OR --kind/--model/--effort", "CONFIG_INVALID");
      const config = run.config ?? DEFAULT_CONFIG;
      const target = o.role ? config.roles[o.role] : validateConfig({ roles: { replacement: { kind: o.kind, model: o.model, effort: o.effort ?? "high", access: task.access } } }).roles.replacement;
      if (!target || o.role === "orchestrator" || target.kind === task.kind || target.access !== task.access) throw runError("Choose another provider with the same read/write access", "CONFIG_INVALID");
      if (pending(run).reduce((n, t) => n + (t.nativeSlots ?? 0), 0) - (task.nativeSlots ?? 0) + nativeSlots(target) > config.nativeSubagentLimit) throw runError("Replacement exceeds native subagent budget", "CAPACITY_FULL");
      if (o.summary !== undefined && (!o.summary.trim() || o.summary.length > 4000)) throw runError("--summary must contain 1..4000 characters");
      const visible = runHerdr(["agent", "read", worker.pane, "--source", "visible", "--lines", "40"], { timeoutMs: 2000, text: true });
      const quota = quotaError(visible);
      if (!quota) throw runError("No current quota/session-limit error; refusing an incomplete close", "QUOTA_NOT_CONFIRMED", [`herdr-axi read ${worker.pane} --raw`]);
      let output = visible, source = "visible";
      try { output = runHerdr(["agent", "read", worker.pane, "--source", "recent-unwrapped", "--lines", "2000"], { timeoutMs: 3000, text: true }); source = "history"; } catch { /* visible fallback disclosed */ }
      const git = spawnSync("git", ["-C", task.cwd, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", timeout: 3000, maxBuffer: 262144, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      if (git.error) throw runError(`Cannot checkpoint worktree status: ${git.error.message}`, "CHECKPOINT_FAILED");
      handoff = { at: new Date().toISOString(), priorState: task.state, from: worker, to: { ...target, role: o.role || task.role, subagents: target.subagents ?? [] }, quota, summary: o.summary || "", output: output.slice(-32000), capture: { source, lines: source === "history" ? 2000 : 40, chars: 32000, truncated: true }, gitStatus: git.status === 0 ? git.stdout.slice(0, 8000) : `unavailable: ${git.stderr.slice(0, 600)}`, gitStatusTruncated: git.stdout.length > 8000, state: "prepared" };
    } else if (o.role || o.kind || o.model || o.effort || o.summary) {
      throw runError("Switch already checkpointed; resume without changing its target", "SWITCH_PENDING", [`herdr-axi run switch ${task.id}`]);
    }
    if (task.state === "switching" && safeWorker(run, handoff.from, rows)) {
      const live = rows.find((a) => a.pane === handoff.from.pane);
      if (fs.existsSync(`${handoff.from.receipt}.proof.${handoff.from.generation}`)) await engineCall(["collect", handoff.from.name], run);
      const visible = runHerdr(["agent", "read", live.pane, "--source", "visible", "--lines", "40"], { timeoutMs: 2000, text: true });
      if (!["idle", "done", "blocked", "unknown"].includes(live.state) || receipt(handoff.from)?.complete || !quotaError(visible)) throw runError("Old worker resumed or quota no longer confirmed; inspect or cancel the pending switch", "SWITCH_PENDING", [`herdr-axi read ${live.pane} --raw`, `herdr-axi run switch ${task.id} --cancel`]);
    }
    changeRun((r) => {
      const t = r.tasks.find((t) => t.id === task.id);
      if (t.state !== task.state || t.name !== task.name || t.pane !== task.pane || t.launcher !== task.launcher) throw runError("Task changed; inspect before switching");
      if (!writerLease(r, { ...t, state: "queued" })) throw runError("Cannot retain this task's worktree lease", "LEASE_UNVERIFIED");
      if (t.state !== "switching") (t.handoffs ??= []).push(handoff);
      t.pane = handoff.from.pane;
      if (!r.workers.some((w) => w.pane === handoff.from.pane)) r.workers.push(handoff.from);
      t.state = "switching"; t.launcher = process.pid;
    });
    try {
      await engineCall(["close", handoff.from.name, "--handoff", path.join(runDir(), "run.json")], run);
      for (const [kind, id] of [["tab", handoff.from.tab], ["pane", handoff.from.pane], ["pane", handoff.from.monitor]]) {
        try { runHerdr([kind, "get", id]); throw runError("Old worker resources remain; replacement not queued", "SWITCH_PENDING"); }
        catch (e) { if (e.code !== "UNKNOWN_AGENT") throw e; }
      }
      await publishRun((r, effects) => {
        const t = r.tasks.find((t) => t.id === task.id);
        if (t.state !== "switching" || t.handoffs.at(-1).from.generation !== handoff.from.generation) throw runError("Switch generation changed", "SWITCH_PENDING");
        const w = r.workers.find((w) => w.pane === handoff.from.pane);
        if (w) w.closed = true;
        delete t.contextWindowTokens;
        Object.assign(t, handoff.to, { policy: hash(JSON.stringify(handoff.to)), nativeSlots: nativeSlots(handoff.to), state: "queued" });
        delete t.pane; delete t.name; delete t.launcher; delete t.error;
        t.handoffs.at(-1).state = "retired";
        effects.afterCommit.push(() => {
          // Registry identity is saved in run.json; tombstone/inbox stay until finish.
          // Only retired monitor hints are disposable; never touch native sessions.
          for (const file of [handoff.from.receipt + ".monitor-error", handoff.from.receipt.replace(/\.event$/, ".task")]) {
            try { if (fs.lstatSync(file).isFile()) fs.unlinkSync(file); }
            catch (e) { if (e.code !== "ENOENT") throw e; }
          }
        });
      });
    } catch (e) {
      try { await publishRun((r) => { const t = r.tasks.find((t) => t.id === task.id); if (t.state === "switching") { delete t.launcher; t.error = e.message.slice(0, 600); } }); } catch { /* checkpoint and lease remain durable */ }
      throw runError(`Switch incomplete; checkpoint and lease retained: ${e.message}`, "SWITCH_PENDING", [`herdr-axi run switch ${task.id}`, `herdr-axi run switch ${task.id} --cancel`]);
    }
    return { switched: task.id, kind: handoff.to.kind, model: handoff.to.model, state: "queued", cwd: task.cwd, note: "Old owned tab retired without accepting the task. Files, original prompt, checkpoint and lease retained; no Git writes. Next starts the replacement. Terminal capture is bounded, not full model-context restoration.", help: [task.phase === run.phase ? "herdr-axi run next" : `herdr-axi run phase ${task.phase}`] };
  }
  if (action === "recover") {
    const t = taskFor(run, o._[0]);
    if (t?.state === "cancelling") throw runError("Cancellation checkpoint exists; resume cancellation, not recovery", "CANCEL_PENDING", [`herdr-axi run cancel ${t.id}`]);
    if (!t || !["starting", "uncertain", "running"].includes(t.state)) throw runError("Task is not active");
    if (t.state === "starting" && t.launcher) {
      try { process.kill(t.launcher, 0); throw runError("Launcher still running; wait for its result"); }
      catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    const recorded = registeredWorker(run, t);
    if (recorded) {
      safeWorker(run, recorded, []);
      const absent = (kind, id) => {
        try { runHerdr([kind, "get", id]); return false; }
        catch (e) { if (e.code === "UNKNOWN_AGENT") return true; throw e; }
      };
      if (absent("tab", recorded.tab) && absent("pane", recorded.pane) && (!recorded.monitor || absent("pane", recorded.monitor))) {
        changeRun((r, { afterCommit }) => {
          const current = r.tasks.find((p) => p.id === t.id);
          if (current.state !== t.state) throw runError("Task changed; retry");
          current.state = "queued"; delete current.pane; delete current.name;
          afterCommit.push(() => writerLease(r, current, true));
          // Retain verified-absent identity: finish archives its inbox and prunes
          // only these recorded runtime paths, even if the task is never retried.
          const old = r.workers.find((w) => w.name === recorded.name);
          if (old) old.closed = true;
          else r.workers.push({ ...recorded, closed: true });
        });
        return { requeued: t.id, note: "Registered tab and panes verified absent; no prompt resent.", help: ["herdr-axi run next"] };
      }
    }
    if (t.state === "running") throw runError("Registered resources remain. Recover requeues absent workers; to stop this task and close its whole tab, cancel with explicit evidence. Do not remove its worktree.", "RESOURCES_REMAIN", [`herdr-axi run cancel ${t.id} --evidence 'Authorized stop; partial state and background jobs reviewed'`]);
    const worker = workerRecord(run, t);
    const live = safeWorker(run, worker, rows);
    if (!live || !["working", "blocked", "idle", "done"].includes(live.state)) throw runError("Cannot recover an absent or unknown worker");
    if (worker.stage === "created") {
      if (!["idle", "done"].includes(live.state)) throw runError("Startup is not ready. Inspect the pane and resolve its dialog before recovery.", "STARTUP_NOT_READY", [`herdr-axi read ${live.pane} --raw --lines 60 --chars 8000`, `herdr-axi run recover ${live.pane}`]);
      changeRun((r) => {
        const current = r.tasks.find((p) => p.id === t.id);
        if (current.state !== t.state) throw runError("Task changed; retry");
        current.state = "starting"; current.launcher = process.pid;
      });
      return launch({ ...t, pane: worker.pane, resume: true }, run);
    }
    changeRun((r) => {
      const current = r.tasks.find((p) => p.id === t.id);
      if (current.state !== t.state) throw runError("Task changed; retry");
      current.state = "running"; current.pane = worker.pane;
      r.workers = [...r.workers.filter((w) => w.pane !== worker.pane), worker];
    });
    return { recovered: worker.pane, help: ["herdr-axi watch"] };
  }
  if (action === "next") {
    const trees = new Map();
    const agentTree = (cwd) => {
      if (!trees.has(cwd)) { try { trees.set(cwd, worktree(cwd)); } catch { trees.set(cwd, cwd); } }
      return trees.get(cwd);
    };
    const sharedReaders = new Set(run.config?.sharedReadWorktree ? pending(run).filter((t) => t.access === "read").map((t) => t.pane) : []);
    const blockers = rows.filter((a) => a.kind && a.cwd && !run.workers.some((w) => w.pane === a.pane && (["idle", "done"].includes(a.state) || sharedReaders.has(a.pane)) && safeWorker(run, w, rows, { observe: true }))).map((a) => ({ pane: a.pane, tree: agentTree(a.cwd), shared: !!run.config?.sharedReadWorktree && pending(run).some((t) => t.pane === a.pane) && run.workers.some((w) => w.pane === a.pane && safeWorker(run, w, rows, { observe: true })) }));
    const selection = changeRun((r, { rollback }) => {
      const selected = [], deferred = [];
      const defer = (t, reason, detail = {}) => deferred.push({ task: t.id, reason, ...detail });
      const availableParked = () => r.workers.find((w) => !w.closed && !w.closing && !pending(r).some((t) => t.pane === w.pane) && [...r.tasks].reverse().find((t) => t.pane === w.pane)?.state === "accepted" && ["idle", "done"].includes(safeWorker(r, w, rows, { observe: true })?.state));
      for (const t of r.tasks.filter((t) => t.state === "queued" && t.phase === r.phase)) {
        if (pending(r).length >= limit(r)) { defer(t, "primary capacity"); continue; }
        const dependency = t.deps.map((id) => r.tasks.find((d) => d.id === id) ?? { id, state: "missing" }).find((d) => d.state !== "accepted");
        if (dependency) { defer(t, "unaccepted dependency", { dependency: dependency.id, state: dependency.state, help: dependency.state === "cancelled" ? `herdr-axi run cancel ${t.id}` : dependency.state === "queued" && dependency.phase !== r.phase ? `herdr-axi run phase ${dependency.phase}` : "herdr-axi run inbox" }); continue; }
        const exclusive = (task) => task.access !== "read" || !r.config?.sharedReadWorktree;
        const blocker = blockers.find((a) => a.tree === t.worktree && (exclusive(t) || !a.shared));
        if ((blocker && (exclusive(t) || !blocker.shared)) || (exclusive(t) && pending(r).some((p) => exclusive(p) && ((p.worktree && p.worktree === t.worktree) || overlaps(p.area, t.area))))) { defer(t, "worktree busy", { ...(blocker ? { pane: blocker.pane } : {}), worktree: t.worktree, cwd: t.cwd, access: t.access, help: "herdr-axi run move --help" }); continue; }
        if (pending(r).reduce((n, p) => n + (p.nativeSlots ?? 0), 0) + (t.nativeSlots ?? 0) > (r.config?.nativeSubagentLimit ?? 0)) { defer(t, "native capacity"); continue; }
        const reusable = r.workers.find((w) => !w.closed && !w.closing && w.kind === t.kind && w.cwd === t.cwd && w.policy === t.policy && !pending(r).some((p) => p.pane === w.pane) && ["idle", "done"].includes(safeWorker(r, w, rows, { observe: true })?.state));
        // Parked workers remain a bounded pool, even after a phase narrows.
        if (!reusable && r.workers.filter((w) => !w.closed).length + pending(r).filter((p) => !p.pane).length >= limit(r)) {
          const parked = availableParked();
          defer(t, "parked pool full; close an unused accepted worker", { help: parked ? `herdr-axi run close ${parked.pane}` : "herdr-axi run inbox" }); continue;
        }
        // Roll back only newly acquired holders, not a retained handoff lease.
        if (!writerLease(r, t, false, rollback)) { defer(t, "worktree lease held or unverified", { help: "herdr-axi run leases" }); continue; }
        t.state = "starting";
        t.launcher = process.pid;
        // Herdr names are lowercase and at most 32 characters; task IDs need
        // not inherit that backend restriction or collide when truncated.
        t.name = reusable?.name ?? `axi-${r.id}-${randomUUID().slice(0, 8)}`;
        if (reusable) t.pane = reusable.pane;
        selected.push({ ...t });
      }
      const otherPhases = [...new Set(r.tasks.filter((t) => t.state === "queued" && t.phase !== r.phase).map((t) => t.phase))];
      const parked = availableParked();
      const fallback = pending(r).length ? "herdr-axi run inbox" : otherPhases.length ? `herdr-axi run phase ${otherPhases[0]}` : parked ? `herdr-axi run close ${parked.pane}` : r.workers.some((w) => !w.closed) ? "herdr-axi run inbox" : r.tasks.length && r.tasks.every((t) => ["accepted", "cancelled"].includes(t.state)) ? "herdr-axi run finish" : "herdr-axi run queue --help";
      return { selected, deferred, otherPhases, fallback };
    });
    const started = await Promise.all(selection.selected.map((t) => launch(t, run)));
    const { otherPhases } = selection;
    const busy = selection.deferred.find((t) => t.reason === "worktree busy");
    let isolation;
    if (busy) {
      const target = path.join(path.dirname(busy.worktree), ".herdr-axi-worktrees", `${run.id}-${busy.task}`);
      const targetCwd = path.join(target, path.relative(busy.worktree, busy.cwd));
      isolation = { task: busy.task, note: "Read access/--area: instructions, not isolation. Blocking pane: no control. Continue local work or move. Optional HEAD-only Git snapshot: excludes dirty/untracked changes; requires commit and permission for Git metadata writes. Use only if task scope allows.", snapshot: [`git -C ${quote(busy.worktree)} worktree add --detach ${quote(target)} HEAD`, `herdr-axi run move ${busy.task} --cwd ${quote(targetCwd)}`, "herdr-axi run next"], cleanupAfterClose: `git -C ${quote(busy.worktree)} worktree remove ${quote(target)}` };
    }
    return { started, ...(selection.deferred.length ? { deferred: selection.deferred.slice(0, 8), ...(selection.deferred.length > 8 ? { more: selection.deferred.length - 8 } : {}) } : {}), ...(isolation ? { isolation } : {}), ...(!started.length && otherPhases.length ? { queuedPhases: otherPhases } : {}), help: started.find((t) => t.help)?.help ?? [started.length ? "herdr-axi watch" : selection.deferred.find((t) => t.help)?.help ?? selection.fallback], note: !started.length ? "No eligible task. Resolve listed constraints or follow cleanup/phase help; no status/read polling. Other-phase tasks require an explicit phase change." : started.every((t) => t.state === "running") ? waitingNote : "Handle startup/delivery issues first; other workers may still be running." };
  }
  const pane = o._[0];
  const worker = run.workers.find((w) => w.pane === pane && !w.closed);
  const live = safeWorker(run, worker, rows);
  const task = taskFor(run, pane);
  if (action === "accept") {
    if (!o.evidence?.trim()) throw runError("accept requires --evidence describing coordinator review and checks");
    if (!live || !["idle", "done"].includes(live.state) || !receipt(worker)?.complete) {
      const quota = live && live.state !== "working" ? quotaError(runHerdr(["agent", "read", pane, "--source", "visible", "--lines", "24"], { timeoutMs: 1000, text: true })) : null;
      throw runError(quota ? "Quota exhausted, not completed. Switch the existing task; no acceptance or new run needed." : "Acceptance requires live settlement and this generation's completion receipt. To stop unfinished work instead, use cancel with explicit evidence.", quota ? "QUOTA_EXHAUSTED" : "NOT_COMPLETE", quota ? switchHelp(run, pane, worker.kind) : ["herdr-axi run inbox", `herdr-axi run cancel ${pane} --evidence 'Authorized stop; partial state and background jobs reviewed'`]);
    }
    let report;
    try {
      if (o["result-file"]) {
        const file = o["result-file"], stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 14000) throw Error("Replacement report must be a regular file, at most 3500 characters");
        const detail = fs.readFileSync(file, "utf8");
        if (!detail.trim() || detail.length > 3500) throw Error("Replacement report must contain 1..3500 characters");
        report = { generation: worker.generation, summary: detail.slice(0, 600), detail };
      } else report = JSON.parse(fs.readFileSync(worker.receipt + ".inbox", "utf8"));
      if (report?.generation !== worker.generation || typeof report.summary !== "string" || typeof (report.detail ?? report.summary) !== "string" || !(report.detail ?? report.summary).trim()) throw Error("missing/mismatched current report");
    } catch (e) { throw runError(`Report unavailable at ${worker.receipt}.inbox: ${e.message}. Retry run inbox; if unrecoverable, explicitly preserve a reviewed replacement with accept --result-file FILE.`, "RESULT_UNAVAILABLE"); }
    changeRun((r, { afterCommit }) => {
      const t = r.tasks.find((t) => t.id === task.id);
      if (t.state !== "running" || r.workers.find((w) => w.pane === pane)?.generation !== worker.generation) throw runError("Task changed or delivery uncertain; inspect before accepting");
      t.state = "accepted"; t.evidence = o.evidence.slice(0, 1000);
      t.summary = report.summary.slice(0, 600); t.result = String(report.detail ?? report.summary).slice(0, 3500);
      if (o["result-file"]) t.resultSource = "coordinator-replacement";
      const commit = spawnSync("git", ["-C", t.cwd, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 2000 });
      if (commit.status === 0) t.commit = commit.stdout.trim();
      afterCommit.push(() => writerLease(r, t, true));
    });
    return { accepted: task.id, pane, help: ["herdr-axi run next"] };
  }
  if (action === "revise") {
    if (!live || !["idle", "done"].includes(live.state) || !receipt(worker)?.complete) throw runError("revise needs a completed current generation");
    const prompt = taskPrompt(o);
    const next = changeRun((r) => {
      const t = r.tasks.find((t) => t.id === task.id);
      if (t.state !== "running") throw runError("Only unaccepted results can be revised; queue new work after acceptance");
      if (r.workers.find((w) => w.pane === pane)?.generation !== worker.generation) throw runError("Generation changed; inspect again");
      t.revisions ??= [];
      if (t.revisions.length >= 8) throw runError("Eight revisions reached; accept/re-scope explicitly instead of an unbounded fix loop");
      let summary;
      try { const e = JSON.parse(fs.readFileSync(worker.receipt + ".inbox")); if (e.generation === worker.generation) summary = String(e.summary).slice(0, 600); } catch { /* prior prompt retained */ }
      t.revisions.push({ at: new Date().toISOString(), prompt: t.prompt, summary });
      const handoff = t.handoffs?.findLast((h) => h.state === "retired");
      if (handoff) { handoff.completedGeneration = worker.generation; handoff.completedBy = worker.name; }
      t.prompt = prompt; t.state = "starting"; t.launcher = process.pid;
      return { ...t };
    });
    return launch(next, run);
  }
  if (action === "close") {
    changeRun((r) => {
      if (pending(r).some((t) => t.pane === pane) || task?.state !== "accepted") throw runError("Close requires acceptance. To stop unfinished work and its monitor, use cancel; never fabricate completion or remove the worktree.", "NOT_ACCEPTED", [`herdr-axi run cancel ${pane} --evidence 'Authorized stop; partial state and background jobs reviewed'`]);
      r.workers.find((w) => w.pane === pane).closing = true;
    });
    await engineCall(["close", worker.name], run);
    await publishRun((r) => { r.workers.find((w) => w.pane === pane).closed = true; });
    return { closed: pane, tab: worker.tab, help: ["herdr-axi run next"] };
  }
  throw runError(`Unknown run action: ${action}`);
}
