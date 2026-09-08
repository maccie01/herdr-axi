import fs from "node:fs";
import path from "node:path";
import { createHerdrEventSource } from "./herdr-events.mjs";

// Notifications are hints, never authoritative state. Reconcile on a timer too:
// native readiness/quota can change without a hook; fs.watch can lose events.
export function runWake(dir, { herdr, createConnection, watch = fs.watch } = {}) {
  let watcher, watchError, pending = false, pendingReason, resolveWait, timer;
  const signal = (reason = "filesystem") => {
    pending = true;
    pendingReason ??= reason;
    if (resolveWait) resolveWait();
  };
  try {
    watcher = watch(dir, { recursive: true }, (_, filename) => {
      const name = path.basename(String(filename ?? ""));
      // Ignore our own telemetry, watch records, locks and temporary writes.
      if (name === "run.json" || /\.event(?:\.inbox|\.monitor-error|\.proof\.[A-Za-z0-9]+)?$/.test(name)) signal();
    });
    watcher.on("error", (error) => {
      watchError = String(error?.message ?? error ?? "filesystem watch failed").slice(0, 300);
      const failed = watcher;
      watcher = undefined;
      failed?.close();
    });
  } catch (error) {
    watchError = String(error?.message ?? error ?? "filesystem watch unavailable").slice(0, 300);
  }
  const events = createHerdrEventSource({
    socketPath: herdr?.socketPath,
    subscriptions: herdr?.subscriptions,
    signal,
    ...(createConnection ? { createConnection } : {}),
  });
  return {
    ready(ms) { return events.ready(ms); },
    status() {
      return {
        herdr: events.status(),
        filesystem: { available: !!watcher, ...(watchError ? { error: watchError } : {}) },
      };
    },
    wait(ms) {
      if (pending) {
        const reason = pendingReason;
        pending = false;
        pendingReason = undefined;
        return Promise.resolve(reason);
      }
      return new Promise((resolve) => {
        resolveWait = () => {
          const reason = pendingReason ?? "timer";
          clearTimeout(timer); resolveWait = undefined; pending = false; pendingReason = undefined; resolve(reason);
        };
        timer = setTimeout(resolveWait, ms);
      });
    },
    close() { watcher?.close(); events.close(); resolveWait?.(); },
  };
}
