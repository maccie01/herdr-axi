import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PHASES, runError, runDir, canonicalDir } from "./run-state.mjs";
import { validateLaunch, launchMode } from "./launch-policy.mjs";
import { CORE_INTEGRATIONS, integrationName } from "./integrations.mjs";

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
  sharedReadWorktree: false,
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
  for (const key of ["agentRatio", "nativeSubagentLimit", "sharedReadWorktree"]) if (input[key] !== undefined) config[key] = input[key];
  if (typeof config.sharedReadWorktree !== "boolean") throw runError("sharedReadWorktree must be boolean", "CONFIG_INVALID");
  if (input.roles !== undefined) {
    if (!object(input.roles)) throw runError("roles must be an object", "CONFIG_INVALID");
    for (const [name, role] of Object.entries(input.roles)) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw runError("Invalid role name", "CONFIG_INVALID");
      keys(role, ["kind", "model", "effort", "access", "subagents", "contextWindowTokens"], `roles.${name}`);
      const previousKind = config.roles[name]?.kind;
      config.roles[name] = { ...config.roles[name], ...role };
      if (role.kind && role.kind !== previousKind) {
        if (role.model === undefined) delete config.roles[name].model;
        if (role.effort === undefined) delete config.roles[name].effort;
      }
    }
  }
  for (const [name, role] of Object.entries(config.roles)) {
    if (role.kind === "cursor" && role.effort === undefined) role.effort = "model";
    if (!["read", "write"].includes(role.access)) throw runError(`Invalid role ${name}`, "CONFIG_INVALID");
    try { validateLaunch(role); } catch (e) { throw runError(`Role ${name}: ${e.message}`, "CONFIG_INVALID"); }
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
export function selectWorker(config, options, availableKinds) {
  const base = options.role ? config.roles[options.role] : null;
  if (options.role && (!base || options.role === "orchestrator")) throw runError("Choose a worker role from init", "CONFIG_INVALID", ["herdr-axi run config"]);
  const kind = options.kind ?? base?.kind;
  const core = CORE_INTEGRATIONS[kind];
  if (availableKinds && !availableKinds.includes(kind)) throw runError(`Herdr integration is not installed for ${kind}`, "INTEGRATION_NOT_INSTALLED", [`herdr integration install ${integrationName(kind)}`, "herdr integration status"]);
  if (!core && (options.model !== undefined || options.effort !== undefined)) throw runError(`${kind} uses its native configuration; omit --model and --effort`, "LAUNCH_POLICY", ["herdr-axi run queue --help"]);
  if (base && kind !== base.kind && core && !options.model) throw runError("Changing this provider requires --model; no implicit substitution", "CONFIG_INVALID", ["herdr-axi run queue --help"]);
  if (kind === "cursor" && !options.model && !base?.model) throw runError("Cursor requires --model from cursor-agent models", "LAUNCH_POLICY", ["cursor-agent models", "herdr-axi guide cursor"]);
  const role = core
    ? { ...(base ?? { access: options.access ?? "write" }), kind, model: options.model ?? base?.model ?? (kind === "claude" ? "opus" : "gpt-5.6-sol"), effort: options.effort ?? (kind === "cursor" ? (base?.kind === "cursor" ? base.effort ?? "model" : "model") : base?.effort ?? "high") }
    : { ...(base ?? { access: options.access ?? "write" }), kind };
  if (!core) { delete role.model; delete role.effort; }
  if (role.model !== base?.model || role.kind !== base?.kind) delete role.contextWindowTokens;
  try { validateLaunch(role); } catch (e) { throw runError(e.message, e.code, ["herdr-axi run queue --help", "herdr-axi run config"]); }
  return role;
}

export function workerRoleSummary(config, availableKinds) {
  const roles = Object.entries(config.roles).filter(([name]) => name !== "orchestrator")
    .filter(([, role]) => !availableKinds || availableKinds.includes(role.kind))
    .map(([role, { kind, model, effort, access, subagents }]) => ({ role, kind, model, effort, access, native: nativeSlots({ subagents }), mode: launchMode(kind) }));
  return { roles: roles.slice(0, 8), ...(roles.length > 8 ? { moreRoles: roles.length - 8 } : {}) };
}

export function projectConfig(cwd) {
  const project = worktree(cwd);
  for (let directory = fs.realpathSync(cwd); ; directory = path.dirname(directory)) {
    const file = path.join(directory, ".herdr-axi.json");
    let input;
    try { input = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw runError(`Cannot load ${file}: ${e.message}`, "CONFIG_INVALID"); }
    if (input !== undefined) return { project, configFile: file, config: validateConfig(input) };
    if (directory === project || directory === path.dirname(directory)) break;
  }
  return { project, configFile: null, config: validateConfig() };
}

export const leasePath = (task) => path.join(stateRoot(), "writers", hash(task.worktree || task.cwd) + ".json");

function leaseRecord(file) {
  let record;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw runError(`Cannot verify lease ${file}: ${e.message}`, "LEASE_UNVERIFIED"); }
  if (!record?.run || !Object.hasOwn(record, "directory") || (!Array.isArray(record.holders) && !record.task)) throw runError(`Cannot verify lease ${file}: invalid record; inspect with herdr-axi run leases`, "LEASE_UNVERIFIED");
  const holders = record.holders ?? [{ task: record.task, access: "write", shared: false }];
  if (!Array.isArray(holders) || !holders.length || holders.some((h) => !h?.task || !["read", "write"].includes(h.access) || typeof h.shared !== "boolean")) throw runError(`Cannot verify lease ${file}: invalid holders`, "LEASE_UNVERIFIED");
  try { return { ...record, directory: canonicalDir(record.directory), holders }; }
  catch (e) { throw runError(`Cannot resolve lease owner ${file}: ${e.message}`, "LEASE_UNVERIFIED"); }
}

