import fs from "node:fs";
import { listAgents } from "./herdr.mjs";
import { runError, loadRun, pending, limit, receipt, registeredWorker, ownedWorkers } from "./run-state.mjs";
import { safeWorker, pendingInitialization } from "./worker-identity.mjs";
import { ownerCheck, launcherAlive } from "./run-control.mjs";
import { engineCall } from "./engine-client.mjs";
import { contextStatus } from "./context.mjs";
import { switchHelp } from "./quota.mjs";
import { workerReport } from "./run-evidence.mjs";

export const initializationNote = "Initialization input may already have been sent; the assignment is withheld. Recovery observes the existing initialization without replaying it. Inspect startup or explicitly cancel the owned task.";
export const needsAttention = (s) => s.contextWarnings?.length || s.contextError || s.ownershipIssues?.length || s.tasks?.some((t) => !["working", "starting"].includes(t.state));
export const waitingNote = "Continue independent work. Use one notification-backed background watch if supported; otherwise wait only when dependent. No inbox/read polling.";

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
    try { current = !w || ["created", "rejected"].includes(w.stage) || (t.assignmentAfter && w.generation === t.assignmentAfter) ? registeredWorker(run, t) : null; }
    catch (e) { return { task: t.id, pane: w?.pane ?? t.pane ?? rows.find((a) => a.backendName === t.name && a.workspace === run.workspace)?.pane ?? "pending", state: "unverified", error: e.message.slice(0, 300) }; }
    const stage = ["created", "rejected"].includes(w?.stage)
      ? (current?.pane === w.pane && current?.tab === w.tab ? current.stage : undefined) : w?.stage;
    const initialization = pendingInitialization(current ?? w);
    if (t.assignmentAfter && (current?.generation ?? w?.generation) === t.assignmentAfter && !["cancelling", "switching"].includes(t.state) && !(t.state === "starting" && launcherAlive(t.launcher)))
      return { task: t.id, pane: w.pane, state: "uncertain", delivery: "not_submitted", code: "ASSIGNMENT_NOT_SUBMITTED" };
    const state = ["switching", "cancelling"].includes(t.state) ? t.state : a?.state === "blocked" ? "blocked" : t.state === "starting" && launcherAlive(t.launcher) ? "starting" : w && !a ? "lost" : a?.state ?? (t.state === "starting" ? "uncertain" : t.state);
    const complete = t.state === "running" && w && receipt(w)?.complete && ["idle", "done"].includes(state);
    // A newer registry can have advanced after a failed run.json publication.
    // Historical engine diagnostics must not overrule its delivery authority.
    const notSubmitted = ["created", "rejected"].includes(stage)
      || (!w && !current && t.errorCode && t.errorSubmitted === false);
    return { task: t.id, pane: w?.pane ?? t.pane ?? "pending", state: complete ? "review" : state,
      ...(initialization ? { bootstrap: "pending" } : {}),
      ...(t.errorCode ? { code: t.errorCode } : {}),
      ...(notSubmitted ? { delivery: "not_submitted" } : t.state === "uncertain" ? { delivery: "uncertain" } : {}) };
  });
  const queued = run.tasks.filter((t) => t.state === "queued");
  const parked = run.workers.filter((w) => !w.closed && !pending(run).some((t) => t.pane === w.pane)).map((w) => w.pane);
  const parkedAttention = run.workers.filter((w) => parked.includes(w.pane)).flatMap((w) => {
    const live = safeWorker(run, w, rows, { observe: true });
    return live && ["idle", "done"].includes(live.state) ? [] : [{ pane: w.pane, state: live?.state ?? "unverified", help: live && ["working", "blocked"].includes(live.state) ? `herdr-axi read ${w.pane} --raw` : `herdr-axi run close ${w.pane}` }];
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
  const lost = tasks.find((t) => ["lost", "unverified"].includes(t.state));
  let help;
  const drifted = tasks.find((t) => t.code === "GENERATION_DRIFT");
  const monitorFailed = tasks.find((t) => t.code === "MONITOR_START_UNVERIFIED");
  const unsubmitted = tasks.find((t) => t.code === "ASSIGNMENT_NOT_SUBMITTED");
  const initializing = tasks.find((task) => task.bootstrap === "pending");
  if (drifted) help = [`herdr-axi run history --task ${drifted.task}`, `herdr-axi read ${drifted.pane} --raw`];
  else if (cancelling) help = [`herdr-axi run cancel ${cancelling.task}`];
  else if (monitorFailed) help = [`herdr-axi run cancel ${monitorFailed.task} --evidence 'Unsubmitted startup inspected; authorized cleanup'`];
  else if (unsubmitted) help = [`herdr-axi run cancel ${unsubmitted.task} --evidence 'Unsubmitted assignment and preserved partial state inspected; authorized cleanup'`];
  else if (initializing) help = [`herdr-axi run recover ${initializing.task}`, `herdr-axi read ${initializing.pane} --raw`];
  else if (exhausted) help = switchHelp(run, exhausted.pane, workers.find((w) => w.pane === exhausted.pane)?.kind);
  else if (switching) help = [`herdr-axi run switch ${switching.task}`];
  else if (blocked) help = [`herdr-axi read ${blocked.pane} --raw`];
  else if (ready) help = [`herdr-axi run recover ${ready.pane}`];
  else if (lost) help = [`herdr-axi run recover ${lost.task}`, `herdr-axi run cancel ${lost.task} --evidence 'Authorized stop; partial state and background jobs reviewed'`];
  else if (parkedAttention.length) help = [parkedAttention[0].help];
  else if (tasks.some((t) => !["working", "starting"].includes(t.state))) help = ["herdr-axi run inbox"];
  else if (context?.warnings.length) help = [`herdr-axi read ${context.warnings[0].pane}`];
  else if (queued.length && tasks.length < limit(run)) help = ["herdr-axi run next"];
  else if (tasks.length) help = ["herdr-axi watch"];
  else if (parked.length) help = [`herdr-axi run close ${parked[0]}`];
  else help = [run.tasks.length ? "herdr-axi run finish" : "herdr-axi run --help"];
  return { owner: run.owner.pane, phase: run.phase, capacity: limit(run), occupied: tasks.length, queued: queued.length, tasks,
    ...(initializing ? { bootstrap: "pending", note: initializationNote } : {}),
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
    ...(lost && tasks.some((t) => ["working", "starting"].includes(t.state)) ? { independentWait: `herdr-axi watch --task ${tasks.find((t) => ["working", "starting"].includes(t.state)).task}`, waitNote: "Lost task still needs an explicit recovery/cancellation decision. To await independent work meanwhile, use the task-scoped watch; no fleet/read polling." } : {}),
    help };
}

export async function runInbox(run, o) {
  ownerCheck(run);
  let status = runStatus();
  // Native hooks can precede the final idle snapshot/session metadata. Pull
  // late proofs on demand instead of waiting for another lifecycle change.
  const late = status.tasks.filter((t) => ["idle", "done", "unknown"].includes(t.state) || t.quota)
    .map((t) => run.workers.find((w) => w.pane === t.pane))
    .filter((w) => w && fs.existsSync(`${w.receipt}.proof.${w.generation}`));
  const collected = await Promise.allSettled(late.map((w) => engineCall(["collect", w.name], run)));
  const errors = collected.flatMap((r, i) => r.status === "rejected" ? [{ pane: late[i].pane, error: r.reason.message.slice(0, 300) }] : []);
  if (late.length) status = runStatus();
  const events = [], reports = new Map();
  for (const t of pending(run)) {
    const w = run.workers.find((w) => w.pane === t.pane && !w.closed);
    if (!w) continue;
    if (t.assignmentAfter && w.generation === t.assignmentAfter) continue;
    try {
      const inbox = JSON.parse(fs.readFileSync(`${w.receipt}.inbox`, "utf8"));
      const completion = inbox?.completion;
      // Readiness/alerts stay live, but review must show the saved completion,
      // never an unrelated notification which arrived after the result.
      const review = status.tasks.find((p) => p.task === t.id)?.state === "review";
      if (review) reports.set(t.id, workerReport(w));
      const e = review && completion?.event === "settled" && completion.generation === w.generation ? completion : inbox;
      if (e.generation === w.generation) events.push({ task: t.id, pane: w.pane, event: e.event, summary: String(e.summary).slice(0, 600), ...(e.quota?.code === "QUOTA_EXHAUSTED" ? { reportedQuota: e.quota.scope } : {}), ...(e.truncated ? { truncated: true } : {}) });
    } catch (e) { if (e.code !== "ENOENT") errors.push({ pane: w.pane, error: e.message.slice(0, 300) }); }
    try {
      const notice = fs.readFileSync(`${w.receipt}.monitor-error`, "utf8");
      const settled = events.some((e) => e.pane === w.pane && e.event === "settled") && receipt(w)?.complete;
      if (!settled && (notice.startsWith(`${w.generation}\t`) || notice.startsWith("-\t"))) errors.push({ pane: w.pane, error: notice.split("\t").slice(1).join("\t").trim().slice(0, 300) });
    } catch (e) { if (e.code !== "ENOENT") errors.push({ pane: w.pane, error: e.message.slice(0, 300) }); }
  }
  if (!events.length && !errors.length && status.occupied && !needsAttention(status))
    return { events: [], pending: status.occupied, queued: status.queued, note: waitingNote, help: status.help };
  const first = status.tasks.find((t) => t.task === o.task) ?? status.tasks.find((t) => t.state === "blocked") ?? status.tasks.find((t) => t.state === "review") ?? status.tasks.find((t) => !["working", "starting"].includes(t.state) && t.pane !== "pending");
  const saved = reports.get(first?.task);
  const help = status.tasks.some((t) => t.quota || t.state === "switching") || first?.code === "MONITOR_START_UNVERIFIED" || first?.delivery === "not_submitted" ? status.help : errors.length ? [`herdr-axi read ${errors[0].pane} --raw`, "herdr-axi run --help"]
    : first?.state === "review" && saved ? [saved.truncated ? `herdr-axi read ${first.pane} --full` : `herdr-axi run accept ${first.pane} --evidence "<verified checks>"`]
    : ["lost", "unverified"].includes(first?.state) ? [`herdr-axi run recover ${first.task}`, `herdr-axi run cancel ${first.task} --evidence 'Authorized stop; partial state and background jobs reviewed'`]
    : first ? [`herdr-axi read ${first.pane} --raw`] : status.help;
  return { ...status, events: events.map(({ summary, ...e }) => saved && e.pane === first.pane ? e : { ...e, summary }), ...(saved ? { report: { task: first.task, result: saved.result, ...(saved.truncated ? { truncated: true } : {}) } } : {}), ...(errors.length ? { errors: errors.slice(0, 8), ...(errors.length > 8 ? { moreErrors: errors.length - 8 } : {}), note: "Collection/report error: inspect and repair before acceptance; do not repeatedly fetch the same error." } : saved ? { note: "Review saved result/checks, then accept or revise. Read only if evidence is insufficient; terminal output may have changed since this report." } : {}), help };
}
