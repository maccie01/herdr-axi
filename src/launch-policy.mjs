import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CORE_INTEGRATIONS, installedIntegrationKinds, integrationPolicy, parseIntegrationStatus } from "./integrations.mjs";

export const launchMode = (kind) => integrationPolicy(kind)?.mode ?? "native";
const invalid = (message, code = "LAUNCH_POLICY") => Object.assign(new Error(message), { code });

// Validate before allocating a tab; availability/account policy still belongs
// to the native CLI. Never substitute a cheaper model or bypass permissions.
export function validateLaunch({ kind, model, effort = kind === "cursor" ? "model" : CORE_INTEGRATIONS[kind] ? "high" : undefined }) {
  const policy = integrationPolicy(kind);
  if (!policy) throw invalid("Choose a worker kind backed by a Herdr integration");
  if (!policy.model) {
    if (model !== undefined || effort !== undefined) throw invalid(`${kind} uses its native configuration; omit --model and --effort`);
    return { kind, mode: policy.mode };
  }
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}(?:\[1m\])?$/.test(model)) throw invalid("Choose a worker kind and explicit model ID");
  if (kind === "cursor") {
    if (model === "auto" || model.includes("[")) throw invalid("Cursor requires an explicit model ID from cursor-agent models; no Auto model routing");
    if (effort !== "model") throw invalid("Cursor effort is selected by its model ID; use --effort model and choose the exact ID from cursor-agent models");
    return { kind, model, effort, mode: launchMode(kind) };
  }
  if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(effort) || (kind === "claude" && effort === "minimal")) throw invalid(`Unsupported ${kind} effort: ${effort}`);
  if (kind === "claude") {
    const base = model.replace(/\[1m\]$/, "");
    const version = base.match(/^claude-(opus|sonnet|fable)-(\d+)(?:[.-](\d+))?(?:-.*)?$/);
    const supported = ["opus", "sonnet", "fable"].includes(base) || (version && (Number(version[2]) >= 5 || (Number(version[2]) === 4 && Number(version[3]) >= 6)));
    if (!supported) throw invalid(`Claude unattended workers require an auto-capable Opus/Sonnet/Fable model; ${model} is not verified. Choose opus or an explicit supported ID; no manual fallback`, "AUTO_MODE_UNSUPPORTED");
  }
  if (kind === "codex" && /^(?:claude-|opus|sonnet|haiku|fable|gemini)/i.test(model)) throw invalid(`Model ${model} does not belong to Codex`);
  return { kind, model, effort, mode: launchMode(kind) };
}

export function checkLaunchScreen(text) {
  const lines = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-2A-Z]/g, "").split("\n");
  const modes = lines.map((line) => line.match(/^[\s│┃]*(?:[⏵▶►▸»>⏸]{1,2}\s+)?(auto mode|manual mode|plan mode|accept edits|bypass permissions|don't ask) on\b/i)?.[1]?.toLowerCase()).filter(Boolean);
  const mode = modes.at(-1);
  if (mode !== "auto mode") throw invalid(mode ? `Expected auto mode; observed ${mode}. No task submitted; inspect policy/model, then recover or cancel` : "Auto mode not visible; no task submitted. Inspect the native footer/policy, then recover or cancel", mode ? "AUTO_MODE_UNSUPPORTED" : "AUTO_MODE_UNVERIFIED");
  return { mode: "auto", verified: true };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--check-screen") console.log(JSON.stringify(checkLaunchScreen(fs.readFileSync(0, "utf8"))));
    else if (args.length === 2 && args[0] === "--check-integration") {
      const kind = args[1];
      if (!installedIntegrationKinds(parseIntegrationStatus(fs.readFileSync(0, "utf8"))).includes(kind))
        throw invalid(`Herdr integration is not installed for ${kind}; inspect herdr integration status and herdr integration install --help`, "INTEGRATION_NOT_INSTALLED");
      console.log(JSON.stringify({ kind, integration: "installed" }));
    }
    else {
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!["--kind", "--model", "--effort"].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i].slice(2))) throw invalid("Expected --kind KIND [--model MODEL --effort LEVEL]");
        options[args[i].slice(2)] = args[i + 1];
      }
      console.log(JSON.stringify(validateLaunch(options)));
    }
  } catch (e) { console.error(`${e.code}: ${e.message}`); process.exitCode = 1; }
}
