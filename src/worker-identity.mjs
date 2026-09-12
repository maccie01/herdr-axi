import { runError } from "./run-state.mjs";

export const pendingInitialization = (worker) => worker?.kind === "codex" && worker.stage === "created"
  && worker.bootstrap?.schema === 1 && worker.bootstrap.state === "sending";

const unsubmitted = (worker) => ["created", "rejected"].includes(worker.stage);

export function safeWorker(run, worker, rows, { observe = false, generationAdvance = false } = {}) {
  try {
    if (!worker || worker.closed) throw runError("Pane is not a live owned worker", "NOT_OWNED");
    const supervisors = [run.owner, ...(run.ownerHandoffs ?? []).map((handoff) => handoff.from)];
    if (supervisors.some((owner) => worker.pane === owner.pane || worker.tab === owner.tab)
      || worker.pane === process.env.HERDR_PANE_ID || worker.tab === process.env.HERDR_TAB_ID) {
      throw runError("Refusing an operation on the orchestrator or its tab", "SELF_TARGET");
    }
    const live = rows.find((agent) => agent.pane === worker.pane);
    if (!live) return undefined;
    // Created/rejected startups may be cancelled or recovered before a native
    // session exists. Submitted assignments require that session as authority.
    if (!(worker.terminal || worker.session) || (!unsubmitted(worker) && !generationAdvance && !worker.session)) {
      throw runError("Native worker session identity was not recorded; cannot control the current occupant", "WORKER_CHANGED");
    }
    if (live.workspace !== run.workspace || live.tab !== worker.tab || live.backendName !== worker.name
      || (worker.terminal && live.terminal !== worker.terminal)
      || (!generationAdvance && worker.session && live.session !== worker.session)) {
      throw runError("Worker identity changed", "WORKER_CHANGED");
    }
    // Rearm may intentionally rotate the native session; terminal identity must
    // still link the old and new generation before the new record is checked.
    if (generationAdvance && !worker.terminal) throw runError("Cannot verify generation transition without terminal identity", "WORKER_CHANGED");
    return live;
  } catch (error) {
    if (observe && ["NOT_OWNED", "SELF_TARGET", "WORKER_CHANGED"].includes(error.code)) return null;
    throw error;
  }
}
