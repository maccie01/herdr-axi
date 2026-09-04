import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AxiError } from "axi-sdk-js";
import { listAgents, findAgent, fleet, runHerdr, requireHerdrEnv, STATES, TERMINAL_STATES } from "./herdr.mjs";

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
        [`Valid flags: ${Object.keys(spec).map((f) => "--" + f).join(", ") || "(none)"}`]);
    }
    if (spec[flag] === "boolean") out[flag] = true;
    else { const v = inline ?? args[++i]; if (v === undefined) throw new AxiError(`--${flag} needs a value`, "MISSING_VALUE", []); out[flag] = v; }
  }
  return out;
}

// Suggestions always address agents by pane id: names are terminal titles that
// contain spaces, so a name-based suggestion is a command the agent cannot run.
const nextSteps = (f) => {
  const s = [];
  if (f.blocked.length) s.push(`blocked, needs input: herdr-axi read ${f.blocked[0].pane}`);
  if (f.working.length) s.push(`wait for one: herdr-axi wait ${f.working[0].pane} --until idle`);
  if (f.idle.length) s.push(`give work: herdr-axi dispatch ${f.idle[0].pane} "<task>"`);
  if (!f.total) s.push("no agents live - start one: herdr agent start <kind>");
  return s;
};

const brief = (rows) => rows.map((a) => `${a.pane} ${a.name.slice(0, 48)}`);

export function home() {
  const f = fleet();
  if (!f.total) return { fleet: "0 agents", help: ["No live herdr agents.", "Start one: herdr agent start <kind>"] };
  return {
    fleet: `${f.total} agents: ` + STATES.filter((s) => f.counts[s]).map((s) => `${f.counts[s]} ${s}`).join(", "),
    ...(f.blocked.length ? { blocked: brief(f.blocked) } : {}),
    ...(f.working.length ? { working: brief(f.working) } : {}),
    ...(f.idle.length ? { idle: brief(f.idle) } : {}),
    help: nextSteps(f),
  };
}

export function agents(args) {
  const o = parseArgs(args, { state: "string", kind: "string" });
  if (o.state && !STATES.includes(o.state))
    throw new AxiError(`invalid state: ${o.state}`, "INVALID_STATE", [`Valid: ${STATES.join(", ")}`]);
  let rows = listAgents();
  if (o.state) rows = rows.filter((a) => a.state === o.state);
  if (o.kind) rows = rows.filter((a) => a.kind === o.kind);
  if (!rows.length) return { agents: "0 matching agents", help: ["Widen the filter, or: herdr-axi agents"] };
  return { agents: rows.map(({ name, kind, state, pane }) => ({ name, kind, state, pane })), help: nextSteps(fleet(rows)) };
}

export function fleetCmd() {
  const f = fleet();
  return { total: f.total, counts: f.counts, blocked: brief(f.blocked), working: brief(f.working), idle: brief(f.idle), help: nextSteps(f) };
}

export function read(args) {
  const o = parseArgs(args, { lines: "string", full: "boolean" });
  const name = o._[0];
  if (!name) throw new AxiError("read needs an agent name", "MISSING_ARG", ["herdr-axi read <agent>"]);
  const a = findAgent(name);
  const lines = o.full ? 2000 : Number(o.lines ?? 60);
  const r = spawnSync("herdr", ["agent", "read", a.pane, "--source", "visible", "--lines", String(lines)], { encoding: "utf8", timeout: 20000 });
  const text = (r.stdout || "").trimEnd();
  const all = text.split("\n");
  // Truncate with a size hint and an escape hatch (AXI #3).
  const shown = o.full ? all : all.slice(-lines);
  return {
    agent: a.name, state: a.state, pane: a.pane,
    output: shown.join("\n") || "(no visible output)",
    ...(all.length > shown.length ? { truncated: `${all.length - shown.length} earlier lines hidden - rerun with --full` } : {}),
    help: a.state === "blocked" ? [`answer it: herdr-axi dispatch ${a.name} "<reply>"`] : [],
  };
}

export function wait(args) {
  const o = parseArgs(args, { until: "string", "timeout-ms": "string" });
  const name = o._[0];
  if (!name) throw new AxiError("wait needs an agent name", "MISSING_ARG", ["herdr-axi wait <agent> --until idle"]);
  const until = o.until ?? "idle";
  if (!STATES.includes(until)) throw new AxiError(`invalid state: ${until}`, "INVALID_STATE", [`Valid: ${STATES.join(", ")}`]);
  const a = findAgent(name);
  const timeout = Number(o["timeout-ms"] ?? 300000);
  runHerdr(["agent", "wait", a.pane, "--until", until, "--timeout-ms", String(timeout)], { timeoutMs: timeout + 5000 });
  const after = findAgent(a.pane);
  return { agent: after.name, state: after.state, reached: until, help: nextSteps(fleet([after])) };
}

export function dispatch(args) {
  const o = parseArgs(args, { "timeout-ms": "string", "no-wait": "boolean" });
  const [name, ...rest] = o._;
  const task = rest.join(" ").trim();
  if (!name || !task) throw new AxiError("dispatch needs an agent and a task", "MISSING_ARG", ['herdr-axi dispatch <agent> "<task>"']);
  const a = findAgent(name);
  if (a.state === "working")
    throw new AxiError(`${a.name} is already working`, "AGENT_BUSY",
      [`wait first: herdr-axi wait ${a.name} --until idle`, "or pick another: herdr-axi agents --state idle"]);
  runHerdr(["agent", "prompt", a.pane, task]);
  if (o["no-wait"]) return { dispatched: a.name, task, help: [`watch it: herdr-axi wait ${a.name} --until idle`] };
  const timeout = Number(o["timeout-ms"] ?? 300000);
  runHerdr(["agent", "wait", a.pane, "--until", TERMINAL_STATES.join(","), "--timeout-ms", String(timeout)], { timeoutMs: timeout + 5000 });
  const after = findAgent(a.pane);
  return { dispatched: a.name, task, state: after.state,
    help: after.state === "blocked" ? [`it needs input: herdr-axi read ${after.name}`] : [`see output: herdr-axi read ${after.name}`] };
}

// The tested bash engine stays the engine; this only routes to it.
export function watch(args) {
  requireHerdrEnv();
  const script = path.join(ENGINE, "herdr-orchestrator.sh");
  const r = spawnSync("bash", [script, ...args], { stdio: "inherit", env: { ...process.env, HERDR_ENV: "1" } });
  if (r.status !== 0) throw new AxiError(`orchestrator exited ${r.status}`, "ENGINE_ERROR", ["Run with --help for the engine's own usage."]);
  return { watch: "orchestrator finished", help: ["fleet state: herdr-axi"] };
}
