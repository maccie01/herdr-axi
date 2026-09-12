import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { runHerdr } from "./herdr.mjs";
import { runError } from "./run-state.mjs";

export function captureCheckpoint(cwd, pane, { visible } = {}) {
  let output = "", source = "unavailable";
  if (pane) {
    try { output = runHerdr(["agent", "read", pane, "--source", "recent-unwrapped", "--lines", "2000"], { timeoutMs: 3000, text: true }); source = "history"; }
    catch {
      output = visible !== undefined ? visible : runHerdr(["agent", "read", pane, "--source", "visible", "--lines", "60"], { timeoutMs: 2000, text: true });
      source = "visible";
    }
  }
  const git = spawnSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", timeout: 3000, maxBuffer: 262144, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (git.error) throw runError(`Cannot checkpoint worktree status: ${git.error.message}`, "CHECKPOINT_FAILED");
  return { output: output.slice(-32000), capture: { source, truncated: true }, gitStatus: git.status === 0 ? git.stdout.slice(0, 8000) : `unavailable: ${git.stderr.slice(0, 600)}`, gitStatusTruncated: git.stdout.length > 8000 };
}
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// Preserve the current generation's evidence before accepting OR replacing it.
export function workerReport(worker, replacement) {
  try {
    let report;
    if (replacement) {
      const stat = fs.statSync(replacement);
      if (!stat.isFile() || stat.size > 14000) throw Error("Replacement report must be a regular file, at most 3500 characters");
      const detail = fs.readFileSync(replacement, "utf8");
      if (!detail.trim() || detail.length > 3500) throw Error("Replacement report must contain 1..3500 characters");
      report = { generation: worker.generation, summary: detail.slice(0, 600), detail };
    } else {
      const inbox = JSON.parse(fs.readFileSync(worker.receipt + ".inbox", "utf8"));
      report = inbox?.completion ?? inbox;
      if (report?.event !== "settled") throw Error("current inbox event is not a completion report");
    }
    if (report?.generation !== worker.generation || typeof report.summary !== "string" || typeof (report.detail ?? report.summary) !== "string" || !(report.detail ?? report.summary).trim()) throw Error("missing/mismatched current report");
    return { summary: report.summary.slice(0, 600), result: (report.detail ?? report.summary).slice(0, 3500), ...(report.truncated || (report.detail ?? report.summary).length > 3500 ? { truncated: true } : {}), ...(replacement ? { resultSource: "coordinator-replacement" } : {}) };
  } catch (e) {
    if (replacement) throw runError(`Replacement report ${replacement} is unusable: ${e.message}. Correct that file (regular file, 1..3500 characters) and retry, or omit --result-file to use this generation's own report. No acceptance or new generation.`, "RESULT_UNAVAILABLE", [`wc -c ${quote(replacement)}`, "herdr-axi run inbox"]);
    throw runError(`Report unavailable at ${worker.receipt}.inbox: ${e.message}. Retry inbox; if unrecoverable, preserve a reviewed replacement with --result-file FILE. No acceptance or new generation.`, "RESULT_UNAVAILABLE", ["herdr-axi run inbox", `herdr-axi read ${worker.pane} --full`]);
  }
}
