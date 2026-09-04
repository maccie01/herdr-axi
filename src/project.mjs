import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PHASES, runError } from "./run-state.mjs";

export const stateRoot = () => path.resolve(process.env.HERDR_AXI_STATE_HOME || path.join(homedir(), ".local/state/herdr-axi"));
export const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24);
export function worktree(cwd) {
  const real = fs.realpathSync(cwd);
  const r = spawnSync("git", ["-C", real, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 2000 });
  return r.status === 0 ? fs.realpathSync(r.stdout.trim()) : real;
}

export const DEFAULT_CONFIG = {
  roles: {
    orchestrator: { kind: "codex", model: "gpt-5.6-sol", effort: "high", access: "read" },
    implementer: { kind: "copilot", model: "gpt-5.6-sol", effort: "high", access: "write" },
    verifier: { kind: "claude", model: "opus", effort: "high", access: "read" },
  },
  phases: PHASES,
  agentRatio: 0.75,
  nativeSubagentLimit: 4,
  context: { warnPercent: 70, criticalPercent: 85 },
  retention: { detailDays: 30, summaryDays: 180 },
};

const object = (v) => v && typeof v === "object" && !Array.isArray(v);
function keys(value, allowed, where) {
  if (!object(value) || Object.keys(value).some((k) => !allowed.includes(k))) throw runError(`Invalid/unknown configuration key in ${where}`, "CONFIG_INVALID");
}
const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
export function validateConfig(input = {}) {
  keys(input, Object.keys(DEFAULT_CONFIG), "project");
  const config = structuredClone(DEFAULT_CONFIG);
  for (const key of ["phases", "context", "retention"]) {
    if (input[key] !== undefined) { keys(input[key], Object.keys(config[key]), key); Object.assign(config[key], input[key]); }
  }
  for (const key of ["agentRatio", "nativeSubagentLimit"]) if (input[key] !== undefined) config[key] = input[key];
  if (input.roles !== undefined) {
    if (!object(input.roles)) throw runError("roles must be an object", "CONFIG_INVALID");
    for (const [name, role] of Object.entries(input.roles)) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw runError("Invalid role name", "CONFIG_INVALID");
      keys(role, ["kind", "model", "effort", "access", "subagents", "contextWindowTokens"], `roles.${name}`);
      config.roles[name] = { ...config.roles[name], ...role };
    }
  }
  for (const [name, role] of Object.entries(config.roles)) {
    if (!["claude", "codex", "copilot"].includes(role.kind) || typeof role.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(role.model) || !["minimal", "low", "medium", "high", "xhigh", "max"].includes(role.effort) || !["read", "write"].includes(role.access)) throw runError(`Invalid role ${name}`, "CONFIG_INVALID");
    if (role.contextWindowTokens !== undefined && !integer(role.contextWindowTokens, 1000, 10000000)) throw runError(`Invalid context window for ${name}`, "CONFIG_INVALID");
    if (role.subagents !== undefined) {
      if (!Array.isArray(role.subagents) || role.subagents.length > 4) throw runError(`Invalid subagents for ${name}`, "CONFIG_INVALID");
      for (const s of role.subagents) {
        keys(s, ["role", "max", "when"], `roles.${name}.subagents`);
        if (!config.roles[s.role] || config.roles[s.role].access !== "read" || config.roles[s.role].subagents?.length || !integer(s.max, 1, 4) || typeof s.when !== "string" || !s.when.trim() || s.when.length > 300) throw runError("Native subagents require a read-only leaf role, max 1..4, and a bounded when condition", "CONFIG_INVALID");
      }
    }
  }
  if (Object.values(config.phases).some((n) => !integer(n, 1, 16)) || typeof config.agentRatio !== "number" || config.agentRatio < 0.55 || config.agentRatio > 0.9 || !integer(config.nativeSubagentLimit, 0, 16) || !integer(config.context.warnPercent, 1, 99) || !integer(config.context.criticalPercent, config.context.warnPercent + 1, 100) || !integer(config.retention.detailDays, 1, 3650) || !integer(config.retention.summaryDays, config.retention.detailDays, 3650)) throw runError("Invalid capacity, layout, context or retention bounds", "CONFIG_INVALID");
  if (Object.values(config.roles).some((r) => nativeSlots(r) > config.nativeSubagentLimit)) throw runError("A role exceeds nativeSubagentLimit", "CONFIG_INVALID");
  return config;
}

export const nativeSlots = (role) => (role.subagents ?? []).reduce((n, s) => n + s.max, 0);
export function projectConfig(cwd) {
  const project = worktree(cwd);
  const file = path.join(project, ".herdr-axi.json");
  let input = {};
  try { input = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw runError(`Cannot load ${file}: ${e.message}`, "CONFIG_INVALID"); }
  return { project, configFile: fs.existsSync(file) ? file : null, config: validateConfig(input) };
}

// Shared across runs; fail closed after crashes. A lease is released only by
// its recorded task, after acceptance or verified disappearance of its panes.
export function writerLease(run, task, release = false) {
  if (task.access === "read") return true;
  const dir = path.join(stateRoot(), "writers");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, hash(task.worktree || task.cwd) + ".json");
  const value = { run: run.id, directory: process.env.HERDR_AXI_RUN ? path.resolve(process.env.HERDR_AXI_RUN) : null, task: task.id, worktree: task.worktree || task.cwd };
  if (!release) {
    try { fs.writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 }); return true; }
    catch (e) { if (e.code !== "EEXIST") throw e; return false; }
  }
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    if (old.run === value.run && old.task === value.task && (!old.directory || old.directory === value.directory)) fs.unlinkSync(file);
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  return true;
}
