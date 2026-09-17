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
  const fingerprints = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const header = line.match(/^([a-z][a-z0-9-]{0,39})( \(experimental\))?:\s*(.*?)\s*$/i);
    if (!header) continue;
    const name = header[1].toLowerCase();
    const kind = integrationKind(name);
    const match = header[3].match(/^(needs repair|current|outdated)(?: \((?:v(\d+)|legacy)(?: < v(\d+))?\)(?: \(.+\))?)?$/i)
      ?? header[3].match(/^(not installed|installed)(?: \(.+\))?$/i);
    const status = match?.[1].toLowerCase() ?? "unknown";
    const record = { kind, name, status, installed: !!match && status !== "not installed",
      ...(header[2] ? { experimental: true } : {}),
      ...(match?.[2] ? { version: match[2] } : {}),
      ...(match?.[3] ? { expectedVersion: match[3] } : {}) };
    const fingerprint = `${header[2] ?? ""}:${header[3]}`;
    if (records.has(kind) && fingerprints.get(kind) !== fingerprint) {
      records.set(kind, { kind, name: kind === "agy" ? "antigravity-cli" : kind, status: "conflicting", installed: false });
    } else if (!records.has(kind)) {
      records.set(kind, record);
      fingerprints.set(kind, fingerprint);
    }
  }
  return [...records.values()];
}

export const installedIntegrationKinds = (records) => records.filter((record) => record.installed).map((record) => record.kind);

const launchable = (record) => record.installed && !record.experimental && ["current", "installed", "outdated"].includes(record.status);
export const launchableIntegrationKinds = (records) => records.filter(launchable).map((record) => record.kind);

export function integrationProblem(records, kind) {
  const record = records.find((entry) => entry.kind === kind);
  if (record && launchable(record)) return null;
  const reason = !record || record.status === "not installed" ? "is not installed"
    : record.status === "needs repair" ? "needs repair"
    : record.experimental ? "is experimental and not supported for managed workers"
    : `has ${record.status} inventory; launch eligibility cannot be verified`;
  return { code: "INTEGRATION_NOT_INSTALLED", message: `Herdr integration ${kind} ${reason}`,
    help: ["herdr integration status", ...(record?.status === "needs repair" ? [`herdr integration install ${record.name}`] : ["herdr integration install --help"])] };
}

export function integrationDiagnostics(records) {
  return records.filter((record) => record.status !== "not installed").flatMap((record) => {
    const problem = integrationProblem(records, record.kind);
    if (problem) return [{ kind: record.kind, status: record.status, message: problem.message, help: problem.help }];
    return record.status === "outdated" ? [{ kind: record.kind, status: record.status,
      message: `Herdr integration ${record.kind}${record.version ? ` v${record.version}` : ""} is outdated${record.expectedVersion ? `; expected v${record.expectedVersion}` : ""}`,
      help: [`herdr integration install ${record.name}`] }] : [];
  });
}
