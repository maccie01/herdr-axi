// herdr backend adapter: spawn the herdr CLI, unwrap its JSON envelope,
// and translate herdr's wire shapes into AxiError at this boundary.
import { spawnSync } from "node:child_process";
import { AxiError } from "axi-sdk-js";

export const STATES = ["working", "blocked", "idle", "done", "unknown"];
export const TERMINAL_STATES = ["blocked", "idle", "done"];

const HERDR_BIN = process.env.HERDR_BIN || "herdr";

export function requireHerdrEnv() {
  if (process.env.HERDR_ENV !== "1") {
    throw new AxiError(
      "not running inside herdr",
      "HERDR_ENV_MISSING",
      ["Run this from a pane inside a herdr session.", "Check with: herdr status"],
    );
  }
}

export function runHerdr(args, { timeoutMs = 30_000 } = {}) {
  const r = spawnSync(HERDR_BIN, args, { encoding: "utf8", timeout: timeoutMs });
  if (r.error?.code === "ENOENT") {
    throw new AxiError(`herdr binary not found: ${HERDR_BIN}`, "HERDR_NOT_INSTALLED",
      ["Install herdr, or set HERDR_BIN to its path."]);
  }
  if (r.error?.code === "ETIMEDOUT") {
    throw new AxiError(`herdr ${args[0]} ${args[1] ?? ""} timed out after ${timeoutMs}ms`,
      "TIMEOUT", ["Raise --timeout-ms.", "Check the server: herdr status"]);
  }
  const stdout = (r.stdout || "").trim();
  let parsed;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch { parsed = null; }
  if (parsed?.error) {
    const msg = parsed.error.message || String(parsed.error);
    throw new AxiError(msg, mapErrorCode(msg), suggestFor(msg));
  }
  if (r.status !== 0) {
    const msg = (r.stderr || "").trim() || `herdr exited ${r.status}`;
    throw new AxiError(msg, mapErrorCode(msg), suggestFor(msg));
  }
  return parsed?.result ?? parsed;
}

function mapErrorCode(msg = "") {
  const m = msg.toLowerCase();
  if (m.includes("not found") || m.includes("no such agent") || m.includes("unknown agent")) return "UNKNOWN_AGENT";
  if (m.includes("timed out") || m.includes("timeout")) return "TIMEOUT";
  if (m.includes("connect") || m.includes("socket") || m.includes("server")) return "HERDR_UNREACHABLE";
  return "HERDR_CLI_ERROR";
}

function suggestFor(msg = "") {
  const code = mapErrorCode(msg);
  if (code === "UNKNOWN_AGENT") return ["List live agents: herdr-axi agents"];
  if (code === "HERDR_UNREACHABLE") return ["Check the server: herdr status"];
  return [];
}

// Minimal schema (AXI #2): 4 fields per agent, not the 15 herdr returns.
export function listAgents() {
  const result = runHerdr(["agent", "list"]);
  const rows = result?.agents ?? [];
  return rows.map((a) => ({
    name: a.terminal_title_stripped || a.pane_id,
    kind: a.agent,
    state: a.agent_status || "unknown",
    pane: a.pane_id,
    cwd: a.cwd,
    workspace: a.workspace_id,
    focused: !!a.focused,
  }));
}

export function findAgent(name) {
  const agents = listAgents();
  const hit = agents.find((a) => a.name === name || a.pane === name);
  if (!hit) {
    // Suggest pane ids, not titles: 16 terminal titles is a context bomb and
    // none of them are safely runnable as an argument.
    const ids = agents.map((a) => a.pane);
    const shown = ids.slice(0, 8).join(" ");
    throw new AxiError(`no agent named ${name}`, "UNKNOWN_AGENT",
      agents.length
        ? [`Live panes: ${shown}${ids.length > 8 ? ` (+${ids.length - 8} more)` : ""}`, "Full list: herdr-axi agents"]
        : ["No agents are live. Start one: herdr agent start <kind>"]);
  }
  return hit;
}

// Pre-computed aggregates (AXI #4): one call answers "what needs me?"
export function fleet(agents = listAgents()) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const a of agents) counts[a.state] = (counts[a.state] ?? 0) + 1;
  return {
    total: agents.length,
    counts,
    blocked: agents.filter((a) => a.state === "blocked"),
    working: agents.filter((a) => a.state === "working"),
    idle: agents.filter((a) => a.state === "idle"),
  };
}
