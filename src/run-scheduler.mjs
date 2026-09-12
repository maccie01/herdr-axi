import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { integrationKinds } from "./herdr.mjs";
import { pending, changeRun, runError, limit } from "./run-state.mjs";
import { worktree, writerLease } from "./project.mjs";
import { validateLaunch } from "./launch-policy.mjs";
import { safeWorker } from "./worker-identity.mjs";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const settled = (agent) => ["idle", "done"].includes(agent?.state);
const exclusive = (run, task) => task.access !== "read" || !run.config?.sharedReadWorktree;
const occupiesWorker = (tasks, worker) => tasks.some((task) => task.pane === worker.pane);

function availableWorker(run, worker, rows, active) {
  return !worker.closed && !worker.closing && !occupiesWorker(active, worker)
    && settled(safeWorker(run, worker, rows, { observe: true }));
}

function activeBlockers(run, rows) {
  const active = pending(run);
  const tasksByPane = new Map(active.filter((task) => task.pane).map((task) => [task.pane, task]));
  const workersByPane = new Map(run.workers.filter((worker) => !worker.closed).map((worker) => [worker.pane, worker]));
  const trees = new Map();
  const blockers = [];
  for (const agent of rows) {
    if (!agent.kind || !agent.cwd) continue;
    const task = tasksByPane.get(agent.pane);
    const worker = workersByPane.get(agent.pane);
    const verified = worker && safeWorker(run, worker, [agent], { observe: true });
    const shared = !!run.config?.sharedReadWorktree && !!task && !!verified;
    if (verified && (settled(agent) || (shared && task.access === "read"))) continue;
    // Snapshot-local path memoization is safe; failed Git identity never falls
    // back to a narrower directory that could permit an overlapping writer.
    if (!trees.has(agent.cwd)) trees.set(agent.cwd, worktree(agent.cwd));
    blockers.push({ pane: agent.pane, tree: trees.get(agent.cwd), shared });
  }
  return blockers;
}

export async function scheduleRun(run, rows, launch, waitingNote) {
  const available = integrationKinds();
  const blockers = activeBlockers(run, rows);
  const selection = changeRun((r, { rollback }) => {
    const selected = [], deferred = [];
    const defer = (t, reason, detail = {}) => deferred.push({ task: t.id, reason, ...detail });
    const tasksById = new Map(r.tasks.map((task) => [task.id, task]));
    const latestTaskByPane = new Map(r.tasks.filter((task) => task.pane).map((task) => [task.pane, task]));
    const availableParked = () => {
      const active = pending(r);
      return r.workers.find((worker) => availableWorker(r, worker, rows, active)
        && latestTaskByPane.get(worker.pane)?.state === "accepted");
    };
    for (const t of r.tasks.filter((t) => t.state === "queued" && t.phase === r.phase)) {
      try {
        if (!available.includes(t.kind)) throw runError(`Herdr integration is not installed for ${t.kind}`, "INTEGRATION_NOT_INSTALLED");
        validateLaunch(t);
      }
      catch (e) { defer(t, e.message, { help: `herdr-axi run cancel ${t.id}` }); continue; }
      const active = pending(r);
      if (active.length >= limit(r)) { defer(t, "primary capacity"); continue; }
      const dependency = t.deps.map((id) => tasksById.get(id) ?? { id, state: "missing" }).find((d) => d.state !== "accepted");
      if (dependency) { defer(t, "unaccepted dependency", { dependency: dependency.id, state: dependency.state, help: dependency.state === "cancelled" ? `herdr-axi run cancel ${t.id}` : dependency.state === "queued" && dependency.phase !== r.phase ? `herdr-axi run phase ${dependency.phase}` : "herdr-axi run inbox" }); continue; }
      const blocker = blockers.find((agent) => agent.tree === t.worktree && (exclusive(r, t) || !agent.shared));
      const overlapsActive = exclusive(r, t) && active.some((task) => exclusive(r, task)
        && ((task.worktree && task.worktree === t.worktree) || overlaps(task.area, t.area)));
      if (blocker || overlapsActive) { defer(t, "worktree busy", { ...(blocker ? { pane: blocker.pane } : {}), worktree: t.worktree, cwd: t.cwd, access: t.access, help: "herdr-axi run move --help" }); continue; }
      if (active.reduce((n, task) => n + (task.nativeSlots ?? 0), 0) + (t.nativeSlots ?? 0) > (r.config?.nativeSubagentLimit ?? 0)) { defer(t, "native capacity"); continue; }
      const reusable = r.workers.find((worker) => worker.kind === t.kind && worker.cwd === t.cwd
        && worker.policy === t.policy && availableWorker(r, worker, rows, active));
      // Parked workers remain a bounded pool, even after a phase narrows.
      if (!reusable && r.workers.filter((w) => !w.closed).length + active.filter((task) => !task.pane).length >= limit(r)) {
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
      if (reusable) { t.pane = reusable.pane; t.assignmentAfter = reusable.generation; }
      else delete t.assignmentAfter;
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
    const head = spawnSync("git", ["-C", busy.worktree, "rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8", timeout: 1000 });
    isolation = head.status === 0
      ? { task: busy.task, note: "Read access/--area: instructions, not isolation. Blocking pane: no control. Continue local work or move. Optional HEAD-only Git snapshot: excludes dirty/untracked changes; requires commit and permission for Git metadata writes. Use only if task scope allows.", snapshot: [`git -C ${quote(busy.worktree)} worktree add --detach ${quote(target)} HEAD`, `herdr-axi run move ${busy.task} --cwd ${quote(targetCwd)}`, "herdr-axi run next"], cleanupAfterClose: `git -C ${quote(busy.worktree)} worktree remove ${quote(target)}` }
      : { task: busy.task, note: "No verified Git HEAD; no worktree snapshot command. Serialize behind the current task, or move to an existing independent directory containing the required inputs. --area alone does not isolate writers.", help: [`herdr-axi run move ${busy.task} --cwd <independent-directory> --area <relative-area>`] };
  }
  return { started, ...(selection.deferred.length ? { deferred: selection.deferred.slice(0, 8), ...(selection.deferred.length > 8 ? { more: selection.deferred.length - 8 } : {}) } : {}), ...(isolation ? { isolation } : {}), ...(!started.length && otherPhases.length ? { queuedPhases: otherPhases } : {}), help: started.find((t) => t.help)?.help ?? [started.length ? "herdr-axi watch" : selection.deferred.find((t) => t.help)?.help ?? selection.fallback], note: !started.length ? "No eligible task. Resolve listed constraints or follow cleanup/phase help; no status/read polling. Other-phase tasks require an explicit phase change." : started.every((t) => t.state === "running") ? waitingNote : "Handle startup/delivery issues first; other workers may still be running." };
}
