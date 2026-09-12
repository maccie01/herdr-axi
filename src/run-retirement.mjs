import fs from "node:fs";
import path from "node:path";
import { captureCheckpoint } from "./run-evidence.mjs";
import { runHerdr, listAgents, integrationKinds } from "./herdr.mjs";
import { runError, runDir, taskFor, changeRun, registeredWorker, ownedWorkers, receipt, pending } from "./run-state.mjs";
import { writerLease, selectWorker, DEFAULT_CONFIG, nativeSlots, hash } from "./project.mjs";
import { safeWorker } from "./worker-identity.mjs";
import { launcherAlive, startupProcessAbsent, publishRun } from "./run-control.mjs";
import { engineCall } from "./engine-client.mjs";
import { quotaError } from "./quota.mjs";

async function retireWorker(run, worker, mode) {
  await engineCall(["close", worker.name, mode, path.join(runDir(), "run.json")], run);
  for (const [kind, id] of [["tab", worker.tab], ["pane", worker.pane], ["pane", worker.monitor]]) {
    if (!id && kind === "pane" && worker.stage === "created") continue;
    try { runHerdr([kind, "get", id]); throw runError("Registered resources remain", mode === "--cancel" ? "CANCEL_PENDING" : "SWITCH_PENDING"); }
    catch (e) { if (e.code !== "UNKNOWN_AGENT") throw e; }
  }
}

export async function runCancel(run, o) {
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
  const worker = task.cancellation?.from ?? ownedWorkers(run, { issues: [] }).find((w) => w.name === task.name && !w.closed);
  if (!worker && !task.pane && ["starting", "uncertain"].includes(task.state)) {
    // Missing is not corrupt. Never adopt or close inferred topology. Startup
    // writes its registry before starting an agent; verify no named agent is
    // present and require explicit cancellation evidence after launcher exit.
    startupProcessAbsent(task);
    if (registeredWorker(run, task) || rows.some((a) => a.backendName === task.name)) throw runError("Unregistered worker may still exist; inspect before cancellation", "WORKER_CHANGED");
    changeRun((r, { afterCommit }) => {
      const t = r.tasks.find((t) => t.id === task.id);
      if (t.state !== task.state || t.launcher !== task.launcher || t.pane || registeredWorker(r, t)) throw runError("Startup changed; inspect before cancellation", "RUN_BUSY");
      t.cancellation = { at: new Date().toISOString(), evidence: o.evidence, capture: { source: "no-registry", truncated: true } };
      t.state = "cancelled"; t.evidence = o.evidence.slice(0, 1000); delete t.launcher;
      afterCommit.push(() => writerLease(r, t, true));
    });
    return { cancelled: task.id, closed: [], note: "Launcher absent; no registry or named agent. Reservation released after cancellation. No topology inferred or tabs closed; inspect any shell-only startup tab separately.", help: ["herdr-axi run next"] };
  }
  const live = safeWorker(run, worker, rows);
  let checkpoint = task.cancellation;
  if (!checkpoint) {
    const captured = captureCheckpoint(task.cwd, live ? worker.pane : undefined);
    checkpoint = { at: new Date().toISOString(), from: worker, evidence: o.evidence, ...captured };
  }
  changeRun((r) => {
    const t = r.tasks.find((t) => t.id === task.id);
    if (t.state !== task.state || t.launcher !== task.launcher || t.name !== task.name) throw runError("Task changed; retry", "RUN_BUSY");
    t.cancellation = checkpoint; t.state = "cancelling"; t.launcher = process.pid; t.pane = worker.pane;
    if (!r.workers.some((w) => w.name === worker.name)) r.workers.push(worker);
  });
  try {
    await retireWorker(run, worker, "--cancel");
    await publishRun((r, { afterCommit }) => {
      const t = r.tasks.find((t) => t.id === task.id);
      if (t.state !== "cancelling" || t.cancellation.from.generation !== worker.generation) throw runError("Cancellation changed", "CANCEL_PENDING");
      r.workers.find((w) => w.name === worker.name).closed = true;
      t.state = "cancelled"; t.evidence = checkpoint.evidence.slice(0, 1000);
      delete t.launcher; delete t.error; delete t.errorCode;
      afterCommit.push(() => writerLease(r, t, true));
    });
  } catch (e) {
    try { await publishRun((r) => { const t = r.tasks.find((t) => t.id === task.id); if (t.state === "cancelling") { delete t.launcher; t.error = e.message.slice(0, 600); t.errorCode = e.code; } }); } catch { /* durable checkpoint retains capacity and lease */ }
    if (e.code === "GENERATION_DRIFT") throw runError(`Generation mismatch; cancellation retained, not retriable unchanged. Do not edit receipts or close raw panes. ${e.message}`, "GENERATION_DRIFT", [`herdr-axi run history --task ${task.id}`, `herdr-axi read ${worker.pane} --raw`]);
    throw runError(`Cancellation incomplete; checkpoint and reservation retained: ${e.message}`, "CANCEL_PENDING", [retry]);
  }
  return { cancelled: task.id, closed: worker.pane, tab: worker.tab, capture: checkpoint.capture.source, note: "Owned tab, agent and monitor verified absent. Not accepted; files/worktree untouched. Bounded checkpoint saved; detached jobs are not stopped. Remove external worktrees only after reviewing saved/dirty work, never as a way to close panes.", help: ["herdr-axi run status"] };
}

