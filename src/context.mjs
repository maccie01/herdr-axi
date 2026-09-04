import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { runHerdr } from "./herdr.mjs";
import { runDir } from "./run-state.mjs";

export function contextValue(kind, text, window) {
  if (kind === "codex") {
    const match = [...text.matchAll(/\bContext\s+(\d{1,3})%\s+left\b/gi)].at(-1);
    if (match && Number(match[1]) <= 100) return { percent: 100 - Number(match[1]), source: "native-context" };
  }
  let tokens;
  for (const line of text.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (kind === "claude" && e.message?.usage) {
      const u = e.message.usage;
      tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    if (kind === "copilot" && e.type === "session.usage_checkpoint") {
      const main = e.data?.promptCacheBreakState?.find((v) => v.conversation === "main");
      tokens = main?.models?.[main.lastActiveModel]?.prompt_tokens;
    }
  }
  if (Number.isFinite(tokens) && tokens > 0) return { tokens, ...(window ? { percent: Math.ceil(tokens / window * 100), source: "last-input/configured-window" } : { source: "last-input/window-unknown" }) };
  return { source: "unknown" };
}

function tail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, bytes = Math.min(size, 131072), buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
    return buffer.toString("utf8");
  } finally { fs.closeSync(fd); }
}

export function contextStatus(run, workers, rows) {
  const file = path.join(runDir(), "context.json");
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file)); } catch { /* diagnostic cache only */ }
  const now = Date.now();
  // ponytail: at most two 1s probes/call; shared cache avoids a poll fan-out.
  const candidates = workers.filter((w) => !w.closed && rows.some((a) => a.pane === w.pane));
  const due = candidates.filter((w) => !cache[w.pane] || cache[w.pane].generation !== w.generation || now - cache[w.pane].at >= 15000).sort((a, b) => (cache[a.pane]?.at ?? 0) - (cache[b.pane]?.at ?? 0)).slice(0, 2);
  for (const w of due) {
    let value = { source: "unknown" };
    try {
      const a = rows.find((a) => a.pane === w.pane);
      if (w.kind === "codex") value = contextValue(w.kind, runHerdr(["agent", "read", w.pane, "--source", "visible", "--lines", "8"], { timeoutMs: 1000, text: true }));
      else if (/^[a-fA-F0-9-]{36}$/.test(a.session ?? "")) {
        const transcript = w.kind === "copilot"
          ? path.join(homedir(), ".copilot/session-state", a.session, "events.jsonl")
          : path.join(homedir(), ".claude/projects", w.cwd.replace(/[^a-zA-Z0-9]/g, "-"), a.session + ".jsonl");
        value = contextValue(w.kind, tail(transcript), w.contextWindowTokens);
      }
    } catch { /* unavailable is unknown, never healthy */ }
    cache[w.pane] = { ...value, at: now, generation: w.generation };
  }
  if (due.length) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(candidates.filter((w) => cache[w.pane]).map((w) => [w.pane, cache[w.pane]]))), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  const warnings = [];
  let unknown = 0;
  for (const w of candidates) {
    const c = cache[w.pane];
    if (!c || c.generation !== w.generation || now - c.at > 120000 || c.percent === undefined) { unknown++; continue; }
    if (c.percent >= run.config.context.warnPercent) warnings.push({ pane: w.pane, percent: c.percent, level: c.percent >= run.config.context.criticalPercent ? "critical" : "warning", source: c.source });
  }
  return { warnings, unknown };
}
