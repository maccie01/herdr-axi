import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDir, runError } from "./run-state.mjs";

export const engine = fileURLToPath(new URL("../engine/herdr-orchestrator.sh", import.meta.url));
const FRAME_LIMIT = 8192;

// A separate descriptor keeps backend output and worker text out of the
// control protocol. Discard overlong lines incrementally, including chunks
// without newlines, so neither output volume nor chunk boundaries grow memory.
export function engineErrorFrames() {
  let line = "", dropping = false, frame;
  return {
    push(chunk) {
      for (const part of String(chunk).split(/(?<=\n)/)) {
        if (!dropping) {
          if (line.length + part.length > FRAME_LIMIT) { line = ""; dropping = true; }
          else line += part;
        }
        if (!part.endsWith("\n")) continue;
        if (!dropping) {
          try {
            const value = JSON.parse(line);
            if (value?.schema === 1 && typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
              && typeof value.message === "string" && value.message.length <= 4096
              && (value.submitted === undefined || typeof value.submitted === "boolean")) {
              frame = { code: value.code, message: value.message, ...(value.submitted === undefined ? {} : { submitted: value.submitted }) };
            }
          } catch { /* malformed diagnostics cannot become control state */ }
        }
        line = ""; dropping = false;
      }
    },
    result: () => frame,
  };
}

export function engineCall(args, run) {
  return new Promise((resolve, reject) => {
    const directory = runDir();
    const child = spawn("bash", [engine, ...args], {
      cwd: directory,
      env: { ...process.env, HERDR_AXI_ENGINE_PROTOCOL: "1", HERDR_AXI_NODE: process.execPath,
        // Resolve before changing cwd to the run directory; the native worker
        // and its transcript verifier must share the caller's Codex home.
        ...(process.env.CODEX_HOME ? { CODEX_HOME: path.resolve(process.env.CODEX_HOME) } : {}),
        HERDR_ENV: "1", HERDR_RECEIPT_ROOT: path.join(directory, "receipts"),
        HERDR_WORKSPACE_ID: run.workspace, HERDR_MONITOR_INBOX: "1", HERDR_AXI_MANAGED_TASK: "1",
        HERDR_AXI_AGENT_RATIO: String(run.config?.agentRatio ?? 0.75),
        HERDR_AXI_OWNER_PANE: run.owner.pane, HERDR_AXI_OWNER_TAB: run.owner.tab },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    let out = "", diagnostic = "";
    const frames = engineErrorFrames();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdio[3].setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out = (out + chunk).slice(-32000); });
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000); });
    child.stdio[3].on("data", (chunk) => frames.push(chunk));
    child.on("error", (error) => reject(runError(`Engine could not start: ${error.message}`, "ENGINE_ERROR")));
    child.on("close", (code, signal) => {
      if (code === 0) { resolve(out); return; }
      const frame = frames.result();
      const detail = frame ? `${frame.code}: ${frame.message}` : diagnostic.trim();
      const error = runError(`Engine failed (${signal ?? code}); inspect before retrying. ${detail}`, frame?.code ?? "ENGINE_ERROR");
      if (frame?.submitted !== undefined) error.submitted = frame.submitted;
      if (frame && diagnostic.trim()) error.diagnostic = diagnostic.trim();
      reject(error);
    });
  });
}
