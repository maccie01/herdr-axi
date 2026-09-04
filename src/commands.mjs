import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AxiError } from "axi-sdk-js";
import { listAgents, findAgent, fleet, runHerdr, requireHerdrEnv, projectAgent, STATES } from "./herdr.mjs";

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "engine");

// Fail loud on unknown flags (AXI #6) - a typo must never silently no-op.
function parseArgs(args, spec) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const [flag, inline] = a.slice(2).split("=", 2);
    if (!(flag in spec)) {
      throw new AxiError(`unknown flag: --${flag}`, "UNKNOWN_FLAG",
        [`Valid flags: ${Object.keys(spec).map((f) => "--" + f).join(", ") || "(none)"}`, "herdr-axi --help"]);
    }
    if (spec[flag] === "boolean") out[flag] = true;
    else { const v = inline ?? args[++i]; if (v === undefined || v.startsWith("--")) throw new AxiError(`--${flag} needs a value`, "MISSING_VALUE", ["herdr-axi --help"]); out[flag] = v; }
  }
  return out;
}

function positiveInt(value, flag) {
  const n = Number(value);
  // Leave room for the backend timeout's 5-second process-exit allowance.
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_478_647)
    throw new AxiError(`--${flag} needs a positive integer`, "INVALID_VALUE", ["herdr-axi --help"]);
  return n;
}

// Suggestions always address agents by pane id: names are terminal titles that
// contain spaces, so a name-based suggestion is a command the agent cannot run.
const nextSteps = (f) => {
  for (const state of ["blocked", "unknown", "done"])
    if (f[state].length) return [`herdr-axi read ${f[state][0].pane}`];
  if (f.working.length) return [`herdr-axi wait ${f.working[0].pane} --until idle`];
  if (f.idle.length) return [`herdr-axi dispatch ${f.idle[0].pane} "<task>"`];
  return ["herdr agent start --help"];
};

const brief = (rows) => rows.map((a) => a.pane);

export function home() {
  const f = fleet();
  if (!f.total) return { fleet: "0 agents", help: ["No live herdr agents.", "Startup usage: herdr agent start --help"] };
  return {
    fleet: `${f.total} agents: ` + STATES.filter((s) => f.counts[s]).map((s) => `${f.counts[s]} ${s}`).join(", "),
    ...(f.blocked.length ? { blocked: brief(f.blocked) } : {}),
    ...(f.working.length ? { working: brief(f.working) } : {}),
    ...(f.idle.length ? { idle: brief(f.idle) } : {}),
    ...(f.done.length ? { done: brief(f.done) } : {}),
    ...(f.unknown.length ? { unknown: brief(f.unknown) } : {}),
    help: nextSteps(f),
  };
}

export function agents(args) {
  const o = parseArgs(args, { state: "string", kind: "string" });
  if (o.state && !STATES.includes(o.state))
    throw new AxiError(`invalid state: ${o.state}`, "INVALID_STATE", [`Valid: ${STATES.join(", ")}`, "herdr-axi agents --help"]);
  let rows = listAgents();
  if (o.state) rows = rows.filter((a) => a.state === o.state);
  if (o.kind) rows = rows.filter((a) => a.kind === o.kind);
  if (!rows.length) return { agents: "0 matching agents", help: ["Widen the filter, or: herdr-axi agents"] };
  return { agents: rows.map(({ name, kind, state, pane }) => ({ name, kind, state, pane })), help: nextSteps(fleet(rows)) };
}

export function fleetCmd() {
  const f = fleet();
  return { total: f.total, counts: f.counts, blocked: brief(f.blocked), working: brief(f.working), idle: brief(f.idle), done: brief(f.done), unknown: brief(f.unknown), help: nextSteps(f) };
}