// One owner run per worktree. Its run.lock serializes holder changes; other runs
// can only acquire after the last holder releases. Read sharing is within that
// owner run, never an invisible opt-out from the cross-run lease protocol.
export function writerLease(run, task, release = false, rollback) {
  const file = leasePath(task);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const holder = { task: task.id, access: task.access || "write", shared: !!run.config?.sharedReadWorktree };
  const value = { schema: 2, run: run.id, directory: runDir(), worktree: task.worktree || task.cwd, holders: [holder] };
  if (!release) {
    try {
      fs.writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      rollback?.push(() => writerLease(run, task, true));
      return true;
    }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  let old;
  try { old = leaseRecord(file); }
  catch (e) { if (!release && e.code === "LEASE_UNVERIFIED") return false; throw e; }
  if (!old) return release;
  if (old.run !== value.run || old.directory !== value.directory) return false;
  if (release) old.holders = old.holders.filter((h) => h.task !== task.id);
  else {
    if (old.holders.some((h) => h.task === task.id)) return task.state === "queued";
    if (!holder.shared || old.holders.some((h) => !h.shared || (h.access === "write" && holder.access === "write"))) return false;
    old.holders.push(holder);
  }
  if (!old.holders.length) { fs.unlinkSync(file); return true; }
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...value, holders: old.holders }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  if (!release) rollback?.push(() => writerLease(run, task, true));
  return true;
}

export function leaseStatus(run) {
  const entries = [];
  for (const file of new Set(run.tasks.map(leasePath))) {
    try {
      const r = leaseRecord(file);
      if (r) entries.push({ file, owner: r.run, tasks: r.holders.map((h) => h.task).slice(0, 8), state: r.run === run.id && r.directory === runDir() ? "owned" : "foreign" });
    } catch (e) { entries.push({ file, state: "unverified", error: e.message.slice(0, 400) }); }
  }
  return { leases: entries.slice(0, 8), ...(entries.length > 8 ? { more: entries.length - 8 } : {}), note: "Unknown ownership: inspect the exact file; never auto-delete. Completed own tasks: run recover <task-id>, including archived runs.", help: ["herdr-axi run --help"] };
}

export function hasRunLeases(run, directory) {
  return run.tasks.some((t) => {
    try { const lease = leaseRecord(leasePath(t)); return !!lease && lease.run === run.id && lease.directory === canonicalDir(directory); }
    catch { return true; } // Keep provenance when ownership cannot be established.
  });
}
