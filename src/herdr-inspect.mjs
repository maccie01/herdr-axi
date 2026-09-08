import { AxiError } from "axi-sdk-js";
import { findAgent, runHerdr, STATES } from "./herdr.mjs";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 300) => typeof value === "string" ? value.slice(0, limit) : null;
const number = (value) => Number.isFinite(value) ? value : null;

const ruleSummary = (rule) => rule && typeof rule === "object" ? {
  id: text(rule.id, 100),
  state: text(rule.state, 30),
  region: text(rule.region, 50),
  priority: number(rule.priority),
} : null;

export function explainAgent(name, { verbose = false } = {}) {
  const agent = findAgent(name);
  const explain = runHerdr(["agent", "explain", agent.pane, "--json"]);
  if (!explain || typeof explain !== "object" || Array.isArray(explain)) throw new AxiError(
    "herdr agent explain returned an unexpected shape",
    "HERDR_CLI_ERROR",
    [`Inspect the backend response: herdr agent explain ${agent.pane} --json`],
  );
  const rules = Array.isArray(explain?.evaluated_rules) ? explain.evaluated_rules : [];
  if (rules.some((rule) => !object(rule)) || (explain.matched_rule != null && !object(explain.matched_rule))) throw new AxiError(
    "herdr agent explain returned malformed rule data",
    "HERDR_CLI_ERROR",
    [`Inspect the backend response: herdr agent explain ${agent.pane} --json`],
  );
  const result = {
    pane: agent.pane,
    agent: text(explain?.agent, 50),
    state: STATES.includes(explain?.state) ? explain.state : "unknown",
    manifest: {
      source: text(explain?.manifest_source),
      version: text(explain?.manifest_version, 80),
      cachedRemoteVersion: text(explain?.cached_remote_version, 80),
      localOverrideShadowingRemote: explain?.local_override_shadowing_remote === true,
      updateStatus: text(explain?.remote_update_status),
      updateError: text(explain?.remote_update_error),
    },
    detection: {
      matchedRule: ruleSummary(explain?.matched_rule),
      visible: {
        idle: explain?.visible_idle === true,
        blocker: explain?.visible_blocker === true,
        working: explain?.visible_working === true,
      },
      skipped: explain?.screen_detection_skipped === true,
      skipReason: text(explain?.screen_detection_skip_reason),
      skipStateUpdate: explain?.skip_state_update === true,
      skippedUpdateReason: text(explain?.skipped_update_reason),
      fallbackReason: text(explain?.fallback_reason),
      warning: text(explain?.warning),
      evaluatedRules: rules.length,
    },
  };
  if (verbose) {
    result.rules = rules.slice(0, 12).map((rule) => ({
      ...ruleSummary(rule),
      matched: rule?.matched === true,
      evidence: {
        contains: Array.isArray(rule?.evidence?.contains) ? rule.evidence.contains.slice(0, 8).map((value) => text(value)) : [],
        regex: Array.isArray(rule?.evidence?.regex) ? rule.evidence.regex.slice(0, 8).map((value) => text(value)) : [],
        lineRegex: Array.isArray(rule?.evidence?.line_regex) ? rule.evidence.line_regex.slice(0, 8).map((value) => text(value)) : [],
        regionBytes: number(rule?.evidence?.region_bytes),
        regionPreview: text(rule?.evidence?.region_preview, 500),
      },
    }));
    if (rules.length > result.rules.length) result.moreRules = rules.length - result.rules.length;
  }
  return result;
}

export function listMachines() {
  const rows = runHerdr(["machine", "list", "--json"]);
  if (!Array.isArray(rows) || rows.some((row) => !object(row))) throw new AxiError(
    "herdr machine list returned an unexpected shape",
    "HERDR_CLI_ERROR",
    ["Inspect the backend response: herdr machine list --json"],
  );
  return rows.map((row) => ({
    id: text(row?.id, 100),
    label: text(row?.label, 100),
    target: text(row?.target),
    session: text(row?.session, 100),
    enabled: row?.enabled === true,
    selected: row?.selected === true,
  }));
}