export function read(args) {
  const o = parseArgs(args, { lines: "string", chars: "string", full: "boolean", compact: "boolean" });
  const name = o._[0];
  if (!name) throw new AxiError("read needs a pane ID", "MISSING_ARG", ["herdr-axi read --help"]);
  const a = findAgent(name);
  const lines = o.full ? 2000 : positiveInt(o.lines ?? 60, "lines");
  const chars = o.chars !== undefined ? positiveInt(o.chars, "chars") : (o.full ? Infinity : 8000);
  const text = runHerdr(["agent", "read", a.pane, "--source", o.full ? "recent-unwrapped" : "visible", "--lines", String(lines + 1)], { timeoutMs: 20000, text: true });
  const all = text.split("\n");
  // Truncate with a size hint and an escape hatch (AXI #3).
  const shown = all.slice(-lines);
  let output = shown.join("\n");
  if (o.compact) {
    // Opt-in: border-only diagram rows and terminal padding are layout, too.
    output = output.split("\n")
      .map((line) => line.trimEnd().replace(/[ \t]+([│┃])$/, " $1"))
      .filter((line) => !/^[ \t]*[\u2500-\u259f][\s\u2500-\u259f]*$/u.test(line))
      .join("\n").replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").replace(/^\n+/, "");
  }
  const characters = Array.from(output);
  const clipped = characters.length > chars;
  output = characters.slice(-chars).join("");
  return {
    pane: a.pane, state: a.state,
    output: output || "(no visible output)",
    ...(all.length > shown.length || clipped ? { truncated: [all.length > shown.length ? `${lines}-line cap` : "", clipped ? `${chars}-character cap` : ""].filter(Boolean).join(", ") } : {}),
    ...(o.compact ? { compact: true } : {}),
    ...(all.length > shown.length || clipped ? { help: [o.full && all.length > shown.length ? "History limit; ask the agent to write a file." : `herdr-axi read ${a.pane} --full`] } : a.state === "blocked" ? { help: ["herdr-axi dispatch --help"] } : {}),
  };
}

export function wait(args) {
  const o = parseArgs(args, { until: "string", "timeout-ms": "string" });
  const name = o._[0];
  if (!name) throw new AxiError("wait needs a pane ID", "MISSING_ARG", ["herdr-axi wait --help"]);
  const until = o.until ?? "idle";
  if (!STATES.includes(until)) throw new AxiError(`invalid state: ${until}`, "INVALID_STATE", [`Valid: ${STATES.join(", ")}`, "herdr-axi wait --help"]);
  const a = findAgent(name);
  const timeout = positiveInt(o["timeout-ms"] ?? 300000, "timeout-ms");
  const result = runHerdr(["agent", "wait", a.pane, "--until", until, ...(until === "idle" ? ["--until", "done"] : []), "--timeout", String(timeout)], { timeoutMs: timeout + 5000 });
  const after = result?.agent ? projectAgent(result.agent) : findAgent(a.pane);
  return { pane: a.pane, requested: until, reached: after.state, help: nextSteps(fleet([after])) };
}

export function dispatch(args) {
  const o = parseArgs(args, { "timeout-ms": "string", "no-wait": "boolean", keys: "boolean" });
  const [name, ...rest] = o._;
  const task = rest.join(" ").trim();
  if (!name || !task) throw new AxiError("dispatch needs a pane ID and a task or keys", "MISSING_ARG", ["herdr-axi dispatch --help"]);
  const a = findAgent(name);
  const timeout = positiveInt(o["timeout-ms"] ?? 300000, "timeout-ms");
  if (a.state === "working")
    throw new AxiError(`${a.pane} is already working`, "AGENT_BUSY",
      [`wait first: herdr-axi wait ${a.pane} --until idle`, "or pick another: herdr-axi agents --state idle"]);
  if (o.keys) {
    runHerdr(["agent", "send-keys", a.pane, ...rest]);
    return { pane: a.pane, keys: rest, help: [`check the result: herdr-axi read ${a.pane}`] };
  }
  // Herdr's prompt wait observes a post-submission transition; a separate wait
  // can match the stale idle state before the prompt starts executing.
  const result = runHerdr(["agent", "prompt", a.pane, task, ...(o["no-wait"] ? [] : ["--wait", "--timeout", String(timeout)])], { timeoutMs: o["no-wait"] ? 30000 : timeout + 5000 });
  if (o["no-wait"]) return { pane: a.pane, submitted: true, note: "Submission only; immediate waits may match pre-start idle.", help: [`herdr-axi read ${a.pane}`] };
  const after = result?.agent ? projectAgent(result.agent) : findAgent(a.pane);
  return { pane: a.pane, submitted: true, state: after.state, help: [`herdr-axi read ${after.pane}`] };
}

// The tested bash engine stays the engine; this only routes to it.
export function watch(args) {
  requireHerdrEnv();
  const script = path.join(ENGINE, "herdr-orchestrator.sh");
  const r = spawnSync("bash", [script, ...args], { stdio: "inherit", env: { ...process.env, HERDR_ENV: "1" } });
  if (r.status !== 0) throw new AxiError(`orchestrator exited ${r.status}`, "ENGINE_ERROR", ["Run with --help for the engine's own usage."]);
  return { watch: "orchestrator finished", help: ["fleet state: herdr-axi"] };
}
