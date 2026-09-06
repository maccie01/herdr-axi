import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { runHerdr } from "./herdr.mjs";
import { runDir } from "./run-state.mjs";
import { quotaError } from "./quota.mjs";

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
  try { cache = JSON.parse(fs.readFileSync(file)); if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {}; } catch { /* diagnostic cache only */ }
  const now = Date.now();
  // ponytail: at most two 1s backend probes/call; bounded local transcript tails
  // need no terminal round trip and do not compete for that budget.
  const candidates = workers.filter((w) => !w.closed);
  let probes = 0;
  const screens = new Map();
  const contextDue = (w) => !cache[w.pane] || cache[w.pane].generation !== w.generation || now - (cache[w.pane].attemptedAt ?? cache[w.pane].at ?? 0) >= 15000;
  const quotaDue = (w) => {
    const a = rows.find((a) => a.pane === w.pane), c = cache[w.pane];
    return a && ["blocked", "idle", "done", "unknown"].includes(a.state) && (!c || c.generation !== w.generation || c.quotaState !== a.state || now - (c.quotaAttemptedAt ?? c.quotaAt ?? 0) >= 15000);
  };
  // One fair terminal queue for context AND quota. Failed probes rotate too;
  // frequent Codex context refresh must not starve another provider's quota.
  const terminalDue = candidates.filter((w) => rows.some((a) => a.pane === w.pane) && ((w.kind === "codex" && contextDue(w)) || quotaDue(w)))
    .sort((a, b) => (cache[a.pane]?.probedAt ?? 0) - (cache[b.pane]?.probedAt ?? 0)).slice(0, 2);
  for (const w of terminalDue) {
    const a = rows.find((a) => a.pane === w.pane);
    const c = cache[w.pane]?.generation === w.generation ? cache[w.pane] : { generation: w.generation, source: "unknown" };
    cache[w.pane] = { ...c, probedAt: now, quotaAttemptedAt: now, quotaState: a.state };
    probes++;
    try { screens.set(w.pane, runHerdr(["agent", "read", w.pane, "--source", "visible", "--lines", "40"], { timeoutMs: 1000, text: true })); }
    catch { /* unavailable; preserve last measurement, rotate probe priority */ }
  }
  const due = candidates.filter((w) => rows.some((a) => a.pane === w.pane) && contextDue(w) && (w.kind !== "codex" || terminalDue.includes(w)));
  for (const w of due) {
    let value = { source: "unknown" };
    try {
      const a = rows.find((a) => a.pane === w.pane);
      if (w.kind === "codex") {
        value = contextValue(w.kind, screens.get(w.pane) ?? "");
      }
      else if (/^[a-fA-F0-9-]{36}$/.test(a.session ?? "")) {
        const transcript = w.kind === "copilot"
          ? path.join(homedir(), ".copilot/session-state", a.session, "events.jsonl")
          : path.join(homedir(), ".claude/projects", w.cwd.replace(/[^a-zA-Z0-9]/g, "-"), a.session + ".jsonl");
        value = contextValue(w.kind, tail(transcript), w.contextWindowTokens);
      }
    } catch { /* unavailable is unknown, never healthy */ }
    const previous = cache[w.pane]?.generation === w.generation ? cache[w.pane] : null;
    const measured = Number.isFinite(value.percent) || Number.isFinite(value.tokens);
    cache[w.pane] = measured
      ? { ...previous, ...value, unavailable: false, at: now, attemptedAt: now, generation: w.generation }
      : { ...(previous ?? { source: "unknown", generation: w.generation }), attemptedAt: now, unavailable: true };
  }
  let quotaProbed = false;
  for (const w of candidates.slice().sort((a, b) => (cache[a.pane]?.quotaAt ?? 0) - (cache[b.pane]?.quotaAt ?? 0))) {
    const a = rows.find((a) => a.pane === w.pane);
    if (!a || !["blocked", "idle", "done", "unknown"].includes(a.state)) continue;
    const c = cache[w.pane]?.generation === w.generation ? cache[w.pane] : { generation: w.generation, source: "unknown" };
    if (!screens.has(w.pane)) continue;
    try {
      const screen = screens.get(w.pane);
      cache[w.pane] = { ...c, quota: quotaError(screen), quotaAt: now, quotaState: a.state };
      quotaProbed = true;
    } catch { /* unavailable is not quota evidence */ }
  }
  let error;
  if (due.length || probes || quotaProbed) {
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(candidates.filter((w) => cache[w.pane]).map((w) => [w.pane, cache[w.pane]]))), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (e) { error = e.message.slice(0, 300); }
    finally { try { fs.rmSync(temp, { force: true }); } catch { /* diagnostic only */ } }
  }
  const warnings = [], lastKnown = [];
  let unknown = 0, stale = 0;
  for (const w of candidates) {
    const c = cache[w.pane];
    if (!c || c.generation !== w.generation || !Number.isFinite(c.percent) || !Number.isFinite(c.at)) { unknown++; continue; }
    if (c.unavailable || !rows.some((a) => a.pane === w.pane) || now - c.at > 120000) {
      stale++;
      lastKnown.push({ pane: w.pane, percent: c.percent, observedAt: c.at, source: c.source });
      continue;
    }
    // Mutually exclusive fresh/stale/unknown categories. Historical evidence
    // is retained, but never a permanent actionable warning that spins watch.
    if (c.percent >= run.config.context.warnPercent) warnings.push({ pane: w.pane, percent: c.percent, level: c.percent >= run.config.context.criticalPercent ? "critical" : "warning", source: c.source });
  }
  const quotas = candidates.flatMap((w) => {
    const c = cache[w.pane], a = rows.find((a) => a.pane === w.pane);
    return a && a.state !== "working" && c?.generation === w.generation && c.quotaState === a.state && c.quota && now - c.quotaAt < 120000 ? [{ pane: w.pane, ...c.quota }] : [];
  });
  return { warnings, lastKnown, unknown, stale, quotas, ...(error ? { error } : {}) };
}
