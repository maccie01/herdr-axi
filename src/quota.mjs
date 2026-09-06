import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Native terminal errors only: quoted task text, quota percentages and ordinary
// rate-limit retries are not evidence of exhausted subscription/session capacity.
export function quotaError(text) {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/\s*[│┃]$/, "");
    const match = line.match(/^(?:[✗×!●•■]\s*)?(You have exceeded your monthly quota|Session limit reached|You(?:'|’)ve (?:hit|reached) your (?:(?:usage|session|weekly|monthly) )?limit|You have reached your (?:usage|session|weekly|monthly) limit)(?:\s|[.!:(]|$)/i);
    if (match) return { code: "QUOTA_EXHAUSTED", scope: /monthly/i.test(match[1]) ? "monthly" : /weekly/i.test(match[1]) ? "weekly" : "session", message: line.slice(0, 240) };
    if (/^[●•]\s|^\$\s/.test(line)) return null; // later activity supersedes an old error
  }
  return null;
}

export function switchHelp(run, pane, kind) {
  if (!run) return ["herdr-axi run switch --help"];
  const seen = new Set([kind]);
  const alternatives = Object.values(run.config?.roles ?? {}).filter((r) => {
    if (seen.has(r.kind)) return false;
    seen.add(r.kind); return true;
  }).slice(0, 2);
  return [...alternatives.map((r) => `herdr-axi run switch ${pane} --kind ${r.kind} --model ${r.model} --effort ${r.effort}`), "herdr-axi run switch --help"];
}

// The engine uses exactly the same bounded detector; no duplicated shell regex.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const quota = quotaError(fs.readFileSync(0, "utf8"));
  if (quota) console.log(JSON.stringify(quota));
  else process.exitCode = 2;
}
