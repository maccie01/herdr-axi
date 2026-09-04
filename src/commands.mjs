import { AxiError } from "axi-sdk-js";
import { listAgents, findAgent, fleet, runHerdr, requireHerdrEnv, projectAgent, STATES } from "./herdr.mjs";

import { loadRun, runError } from "./run-state.mjs";
import { runCommand, runStatus, watchRun, ownerCheck } from "./runs.mjs";

// Fail loud on unknown flags (AXI #6) - a typo must never silently no-op.
function parseArgs(args, spec) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const equals = a.indexOf("=");
    const flag = a.slice(2, equals < 0 ? undefined : equals);
    const inline = equals < 0 ? undefined : a.slice(equals + 1);
    if (!Object.hasOwn(spec, flag)) {
      throw new AxiError(`unknown flag: --${flag}`, "UNKNOWN_FLAG",
        [`Valid flags: ${Object.keys(spec).map((f) => "--" + f).join(", ") || "(none)"}`, "herdr-axi --help"]);
    }
    if (spec[flag] === "boolean") {
      if (inline !== undefined) throw new AxiError(`--${flag} takes no value`, "INVALID_VALUE", ["herdr-axi --help"]);
      out[flag] = true;
    }
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
  if (loadRun()) return runStatus();
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
  const o = parseArgs(args, { state: "string", kind: "string", all: "boolean" });
  if (o.state && !STATES.includes(o.state))
    throw new AxiError(`invalid state: ${o.state}`, "INVALID_STATE", [`Valid: ${STATES.join(", ")}`, "herdr-axi agents --help"]);
  let rows = listAgents({ all: o.all });
  if (o.state) rows = rows.filter((a) => a.state === o.state);
  if (o.kind) rows = rows.filter((a) => a.kind === o.kind);
  if (!rows.length) return { agents: "0 matching agents", help: ["Widen the filter, or: herdr-axi agents"] };
  return { agents: rows.map(({ name, kind, state, pane }) => ({ name, kind, state, pane })), help: nextSteps(fleet(rows)) };
}

export function fleetCmd(args = []) {
  const o = parseArgs(args, { all: "boolean" });
  if (o._.length) throw new AxiError("fleet takes no arguments", "INVALID_VALUE", ["herdr-axi fleet --help"]);
  if (loadRun() && !o.all) return runStatus();
  const f = fleet(listAgents({ all: o.all }));
  return { total: f.total, counts: f.counts, blocked: brief(f.blocked), working: brief(f.working), idle: brief(f.idle), done: brief(f.done), unknown: brief(f.unknown), help: nextSteps(f) };
}

export function read(args) {
  const o = parseArgs(args, { lines: "string", chars: "string", full: "boolean", raw: "boolean", compact: "boolean" });
  if (o.raw && o.compact) throw new AxiError("--raw and --compact conflict", "INVALID_VALUE", ["herdr-axi read --help"]);
  const name = o._[0];
  if (!name) throw new AxiError("read needs a pane ID", "MISSING_ARG", ["herdr-axi read --help"]);
  if (o._.length !== 1) throw new AxiError("read takes one pane ID", "INVALID_VALUE", ["herdr-axi read --help"]);
  const requestedLines = positiveInt(o.lines ?? (o.full ? 2000 : 60), "lines");
  const lines = o.full ? Math.min(requestedLines, 2000) : requestedLines;
  const chars = o.chars !== undefined ? positiveInt(o.chars, "chars") : (o.full ? Infinity : 8000);
  const a = findAgent(name);
  const source = o.full ? (o.raw ? "recent" : "recent-unwrapped") : "visible";
  const text = runHerdr(["agent", "read", a.pane, "--source", source, "--lines", String(lines + 1)], { timeoutMs: 20000, text: true });
  const all = text.split("\n");
  // Truncate with a size hint and an escape hatch (AXI #3).
  const shown = all.slice(-lines);
  let output = shown.join("\n");
  if (!o.raw) {
    // --raw preserves diagram borders and terminal layout within the same limits.
    output = output.split("\n")
      .map((line) => line.trimEnd().replace(/[ \t]+([│┃])$/, " $1"))
      .filter((line) => !/^[ \t]*[\u2500-\u259f][\s\u2500-\u259f]*$/u.test(line))
      .join("\n").replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").replace(/^\n+/, "");
  }
  const characters = Array.from(output);
  const clipped = characters.length > chars;
  output = characters.slice(-chars).join("");
  const help = [];
  const rawFlag = o.raw ? " --raw" : "";
  if (clipped) help.push(`herdr-axi read ${a.pane}${o.full ? " --full" : ""}${rawFlag} --lines ${lines} --chars ${characters.length}`);
  else if (all.length > shown.length) help.push(o.full
    ? "History limit; ask the agent to write a file."
    : ["working", "blocked"].includes(a.state)
      ? `herdr-axi read ${a.pane}${rawFlag} --lines ${Math.max(lines + 1, 120)}`
      : `herdr-axi read ${a.pane} --full${rawFlag}`);
  else if (!o.raw && !output && text.trim()) help.push(`herdr-axi read ${a.pane} --raw${o.full ? " --full" : ""}`);
  else if (a.state === "blocked") help.push(o.raw ? "herdr-axi dispatch --help" : `herdr-axi read ${a.pane} --raw`);
  return {
    pane: a.pane, state: a.state,
    output: output || (!o.raw && text.trim() ? "(layout-only output; use --raw)" : "(no visible output)"),
    ...(all.length > shown.length || clipped ? { truncated: [all.length > shown.length ? `${lines}-line cap` : "", clipped ? `${chars}-character cap` : ""].filter(Boolean).join(", ") } : {}),
    ...(o.raw ? { raw: true } : {}),
    ...(help.length ? { help } : {}),
  };
}

export function wait(args) {
  const o = parseArgs(args, { until: "string", "timeout-ms": "string" });
  if (o._.length > 1) throw new AxiError("wait takes one pane ID", "INVALID_VALUE", ["herdr-axi wait --help"]);
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
  if (loadRun() && !o.keys) throw runError("Managed tasks use run queue/next or run revise; direct prompts bypass generation and capacity checks", "MANAGED_DISPATCH");
  if (o.keys) {
    if (loadRun()) ownerCheck(loadRun());
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

export function watch(args = []) {
  requireHerdrEnv();
  const o = parseArgs(args, { "timeout-ms": "string" });
  if (o._.length) throw runError("watch takes no engine arguments; use run commands");
  return watchRun(positiveInt(o["timeout-ms"] ?? 30000, "timeout-ms"));
}

export function run(args) {
  const [action = "status", ...rest] = args;
  const specs = {
    init: { dir: "string", owner: "string", project: "string" }, status: {}, inbox: {}, next: {}, unlock: {}, config: {}, history: { task: "string", all: "boolean" }, finish: {}, gc: {},
    queue: { kind: "string", role: "string", cwd: "string", area: "string", "prompt-file": "string", after: "string" },
    phase: { cap: "string" }, accept: { evidence: "string" }, revise: { "prompt-file": "string" },
    cancel: {}, close: {}, recover: {},
  };
  if (!Object.hasOwn(specs, action)) throw runError(`Unknown run action: ${action}`);
  const o = parseArgs(rest, specs[action]);
  const count = ["queue", "phase", "accept", "revise", "cancel", "close", "recover"].includes(action) ? 1 : 0;
  if (o._.length !== count) throw runError(`${action} takes ${count} positional argument(s)`);
  return runCommand(action, o).catch((e) => { throw e instanceof AxiError ? e : runError(e.message); });
}
