import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const launchMode = (kind) => kind === "copilot" ? "autopilot" : kind === "codex" ? "approve-for-me" : "auto";
const invalid = (message, code = "LAUNCH_POLICY") => Object.assign(new Error(message), { code });

// Validate before allocating a tab; availability/account policy still belongs
// to the native CLI. Never substitute a cheaper model or bypass permissions.
export function validateLaunch({ kind, model, effort = "high" }) {
  if (!["claude", "codex", "copilot"].includes(kind) || typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}(?:\[1m\])?$/.test(model)) throw invalid("Choose a worker kind and explicit model ID");
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
    else {
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!["--kind", "--model", "--effort"].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i].slice(2))) throw invalid("Expected --kind KIND --model MODEL --effort LEVEL");
        options[args[i].slice(2)] = args[i + 1];
      }
      console.log(JSON.stringify(validateLaunch(options)));
    }
  } catch (e) { console.error(`${e.code}: ${e.message}`); process.exitCode = 1; }
}
