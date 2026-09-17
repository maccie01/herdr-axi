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

// Herdr 0.9.x prints exactly these states (src/cli/integration.rs); anything else is unknown.
function parseState(text) {
  let m;
  if (/^not installed \(.+\)$/i.test(text)) return { status: "not installed" };
  if ((m = text.match(/^current \((?:v(\d+)|legacy)\) \(.+\)$/i))) return { status: "current", version: m[1] };
  if ((m = text.match(/^needs repair \(v(\d+)\) \(.+\)$/i))) return { status: "needs repair", version: m[1] };
  if ((m = text.match(/^outdated \((?:v(\d+)|legacy) < v(\d+)\) \(.+\)$/i)) && !(m[1] && Number(m[1]) >= Number(m[2])))
    return { status: "outdated", version: m[1], expectedVersion: m[2] };
  return { status: "unknown" };
}

export function parseIntegrationStatus(text) {
  const records = new Map();
  const fingerprints = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const header = line.match(/^([a-z][a-z0-9-]{0,39})( \(experimental\))?:\s*(.*?)\s*$/i);
    if (!header) continue;
    const name = header[1].toLowerCase();
    const kind = integrationKind(name);
    const { status, version, expectedVersion } = parseState(header[3]);
    const record = { kind, name, status, installed: !["not installed", "unknown"].includes(status),
      ...(header[2] ? { experimental: true } : {}),
      ...(version ? { version } : {}),
      ...(expectedVersion ? { expectedVersion } : {}) };
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

const launchable = (record) => record.installed && !record.experimental && ["current", "outdated"].includes(record.status);
export const launchableIntegrationKinds = (records) => records.filter(launchable).map((record) => record.kind);

export function integrationProblem(records, kind) {
  const record = records.find((entry) => entry.kind === kind);
  if (record && launchable(record)) return null;
  const reason = !record || record.status === "not installed" ? "is not installed"
    : record.experimental ? "is experimental and not supported for managed workers"
    : record.status === "needs repair" ? "needs repair"
    : `has ${record.status} inventory; launch eligibility cannot be verified`;
  return { code: "INTEGRATION_NOT_INSTALLED", message: `Herdr integration ${kind} ${reason}`,
    help: ["herdr integration status", ...(record?.status === "needs repair" && !record.experimental ? [`herdr integration install ${record.name}`] : ["herdr integration install --help"])] };
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
