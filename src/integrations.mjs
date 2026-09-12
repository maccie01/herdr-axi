export const CORE_INTEGRATIONS = Object.freeze({
  claude: { mode: "auto", model: true, effort: true },
  codex: { mode: "approve-for-me", model: true, effort: true },
  copilot: { mode: "autopilot", model: true, effort: true },
  cursor: { mode: "auto-review", model: true, effort: "model" },
});

export const integrationKind = (name) => name === "antigravity-cli" ? "agy" : name;
export const isIntegrationKind = (kind) => typeof kind === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(kind);
export const isCoreIntegration = (kind) => Object.hasOwn(CORE_INTEGRATIONS, kind);
export const integrationPolicy = (kind) => isCoreIntegration(kind) ? CORE_INTEGRATIONS[kind] : (isIntegrationKind(kind) ? { mode: "native", model: false, effort: false } : null);

export function parseIntegrationStatus(text) {
  const records = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z0-9-]{0,39}):\s+(not installed|current|installed|outdated)\b(?:\s+\(v([^)]*)\))?/i);
    if (!match) continue;
    const name = match[1].toLowerCase();
    const status = match[2].toLowerCase();
    const kind = integrationKind(name);
    records.set(kind, { kind, name, status, installed: status !== "not installed", ...(match[3] ? { version: match[3] } : {}) });
  }
  return [...records.values()];
}

export const installedIntegrationKinds = (records) => records.filter((record) => record.installed).map((record) => record.kind);
