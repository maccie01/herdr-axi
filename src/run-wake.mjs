import fs from "node:fs";
import path from "node:path";

// Notifications are hints, never authoritative state. Reconcile on a timer too:
// native readiness/quota can change without a hook; fs.watch can lose events.
export function runWake(dir) {
  let watcher, pending = false, resolveWait, timer;
  const signal = () => {
    pending = true;
    if (resolveWait) resolveWait();
  };
  try {
    watcher = fs.watch(dir, { recursive: true }, (_, filename) => {
      const name = path.basename(String(filename ?? ""));
      // Ignore our own telemetry, watch records, locks and temporary writes.
      if (name === "run.json" || /\.event(?:\.inbox|\.monitor-error)?$/.test(name)) signal();
    });
    watcher.on("error", () => watcher.close());
  } catch { /* Timer reconciliation remains available on unsupported filesystems. */ }
  return {
    wait(ms) {
      if (pending) { pending = false; return Promise.resolve(); }
      return new Promise((resolve) => {
        resolveWait = () => {
          clearTimeout(timer); resolveWait = undefined; pending = false; resolve();
        };
        timer = setTimeout(resolveWait, ms);
      });
    },
    close() { watcher?.close(); resolveWait?.(); },
  };
}
