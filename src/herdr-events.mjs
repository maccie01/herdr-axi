import net from "node:net";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_RECONNECT_DELAYS = [100, 250, 500, 1000, 2000, 5000];

const inactiveSource = (reason) => ({
  ready: async () => ({ enabled: false, connected: false, available: false, reason }),
  status: () => ({ enabled: false, connected: false, available: false, reason }),
  close() {},
});

// Herdr subscription events are ordered within one connection but expose no
// resumable sequence. Callers must reconcile authoritative state after every
// reconnect; this source deliberately emits only wake/resync hints.
export function createHerdrEventSource({
  socketPath,
  subscriptions,
  signal,
  createConnection = (path) => net.createConnection({ path }),
  reconnectDelays = DEFAULT_RECONNECT_DELAYS,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
} = {}) {
  if (!socketPath || !Array.isArray(subscriptions) || !subscriptions.length)
    return inactiveSource("not-configured");
  if (typeof signal !== "function") throw new TypeError("Herdr event source needs a signal callback");
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1024)
    throw new RangeError("Herdr event maxLineBytes must be an integer >= 1024");

  const requestId = `herdr-axi:${randomUUID()}`;
  const request = `${JSON.stringify({ id: requestId, method: "events.subscribe", params: { subscriptions } })}\n`;
  if (Buffer.byteLength(request) > maxLineBytes) throw new RangeError("Herdr subscription request is too large");

  const state = {
    enabled: true,
    connected: false,
    available: null,
    reconnects: 0,
    lastError: null,
  };
  let socket, reconnectTimer, closed = false, attempt = 0, everAcknowledged = false;
  let bootstrapUncertain = false;
  let settleFirstReady;
  const firstReady = new Promise((resolve) => { settleFirstReady = resolve; });
  let firstReadySettled = false;
  const settleReady = () => {
    if (!firstReadySettled) {
      firstReadySettled = true;
      settleFirstReady();
    }
  };
  const snapshot = () => ({ ...state });
  const rememberError = (error) => {
    state.lastError = String(error?.message ?? error ?? "unknown socket error").slice(0, 300);
  };

  const scheduleReconnect = () => {
    if (closed || state.available === false || reconnectTimer) return;
    const delay = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)] ?? 5000;
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed) return;
    let current;
    try { current = createConnection(socketPath); }
    catch (error) { rememberError(error); scheduleReconnect(); return; }
    socket = current;
    let acknowledged = false, buffer = "";
    current.setEncoding?.("utf8");
    current.setNoDelay?.(true);

    const protocolFailure = (message) => {
      rememberError(message);
      current.destroy();
    };
    const acceptLine = (line) => {
      if (Buffer.byteLength(line) > maxLineBytes) return protocolFailure("Herdr event line exceeded the configured limit");
      let message;
      try { message = JSON.parse(line); }
      catch { return protocolFailure("Herdr event stream returned invalid JSON"); }
      if (!acknowledged) {
        if (message?.id !== requestId) return protocolFailure("Herdr subscription acknowledgement id did not match");
        if (message.error) {
          state.available = false;
          state.connected = false;
          rememberError(`${message.error.code ?? "subscription_error"}: ${message.error.message ?? "subscription rejected"}`);
          settleReady();
          current.destroy();
          return;
        }
        if (message?.result?.type !== "subscription_started")
          return protocolFailure("Herdr subscription acknowledgement had an unexpected shape");
        acknowledged = true;
        state.connected = true;
        state.available = true;
        state.lastError = null;
        attempt = 0;
        settleReady();
        if (everAcknowledged || bootstrapUncertain) signal("herdr-resync");
        everAcknowledged = true;
        return;
      }
      if (typeof message?.event === "string") signal("herdr-event");
    };

    current.once("connect", () => current.write(request));
    current.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) acceptLine(line);
        if (current.destroyed) return;
      }
      if (Buffer.byteLength(buffer) > maxLineBytes)
        protocolFailure("Herdr event buffer exceeded the configured limit");
    });
    current.on("error", rememberError);
    current.once("close", () => {
      if (socket === current) socket = undefined;
      state.connected = false;
      if (!closed && state.available !== false) {
        if (acknowledged) state.reconnects += 1;
        scheduleReconnect();
      }
    });
  };

  connect();
  return {
    async ready(timeoutMs = 500) {
      if (firstReadySettled) return snapshot();
      let timer;
      const acknowledged = await Promise.race([
        firstReady.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); }),
      ]);
      clearTimeout(timer);
      if (!acknowledged) bootstrapUncertain = true;
      return snapshot();
    },
    status: snapshot,
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      socket?.destroy();
      settleReady();
    },
  };
}

export function runSubscriptions(run) {
  const panes = [...new Set((run?.workers ?? []).filter((worker) => !worker.closed && worker.pane).map((worker) => worker.pane))];
  return [
    ...panes.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    // New/replacement workers cannot have a pane-scoped status subscription yet.
    // Detection wakes reconciliation; the resulting state change ends this watch,
    // and the next invocation rebuilds its pane-specific subscriptions.
    { type: "pane.agent_detected" },
    { type: "pane.exited" },
    { type: "pane.closed" },
    { type: "tab.closed" },
  ];
}
