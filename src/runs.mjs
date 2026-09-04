import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runHerdr, listAgents, requireHerdrEnv } from "./herdr.mjs";
import { PHASES, runError, runDir, loadRun, changeRun, pending, limit, receipt, registeredWorker, ownedWorkers } from "./run-state.mjs";
import { projectConfig, worktree, nativeSlots, writerLease, hash, DEFAULT_CONFIG } from "./project.mjs";
import { projectRuns, projectHistory, history, finishRun, collectArchives } from "./archive.mjs";
import { contextStatus } from "./context.mjs";

const engine = fileURLToPath(new URL("../engine/herdr-orchestrator.sh", import.meta.url));
const idOK = (id) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(id ?? "");
const liveAgent = (pane) => runHerdr(["agent", "get", pane]).agent;
const callerPane = () => process.env.HERDR_PANE_ID || runHerdr(["pane", "current", "--current"]).pane?.pane_id;
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

export function ownerCheck(run) {
  if (!run) throw runError("Initialize/select a run first", "RUN_REQUIRED");
  if (callerPane() !== run.owner.pane)
    throw runError("This pane is not the run owner", "NOT_RUN_OWNER");
  const a = liveAgent(run.owner.pane);
  if (a?.workspace_id !== run.workspace || a?.tab_id !== run.owner.tab || (run.owner.terminal && a.terminal_id !== run.owner.terminal) || (run.owner.session && a.agent_session?.value !== run.owner.session))
    throw runError("Owner identity changed; refusing to control this run", "OWNER_CHANGED");
}

