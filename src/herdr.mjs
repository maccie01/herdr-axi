// herdr backend adapter: spawn the herdr CLI, unwrap its JSON envelope,
// and translate herdr's wire shapes into AxiError at this boundary.
import { spawnSync } from "node:child_process";
import { AxiError } from "axi-sdk-js";
import { ownedRows, isSelf } from "./run-state.mjs";

export const STATES = ["working", "blocked", "idle", "done", "unknown"];

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

export function runHerdr(args, { timeoutMs = 30_000, text = false } = {}) {
  const r = spawnSync(HERDR_BIN, args, { encoding: "utf8", timeout: timeoutMs });
  if (r.error?.code === "ENOENT") {
    throw new AxiError(`herdr binary not found: ${HERDR_BIN}`, "HERDR_NOT_INSTALLED",
      ["Install herdr, or set HERDR_BIN to its path."]);
  }
  if (r.error?.code === "ETIMEDOUT") {
    throw new AxiError(`herdr ${args[0]} ${args[1] ?? ""} timed out after ${timeoutMs}ms`,
      "TIMEOUT", ["Raise --timeout-ms.", "Check the server: herdr status"]);
  }
  // Remove only the CLI's final newline; --raw must retain terminal padding.
  if (text && r.status === 0) return (r.stdout || "").replace(/\r?\n$/, "");
  const stdout = (r.stdout || "").trim();
  let parsed;
  try { parsed = JSON.parse(r.status === 0 ? stdout : (r.stderr || stdout)); } catch { parsed = null; }
  if (parsed?.error) {
    const msg = parsed.error.message || String(parsed.error);
    const code = mapErrorCode(msg, parsed.error.code);
    throw new AxiError(msg, code, suggestFor(code, args[2]));
  }
  if (r.status !== 0) {
    const msg = (r.stderr || "").trim() || `herdr exited ${r.status}`;
    const code = mapErrorCode(msg);
    throw new AxiError(msg, code, suggestFor(code, args[2]));
  }
  if (!parsed) throw new AxiError("herdr returned invalid JSON", "HERDR_CLI_ERROR", ["Check the server: herdr status"]);
  return parsed?.result ?? parsed;
}

function mapErrorCode(msg = "", wireCode = "") {
  if (["agent_not_found", "pane_not_found", "agent_not_running"].includes(wireCode)) return "UNKNOWN_AGENT";
  if (wireCode === "agent_blocked") return "AGENT_BLOCKED";
  if (wireCode === "agent_prompt_stalled") return "PROMPT_STALLED";
  if (wireCode === "timeout") return "TIMEOUT";
  const m = msg.toLowerCase();
  if (m.includes("alternate-screen history")) return "READ_UNAVAILABLE";
  if (m.includes("unknown option") || m.includes("invalid value")) return "HERDR_CLI_ERROR";
  if (m.includes("not found") || m.includes("no such agent") || m.includes("unknown agent")) return "UNKNOWN_AGENT";
  if (m.includes("timed out") || m.includes("timeout")) return "TIMEOUT";
  if (m.includes("connect") || m.includes("socket") || m.includes("server")) return "HERDR_UNREACHABLE";
  return "HERDR_CLI_ERROR";
}

function suggestFor(code, pane) {
  if (code === "UNKNOWN_AGENT") return ["List live agents: herdr-axi agents"];
  if (code === "HERDR_UNREACHABLE") return ["Check the server: herdr status"];
  if (code === "TIMEOUT") return ["Inspect current state: herdr-axi agents", ...(pane ? [`Wait longer: herdr-axi wait ${pane} --timeout-ms 300000`] : [])];
  if (["AGENT_BLOCKED", "PROMPT_STALLED", "READ_UNAVAILABLE"].includes(code)) return [`Inspect current output: herdr-axi read ${pane}`];
  return ["Check the server: herdr status"];
}

// Minimal schema (AXI #2): 4 fields per agent, not the 15 herdr returns.
export function listAgents(options = {}) {
  const result = runHerdr(["agent", "list"]);
  const rows = result?.agents ?? [];
  return ownedRows(rows.map(projectAgent), options);
}

export function projectAgent(a) {
  return {
    name: (a.name || a.terminal_title_stripped || a.pane_id).slice(0, 100),
    kind: a.agent,
    state: STATES.includes(a.agent_status) ? a.agent_status : "unknown",
    pane: a.pane_id,
    cwd: a.cwd,
    workspace: a.workspace_id,
    tab: a.tab_id,
    terminal: a.terminal_id,
    session: a.agent_session?.value,
    backendName: a.name,
    focused: !!a.focused,
  };
}

export function findAgent(name) {
  if (isSelf(name)) throw new AxiError("refusing to target the orchestrator itself", "SELF_TARGET", ["herdr-axi fleet"]);
  const agents = listAgents();
  const hit = agents.find((a) => a.pane === name);
  if (!hit) {
    // Suggest pane ids, not titles: 16 terminal titles is a context bomb and
    // none of them are safely runnable as an argument.
    const ids = agents.map((a) => a.pane);
    const shown = ids.slice(0, 8).join(" ");
    throw new AxiError(`no agent in pane ${name}`, "UNKNOWN_AGENT",
      agents.length
        ? [`Live panes: ${shown}${ids.length > 8 ? ` (+${ids.length - 8} more)` : ""}`, "Full list: herdr-axi agents"]
        : ["No matching owned agent. Inspect: herdr-axi agents", "Delegation workflow: herdr-axi run --help"]);
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
    done: agents.filter((a) => a.state === "done"),
    unknown: agents.filter((a) => a.state === "unknown"),
  };
}