export async function runSwitch(run, o, rows) {
  const workers = ownedWorkers(run, { issues: [] });
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
      delete t.launcher; delete t.error; delete t.errorCode;
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
    const available = integrationKinds();
    const target = o.role
      ? selectWorker(config, { role: o.role }, available)
      : selectWorker(config, { kind: o.kind, model: o.model, effort: o.effort, access: task.access }, available, { requireExplicitModel: true });
    if (!target || o.role === "orchestrator" || target.kind === task.kind || target.access !== task.access) throw runError("Choose another provider with the same read/write access", "CONFIG_INVALID");
    if (pending(run).reduce((n, t) => n + (t.nativeSlots ?? 0), 0) - (task.nativeSlots ?? 0) + nativeSlots(target) > config.nativeSubagentLimit) throw runError("Replacement exceeds native subagent budget", "CAPACITY_FULL");
    if (o.summary !== undefined && (!o.summary.trim() || o.summary.length > 4000)) throw runError("--summary must contain 1..4000 characters");
    const visible = runHerdr(["agent", "read", worker.pane, "--source", "visible", "--lines", "40"], { timeoutMs: 2000, text: true });
    const quota = quotaError(visible);
    if (!quota) throw runError("No current quota/session-limit error; refusing an incomplete close", "QUOTA_NOT_CONFIRMED", [`herdr-axi read ${worker.pane} --raw`]);
    const checkpoint = captureCheckpoint(task.cwd, worker.pane, { visible });
    handoff = { at: new Date().toISOString(), priorState: task.state, from: worker, to: { ...target, role: o.role || task.role, subagents: target.subagents ?? [] }, quota, summary: o.summary || "", ...checkpoint, capture: { ...checkpoint.capture, lines: checkpoint.capture.source === "history" ? 2000 : 40, chars: 32000 }, state: "prepared" };
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
    await retireWorker(run, handoff.from, "--handoff");
    await publishRun((r, effects) => {
      const t = r.tasks.find((t) => t.id === task.id);
      if (t.state !== "switching" || t.handoffs.at(-1).from.generation !== handoff.from.generation) throw runError("Switch generation changed", "SWITCH_PENDING");
      const w = r.workers.find((w) => w.pane === handoff.from.pane);
      if (w) w.closed = true;
      delete t.contextWindowTokens;
      Object.assign(t, handoff.to, { policy: hash(JSON.stringify(handoff.to)), nativeSlots: nativeSlots(handoff.to), state: "queued" });
      delete t.pane; delete t.name; delete t.launcher; delete t.error; delete t.errorCode;
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
    try { await publishRun((r) => { const t = r.tasks.find((t) => t.id === task.id); if (t.state === "switching") { delete t.launcher; t.error = e.message.slice(0, 600); t.errorCode = e.code; } }); } catch { /* checkpoint and lease remain durable */ }
    if (e.code === "GENERATION_DRIFT") throw runError(`Generation mismatch; switch retained, not retriable unchanged. Do not edit receipts or close raw panes. ${e.message}`, "GENERATION_DRIFT", [`herdr-axi run history --task ${task.id}`, `herdr-axi read ${handoff.from.pane} --raw`]);
    throw runError(`Switch incomplete; checkpoint and lease retained: ${e.message}`, "SWITCH_PENDING", [`herdr-axi run switch ${task.id}`, `herdr-axi run switch ${task.id} --cancel`]);
  }
  return { switched: task.id, kind: handoff.to.kind, model: handoff.to.model, state: "queued", cwd: task.cwd, note: "Old owned tab retired without accepting the task. Files, original prompt, checkpoint and lease retained; no Git writes. Next starts the replacement. Terminal capture is bounded, not full model-context restoration.", help: [task.phase === run.phase ? "herdr-axi run next" : `herdr-axi run phase ${task.phase}`] };
}
