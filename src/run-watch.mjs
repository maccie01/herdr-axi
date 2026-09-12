import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runHerdr } from "./herdr.mjs";
import { runError, loadRun, runDir, ownedWorkers, changeRun, controlActive, processStart } from "./run-state.mjs";
import { ownerCheck, callerPane } from "./run-control.mjs";
import { runStatus, needsAttention, waitingNote } from "./run-observation.mjs";
import { runWake } from "./run-wake.mjs";
import { runSubscriptions } from "./herdr-events.mjs";

// Compare actionable state, not telemetry timestamps/percentages or display text.
const watchKey = (s) => JSON.stringify({ phase: s.phase, capacity: s.capacity, occupied: s.occupied, queued: s.queued, tasks: s.tasks, parked: s.parked, parkedAttention: s.parkedAttention, ownershipIssues: s.ownershipIssues, finished: s.finished, contextError: s.contextError, contextWarnings: s.contextWarnings?.map(({ pane, level }) => ({ pane, level })) });

export async function watchRun(timeout = 30000, task, collectInbox) {
  const selected = loadRun();
  if (!selected?.finishedAt) ownerCheck(selected);
  if (task && !selected.tasks.some((t) => t.id === task)) throw runError(`Unknown task: ${task}`, "UNKNOWN_TASK", ["herdr-axi run status"]);
  const subscriptions = selected?.finishedAt ? [] : runSubscriptions({ workers: ownedWorkers(selected) });
  let proofError, unproven;
  // Task-scoped waits leave other unresolved work visible, but it must not
  // repeatedly wake a coordinator waiting on an independent dependency.
  const focus = (s) => {
    if (!task) return s;
    let current = s.tasks?.find((t) => t.task === task);
    unproven = undefined;
    if (current && ["idle", "done"].includes(current.state) && !current.delivery && !current.code) {
      const w = loadRun().workers.find((w) => w.pane === current.pane && !w.closed);
      // Intermediate native settlement isn't a result. A late proof IS a
      // reason to wake and collect through inbox, even before the hook ran.
      if (w) {
        let valid = false;
        proofError = undefined;
        try {
          const file = `${w.receipt}.proof.${w.generation}`, expected = `${w.generation}\n`;
          const stat = fs.statSync(file);
          // Same exact line and byte-count contract as herdr_completion_proof_valid.
          valid = stat.isFile() && stat.size === Buffer.byteLength(expected) && fs.readFileSync(file, "utf8") === expected;
          if (!valid) proofError = { pane: w.pane, code: "INVALID_COMPLETION_PROOF", error: "Completion proof does not match this generation; no result available. Inspect the worker once; never synthesize its proof." };
        } catch (e) {
          if (e.code !== "ENOENT") proofError = { pane: w.pane, code: "COMPLETION_PROOF_UNAVAILABLE", error: e.message.slice(0, 300) };
        }
        if (!valid) { unproven = { pane: w.pane, state: current.state }; current = { ...current, state: "working" }; }
      }
    }
    return { owner: s.owner, finished: s.finished, tasks: current ? [current] : [], contextError: s.contextError, contextWarnings: s.contextWarnings?.filter((w) => w.pane === current?.pane), ownershipIssues: s.ownershipIssues?.filter((i) => i.task === task) };
  };
  const file = path.join(runDir() ?? ".", "watch.json");
  changeRun(() => {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw runError("Unverifiable watch record; inspect watch.json", "WATCH_ACTIVE"); }
    if (previous && (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || controlActive(file, previous.pid))) throw runError("One watch is active or its identity is unverifiable; keep the existing job handle and continue independent work", "WATCH_ACTIVE", ["herdr-axi watch --help"]);
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, started: processStart(process.pid), action: "watch" }), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }, { readOnly: true, allowFinished: true });
  const wake = runWake(runDir(), {
    herdr: {
      socketPath: selected.herdr?.socket,
      subscriptions,
    },
  });
  try {
    await wake.ready(500);
    const wakeMetadata = () => {
      const state = wake.status();
      const transports = [state.herdr.connected ? "herdr-events" : null, state.filesystem.available ? "filesystem" : null, "timer"].filter(Boolean);
      const degraded = [state.herdr.enabled && !state.herdr.connected ? state.herdr.lastError : null, state.filesystem.error].filter(Boolean);
      return {
        wakeTransport: transports.join("+"),
        ...(degraded.length ? { wakeDegraded: degraded.join("; ").slice(0, 600) } : {}),
        ...(state.herdr.reconnects ? { wakeReconnects: state.herdr.reconnects } : {}),
      };
    };
    const first = runStatus();
    const attention = async (s, changed, reason) => ({ changed, reason, ...wakeMetadata(), ...(task ? { watching: task } : {}), ...(focus(s).tasks?.some((t) => ["review", "idle", "done"].includes(t.state) || t.quota) && s.owner === callerPane() ? await collectInbox(task) : s), ...(s.contextError ? { contextError: s.contextError } : {}) });
    // Existing diagnostic failures remain visible without turning repeated waits
    // into an immediate attention loop. New failures still change watchKey.
    if (!focus(first).tasks?.length || needsAttention({ ...focus(first), contextError: undefined })) return await attention(first, false, "attention");
    const key = watchKey(focus(first));
    let latest = first;
    const start = Date.now();
    let interval = 2000, lastProbe = start;
    while (Date.now() - start < timeout) {
      await wake.wait(Math.min(interval, timeout - (Date.now() - start)));
      // Coalesce hook bursts; never turn filesystem noise into a backend hot loop.
      await delay(Math.max(0, Math.min(250 - (Date.now() - lastProbe), timeout - (Date.now() - start))));
      latest = runStatus();
      lastProbe = Date.now();
      interval = Math.min(interval * 2, 10000);
      if (!latest.finished && latest.owner !== first.owner) return { changed: true, reason: "owner-changed", ...wakeMetadata(), owner: latest.owner, note: "Stop old-owner supervision; replacement owns this run." };
      if (key !== watchKey(focus(latest))) return await attention(latest, true, "state-change");
    }
    const view = focus(latest);
    // Intermediate native settlement waits for proof only through this timeout.
    if (unproven && !proofError) {
      let output;
      try { output = runHerdr(["agent", "read", unproven.pane, "--source", "visible", "--lines", "24"], { timeoutMs: 1000, text: true }).slice(-2400); }
      catch { /* diagnostic only; the reported native state stands */ }
      return { changed: false, reason: "missing-proof", ...wakeMetadata(), watching: task, pane: unproven.pane, state: unproven.state, pending: view.tasks.length, ...(latest.contextError ? { contextError: latest.contextError } : {}),
        ...(output ? { output, outputLimit: "last 24 lines / 2400 characters; expand only if insufficient" } : {}),
        note: "Native turn settled without this generation's completion receipt; no validated completion is available. Inspect the worker once and resolve what it is waiting for; never synthesize proof, accept unfinished work or resend the prompt.",
        help: [`herdr-axi read ${unproven.pane} --raw --lines 60 --chars 8000`, "herdr-axi run inbox"] };
    }
    return { changed: false, reason: "timeout", ...wakeMetadata(), ...(task ? { watching: task } : {}), pending: view.tasks.length, ...(latest.contextError ? { contextError: latest.contextError } : {}), ...(proofError ? { proofError } : {}), note: waitingNote, help: proofError ? [`herdr-axi read ${proofError.pane} --raw`] : task ? [`herdr-axi watch --task ${task}`] : latest.help };
  } finally { wake.close(); fs.rmSync(file, { force: true }); }
}