function safeWorker(run, worker, rows, { observe = false } = {}) {
  try {
    if (!worker || worker.closed) throw runError("Pane is not a live owned worker", "NOT_OWNED");
    if (worker.pane === run.owner.pane || worker.tab === run.owner.tab || worker.pane === process.env.HERDR_PANE_ID || worker.tab === process.env.HERDR_TAB_ID)
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
  fs.writeFileSync(file, `${task.prompt}\n\nTask: ${task.id}\nRole: ${task.role || task.kind}; access: ${task.access || "write"}\n${task.access === "read" ? "Read-only project: no source, documentation, Git or test-output writes; a writer may be active. Report snapshot/commit; recheck after writer acceptance for final verification." : `Write scope: ${task.area}`}
No commits, pushes, follow-up assignments or Herdr workers. ${delegation}
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
  // Cosmetic failure must never turn an acknowledged task into uncertain
  // delivery (or make recovery mistake an old generation for the new task).
  if (!error && task.pane && worker) {
    try {
      const expected = run.workers.find((w) => w.pane === task.pane) ?? worker;
      if (!safeWorker(run, expected, listAgents({ all: true }))) throw runError("Cannot relabel an absent worker", "WORKER_CHANGED");
      runHerdr(["tab", "rename", worker.tab, label]);
    } catch (e) { labelError = e.message.slice(0, 300); }
  }
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
  const startup = error && worker?.stage === "created";
  const blocked = startup && error.message.includes("agent_not_ready");
  return { task: task.id, ...(worker ? { pane: worker.pane } : {}), state: blocked ? "blocked" : error ? "uncertain" : "running", ...(error ? { error: error.message.slice(0, 600) } : {}), ...(labelError ? { labelError } : {}),
    ...(startup ? { submitted: false, note: "Startup needs attention. Inspect the dialog; approve only with authorization, then recover once idle.", help: [`herdr-axi read ${worker.pane} --raw`, `herdr-axi run recover ${worker.pane}`] } : {}) };
}

export function runStatus() {
  const run = loadRun();
  if (!run) throw runError("Select a run with HERDR_AXI_RUN", "RUN_REQUIRED");
  if (run.finishedAt) return { finished: run.finishedAt, complete: true, help: ["herdr-axi run history"] };
  const rows = listAgents({ all: true });
  const workers = ownedWorkers(run, { observe: true });
  const tasks = pending(run).map((t) => {
    const w = workers.find((w) => (t.pane ? w.pane === t.pane : w.name === t.name) && !w.closed);
    const a = w ? safeWorker(run, w, rows, { observe: true }) : null;
    let current;
    try { current = !w || w.stage === "created" ? registeredWorker(run, t) : null; }
    catch { return { task: t.id, pane: w?.pane ?? t.pane ?? "pending", state: "lost", error: "Unreadable worker registry; inspect run receipts" }; }
    const stage = w?.stage === "created"
      ? (current?.pane === w.pane && current?.tab === w.tab ? current.stage : undefined) : w?.stage;
    const state = w && !a ? "lost" : a?.state === "blocked" ? "blocked" : t.state === "starting" ? "starting" : a?.state ?? t.state;
    const complete = t.state === "running" && w && receipt(w)?.complete && ["idle", "done"].includes(state);
    return { task: t.id, pane: w?.pane ?? t.pane ?? "pending", state: complete ? "review" : state, ...(stage === "created" ? { delivery: "not_submitted" } : t.state === "uncertain" ? { delivery: "uncertain" } : {}) };
  });
  const queued = run.tasks.filter((t) => t.state === "queued");
  const parked = run.workers.filter((w) => !w.closed && !pending(run).some((t) => t.pane === w.pane)).map((w) => w.pane);
  const context = run.config ? contextStatus(run, workers.filter((w) => !w.closed && safeWorker(run, w, rows, { observe: true })), rows) : null;
  const blocked = tasks.find((t) => t.state === "blocked");
  const ready = tasks.find((t) => t.delivery === "not_submitted" && ["idle", "done"].includes(t.state));
  return { phase: run.phase, capacity: limit(run), occupied: tasks.length, queued: queued.length, tasks,
    ...(run.config ? { nativeReserved: pending(run).reduce((n, t) => n + (t.nativeSlots ?? 0), 0), nativeCapacity: run.config.nativeSubagentLimit } : {}),
    ...(context?.warnings.length ? { contextWarnings: context.warnings, contextAction: "Checkpoint at a safe boundary; review, then replace/compact the accepted worker. Never interrupt unfinished work automatically." } : {}),
    ...(context?.unknown ? { contextUnknown: context.unknown } : {}),
    ...(context?.stale ? { contextStale: context.stale } : {}),
    parked,
    ...(!tasks.length && queued.length ? { backlog: queued.slice(0, 8).map((t) => ({ task: t.id, phase: t.phase, after: t.deps })), ...(queued.length > 8 ? { more: queued.length - 8 } : {}) } : {}),
    ...(!tasks.length && !queued.length && !parked.length ? { complete: true } : {}),
    help: [blocked ? `herdr-axi read ${blocked.pane} --raw` : ready ? `herdr-axi run recover ${ready.pane}` : tasks.some((t) => !["working", "starting"].includes(t.state)) ? "herdr-axi run inbox" : queued.length && tasks.length < limit(run) ? "herdr-axi run next" : tasks.length ? "herdr-axi watch" : parked.length ? `herdr-axi run close ${parked[0]}` : run.tasks.length ? "herdr-axi run finish" : "herdr-axi run --help"] };
}

export async function watchRun(timeout = 30000) {
  const first = runStatus();
  const actionable = (s) => s.contextWarnings?.length || s.tasks.some((t) => !["working", "starting"].includes(t.state));
  if (!first.tasks.length || actionable(first)) return { changed: false, ...first };
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await delay(Math.min(2000, timeout - (Date.now() - start)));
    const next = runStatus();
    if (JSON.stringify(first) !== JSON.stringify(next)) return { changed: true, ...next };
  }
  return { changed: false, ...first };
}

// A bounded queue and a reusable worker pool, not a background scheduler.
// `next` reserves all available slots atomically, then starts them concurrently.
export async function runCommand(action, o) {
  if (!["status", "history", "config", "gc"].includes(action)) requireHerdrEnv();
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
    return { run: dir, owner: ownerPane, workspace: run.workspace, project: project.project, config: project.configFile || "defaults", cleanup: collectArchives(project.project), help: [`export HERDR_AXI_RUN='${dir.replaceAll("'", "'\\''")}'`, "herdr-axi run --help"] };
  }
  const run = loadRun();
  if (!run) throw runError("Initialize/select a run first", "RUN_REQUIRED");
  if (action === "status") return runStatus();
  if (action === "config") return { project: run.project, source: run.configFile || "defaults", config: run.config ?? DEFAULT_CONFIG, note: "Snapshot at init. Orchestrator model is a launch contract; the current owner is never restarted. Native child limits/read-only access are agent instructions, not an OS security boundary." };
  if (action === "history") {
    if (o.all && o.task) throw runError("history --all and --task conflict");
    return o.all ? projectHistory(run.project || worktree(process.cwd())) : history(run, o.task);
  }
  if (action === "gc") return collectArchives(run.project);
  if (run.finishedAt && action !== "finish") throw runError("Archived run is read-only; initialize a new run", "RUN_FINISHED");
  if (action === "inbox") {
    ownerCheck(run);
    let status = runStatus();
    // Native hooks can precede the final idle snapshot/session metadata. Pull
    // late proofs on demand instead of waiting for another lifecycle change.
    const late = status.tasks.filter((t) => ["idle", "done"].includes(t.state))
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
        if (e.generation === w.generation) events.push({ task: t.id, pane: w.pane, event: e.event, summary: String(e.summary).slice(0, 600), ...(e.truncated ? { truncated: true } : {}) });
      } catch (e) { if (e.code !== "ENOENT") errors.push({ pane: w.pane, error: e.message.slice(0, 300) }); }
    }
    const first = status.tasks.find((t) => t.state === "blocked") ?? status.tasks.find((t) => t.pane !== "pending");
    return { ...status, events, ...(errors.length ? { errors: errors.slice(0, 8), ...(errors.length > 8 ? { moreErrors: errors.length - 8 } : {}) } : {}), help: [first ? `herdr-axi read ${first.pane}${first.state === "blocked" ? " --raw" : ""}` : "herdr-axi run status", "herdr-axi run --help"] };
  }
  ownerCheck(run);
  if (action === "finish") return { ...finishRun(), cleanup: collectArchives(run.project) };
  if (action === "unlock") {
    // Serialize recoveries and exclude new transactions while checking the
    // dead owner, so a second unlock cannot remove a newly acquired lock.
    const guard = path.join(runDir(), "run.unlock");
    let fd;
    try { fd = fs.openSync(guard, "wx", 0o600); }
    catch (e) { if (e.code === "EEXIST") throw runError("Another unlock is active; inspect run.unlock after a crash", "RUN_BUSY"); throw e; }
    try {
      const file = path.join(runDir(), "run.lock");
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw runError("Lock owner is unknown; inspect run.lock manually");
      try { process.kill(pid, 0); throw runError("Lock holder is still live", "RUN_BUSY"); }
      catch (e) { if (e.code !== "ESRCH") throw e; }
      fs.unlinkSync(file);
      return { unlocked: true };
    } finally { fs.closeSync(fd); fs.unlinkSync(guard); }
  }
  if (action === "queue") {
    const id = o._[0];
    const role = o.role ? (run.config ?? DEFAULT_CONFIG).roles[o.role] : null;
    if (o.role && (!role || o.role === "orchestrator" || (o.kind && o.kind !== role.kind))) throw runError("Unknown/owner role or conflicting --kind", "CONFIG_INVALID");
    const kind = role?.kind ?? o.kind;
    if (!idOK(id) || !["claude", "codex", "copilot"].includes(kind) || !o.cwd || !o["prompt-file"] || !o.area) throw runError("queue needs a short task ID, --role or --kind, --cwd, --area and --prompt-file");
    const cwd = fs.realpathSync(o.cwd);
    const area = path.resolve(cwd, o.area);
    if (!overlaps(cwd, area) || (cwd !== area && !area.startsWith(cwd + path.sep))) throw runError("--area must be within --cwd");
    const prompt = fs.readFileSync(o["prompt-file"], "utf8");
    if (!prompt.trim() || Buffer.byteLength(prompt) > 64000) throw runError("Task prompt must be nonempty and at most 64KB");
    const deps = o.after ? o.after.split(",") : [];
    const tree = worktree(cwd);
    if (runDir() === tree || runDir().startsWith(tree + path.sep)) throw runError("Worker worktree must not contain run state", "STATE_IN_PROJECT");
    changeRun((r) => {
      if (r.tasks.length >= 128 || r.tasks.some((t) => t.id === id)) throw runError("Duplicate task ID or 128-task run limit");
      if (deps.some((id) => !r.tasks.some((t) => t.id === id))) throw runError("Dependencies must reference existing tasks");
      r.tasks.push({ id, ...(role || {}), kind, role: o.role, policy: hash(JSON.stringify(role || { kind, access: "write" })), access: role?.access ?? "write", nativeSlots: role ? nativeSlots(role) : 0, worktree: tree, cwd, area, prompt, deps, phase: r.phase, state: "queued" });
    });
    return { queued: id, help: ["herdr-axi run next"] };
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
      try { return await runCommand("close", { _: [w.pane] }); }
      catch (e) { return { pane: w.pane, error: e.message.slice(0, 600) }; }
    }));
    return { phase, capacity: cap, ...(retired.length ? { retired } : {}), help: ["herdr-axi run status"] };
  }
  if (action === "cancel") {
    changeRun((r, { afterCommit }) => {
      const t = r.tasks.find((t) => t.id === o._[0]);
      if (!t || t.state !== "queued") throw runError("Only queued tasks can be cancelled; never abandon live work");
      t.state = "cancelled";
      afterCommit.push(() => writerLease(r, t, true));
    });
    return { cancelled: o._[0] };
  }
  const rows = listAgents({ all: true });
  if (action === "recover") {
    const t = [...run.tasks].reverse().find((t) => t.id === o._[0] || t.pane === o._[0]);
    if (t && ["accepted", "cancelled"].includes(t.state)) {
      changeRun((r, { afterCommit }) => {
        const current = r.tasks.find((p) => p.id === t.id);
        if (current.state !== t.state) throw runError("Task changed; retry");
        afterCommit.push(() => writerLease(r, current, true));
      });
      return { releasedLease: t.id, note: "Only this completed task's reservation released; no pane input or prompt resend." };
    }
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
          r.workers = r.workers.filter((w) => w.pane !== recorded.pane);
        });
        return { requeued: t.id, note: "Registered tab and panes verified absent; no prompt resent.", help: ["herdr-axi run next"] };
      }
    }
    if (t.state === "running") throw runError("Running task still has registered resources; inspect before cleanup");
    const worker = workerRecord(run, t);
    const live = safeWorker(run, worker, rows);
    if (!live || !["working", "blocked", "idle", "done"].includes(live.state)) throw runError("Cannot recover an absent or unknown worker");
    if (worker.stage === "created") {
      if (!["idle", "done"].includes(live.state)) throw runError("Startup is not ready. Inspect the pane and resolve its dialog before recovery.");
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
    const sharedReaders = new Set(run.config?.sharedReadWorktree ? pending(run).filter((t) => t.access === "read").map((t) => t.pane) : []);
    const otherTrees = rows.filter((a) => a.kind && a.cwd && !run.workers.some((w) => w.pane === a.pane && (["idle", "done"].includes(a.state) || sharedReaders.has(a.pane)) && safeWorker(run, w, rows, { observe: true })) && a.workspace === run.workspace).map((a) => { try { return worktree(a.cwd); } catch { return a.cwd; } });
    const selection = changeRun((r, { rollback }) => {
      const selected = [], deferred = [];
      const defer = (t, reason) => deferred.push({ task: t.id, reason });
      for (const t of r.tasks.filter((t) => t.state === "queued" && t.phase === r.phase)) {
        if (pending(r).length >= limit(r)) { defer(t, "primary capacity"); continue; }
        if (t.deps.some((id) => r.tasks.find((d) => d.id === id)?.state !== "accepted")) { defer(t, "unaccepted dependency"); continue; }
        const exclusive = (task) => task.access !== "read" || !r.config?.sharedReadWorktree;
        if (exclusive(t) && (otherTrees.includes(t.worktree) || pending(r).some((p) => exclusive(p) && ((p.worktree && p.worktree === t.worktree) || overlaps(p.area, t.area))))) { defer(t, "worktree busy"); continue; }
        if (pending(r).reduce((n, p) => n + (p.nativeSlots ?? 0), 0) + (t.nativeSlots ?? 0) > (r.config?.nativeSubagentLimit ?? 0)) { defer(t, "native capacity"); continue; }
        const reusable = r.workers.find((w) => !w.closed && !w.closing && w.kind === t.kind && w.cwd === t.cwd && w.policy === t.policy && !pending(r).some((p) => p.pane === w.pane) && ["idle", "done"].includes(safeWorker(r, w, rows, { observe: true })?.state));
        // Parked workers remain a bounded pool, even after a phase narrows.
        if (!reusable && r.workers.filter((w) => !w.closed).length + pending(r).filter((p) => !p.pane).length >= limit(r)) { defer(t, "parked pool full; close an unused accepted worker"); continue; }
        if (!writerLease(r, t)) { defer(t, "worktree writer lease held; inspect before recovery"); continue; }
        rollback.push(() => writerLease(r, t, true));
        t.state = "starting";
        t.launcher = process.pid;
        // Herdr names are lowercase and at most 32 characters; task IDs need
        // not inherit that backend restriction or collide when truncated.
        t.name = reusable?.name ?? `axi-${r.id}-${randomUUID().slice(0, 8)}`;
        if (reusable) t.pane = reusable.pane;
        selected.push({ ...t });
      }
      return { selected, deferred };
    });
    const started = await Promise.all(selection.selected.map((t) => launch(t, run)));
    return { started, ...(selection.deferred.length ? { deferred: selection.deferred.slice(0, 8), ...(selection.deferred.length > 8 ? { more: selection.deferred.length - 8 } : {}) } : {}), help: started.find((t) => t.help)?.help ?? [started.length ? "herdr-axi watch" : "herdr-axi run status"], ...(!started.length ? { note: "No eligible task; inspect deferred reasons or queued phases." } : {}) };
  }
  const pane = o._[0];
  const worker = run.workers.find((w) => w.pane === pane && !w.closed);
  const live = safeWorker(run, worker, rows);
  const task = [...run.tasks].reverse().find((t) => t.pane === pane);
  if (action === "accept") {
    if (!o.evidence?.trim()) throw runError("accept requires --evidence describing coordinator review and checks");
    if (!live || !["idle", "done"].includes(live.state) || !receipt(worker)?.complete) throw runError("Acceptance requires live settlement and this generation's completion receipt", "NOT_COMPLETE");
    changeRun((r, { afterCommit }) => {
      const t = r.tasks.find((t) => t.id === task.id);
      if (t.state !== "running" || r.workers.find((w) => w.pane === pane)?.generation !== worker.generation) throw runError("Task changed or delivery uncertain; inspect before accepting");
      t.state = "accepted"; t.evidence = o.evidence.slice(0, 1000);
      try { const e = JSON.parse(fs.readFileSync(worker.receipt + ".inbox")); if (e.generation === worker.generation) { t.summary = String(e.summary).slice(0, 600); t.result = String(e.detail ?? e.summary).slice(0, 3500); } } catch { /* evidence remains mandatory */ }
      const commit = spawnSync("git", ["-C", t.cwd, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 2000 });
      if (commit.status === 0) t.commit = commit.stdout.trim();
      afterCommit.push(() => writerLease(r, t, true));
    });
    return { accepted: task.id, pane, help: ["herdr-axi run next"] };
  }
  if (action === "revise") {
    if (!o["prompt-file"] || !live || !["idle", "done"].includes(live.state) || !receipt(worker)?.complete) throw runError("revise needs --prompt-file and a completed current generation");
    const prompt = fs.readFileSync(o["prompt-file"], "utf8");
    if (!prompt.trim() || Buffer.byteLength(prompt) > 64000) throw runError("Fix prompt must be nonempty and at most 64KB");
    const next = changeRun((r) => {
      const t = r.tasks.find((t) => t.id === task.id);
      if (t.state !== "running") throw runError("Only unaccepted results can be revised; queue new work after acceptance");
      if (r.workers.find((w) => w.pane === pane)?.generation !== worker.generation) throw runError("Generation changed; inspect again");
      t.revisions ??= [];
      if (t.revisions.length >= 8) throw runError("Eight revisions reached; accept/re-scope explicitly instead of an unbounded fix loop");
      let summary;
      try { const e = JSON.parse(fs.readFileSync(worker.receipt + ".inbox")); if (e.generation === worker.generation) summary = String(e.summary).slice(0, 600); } catch { /* prior prompt retained */ }
      t.revisions.push({ at: new Date().toISOString(), prompt: t.prompt, summary });
      t.prompt = prompt; t.state = "starting"; t.launcher = process.pid;
      return { ...t };
    });
    return launch(next, run);
  }
  if (action === "close") {
    changeRun((r) => {
      if (pending(r).some((t) => t.pane === pane) || task?.state !== "accepted") throw runError("Close requires coordinator acceptance", "NOT_ACCEPTED");
      r.workers.find((w) => w.pane === pane).closing = true;
    });
    await engineCall(["close", worker.name], run);
    await publishRun((r) => { r.workers.find((w) => w.pane === pane).closed = true; });
    return { closed: pane, tab: worker.tab, help: ["herdr-axi run next"] };
  }
  throw runError(`Unknown run action: ${action}`);
}
