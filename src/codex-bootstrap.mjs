import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const fail = (message) => { throw new Error(message); };

function bootstrapRegistry(file) {
  if (fs.statSync(file).size > 65536) fail("Bootstrap registry exceeds the safety limit");
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  const bootstrap = registry.bootstrap;
  if (bootstrap?.schema !== 1 || !UUID.test(bootstrap.nonce ?? "") ||
    !["sending", "settled"].includes(bootstrap.state) || typeof bootstrap.prompt !== "string" ||
    !bootstrap.prompt || bootstrap.prompt.length > 4096) fail("Invalid bootstrap registry contract");
  const response = `HERDR_AXI_READY_${bootstrap.nonce}`;
  if (bootstrap.prompt !== `Initialization handshake only. Do not use tools, read or change files, start agents, or perform any task. Reply exactly ${response} and then stop.`) {
    fail("Bootstrap prompt is not the canonical initialization handshake");
  }
  const session = registry.native_identity?.session;
  if (!session) return null;
  if (!UUID.test(session) || (bootstrap.session && bootstrap.session.toLowerCase() !== session.toLowerCase())) {
    fail("Bootstrap native session identity is invalid or changed");
  }
  return { ...bootstrap, session: session.toLowerCase(), response };
}

function transcriptPath(session) {
  const root = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions");
  const directories = [{ directory: root, depth: 0 }];
  let visited = 0, found;
  while (directories.length) {
    const { directory, depth } = directories.pop();
    let entries;
    try {
      if (fs.lstatSync(directory).isSymbolicLink()) fail("Bootstrap transcript directory is a symlink");
      entries = fs.opendirSync(directory);
    } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    try {
      let entry;
      while ((entry = entries.readSync()) !== null) {
        if (++visited > 10000) fail("Bootstrap transcript search exceeds the safety limit");
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (depth >= 8) fail("Bootstrap transcript directory nesting exceeds the safety limit");
          directories.push({ directory: file, depth: depth + 1 });
        } else if (entry.name.toLowerCase().endsWith(`-${session}.jsonl`)) {
          if (!entry.isFile()) fail("Bootstrap transcript is not a regular file");
          if (found) fail("Multiple transcripts claim the bootstrap session");
          found = file;
        }
      }
    } finally { entries.closeSync(); }
  }
  return found;
}

function transcriptVerifier(contract) {
  let meta = false, turn, user = false, assistant = false, complete = false;
  const userRepresentations = new Set();
  const recordUser = (message, representation) => {
    if (!turn || assistant || complete || userRepresentations.has(representation) || message !== contract.prompt) {
      fail("Bootstrap transcript contains an unexpected user prompt");
    }
    userRepresentations.add(representation);
    user = true;
  };
  return {
    record(record) {
      const payload = record?.payload;
      if (record?.type === "session_meta") {
        if (meta || payload?.id?.toLowerCase() !== contract.session ||
          (payload.session_id && payload.session_id.toLowerCase() !== contract.session) ||
          payload.parent_thread_id != null || (typeof payload.source === "object" && payload.source !== null)) {
          fail("Transcript does not identify the registered root session");
        }
        meta = true;
        return;
      }
      if (!meta) fail("Transcript is missing root session metadata");
      if (record.type === "event_msg") {
        if (["task_started", "turn_started"].includes(payload?.type)) {
          if (turn || typeof payload.turn_id !== "string" || !payload.turn_id) fail("Bootstrap transcript contains an unexpected turn");
          turn = payload.turn_id;
        } else if (payload?.type === "user_message") {
          recordUser(payload.message, "event_msg");
        } else if (["task_complete", "turn_complete"].includes(payload?.type)) {
          if (!user || !assistant || complete || payload.turn_id !== turn ||
            payload.last_agent_message !== contract.response || payload.error != null) fail("Bootstrap turn did not complete with the exact response");
          complete = true;
        } else if (["turn_aborted", "error"].includes(payload?.type)) fail("Bootstrap turn was interrupted or failed");
      } else if (record.type === "response_item") {
        if (payload?.type === "message" && payload.role === "assistant") {
          if (!Array.isArray(payload.content) || !payload.content.length ||
            payload.content.some((item) => item?.type !== "output_text" || typeof item.text !== "string")) {
            fail("Bootstrap assistant response contains unsupported content");
          }
          const text = (payload.content ?? []).map((item) => item.text ?? "").join("");
          if (!user || complete || text !== contract.response ||
            (payload.phase != null && payload.phase !== "final_answer")) fail("Bootstrap assistant response does not match the expected acknowledgement");
          assistant = true;
        } else if (payload?.type === "message" && payload.role === "user") {
          const content = payload.content;
          const text = Array.isArray(content) && content.every((item) => item?.type === "input_text" && typeof item.text === "string")
            ? content.map((item) => item.text).join("") : null;
          if (text === null) fail("Bootstrap native user context contains unsupported content");
          // Native rollouts persist AGENTS/environment context as user messages
          // before the real prompt. The same real input may also have an event.
          if (text === contract.prompt || user || complete) recordUser(text, "response_item");
        } else if (typeof payload?.type === "string" && /(?:call|call_output)$/.test(payload.type)) {
          fail("Bootstrap turn attempted a tool call");
        }
      }
    },
    complete: () => complete,
  };
}

function verifyTranscript(file, contract) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const initial = fs.fstatSync(descriptor);
    if (!initial.isFile() || initial.size > MAX_BYTES) fail("Bootstrap transcript exceeds the safety limit or is not regular");
    const parser = transcriptVerifier(contract);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunk = Buffer.alloc(65536);
    let offset = 0, pending = "";
    while (offset < initial.size) {
      const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, initial.size - offset), offset);
      if (!count) return false;
      offset += count;
      pending += decoder.decode(chunk.subarray(0, count), { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        if (newline > MAX_LINE) fail("Bootstrap transcript line exceeds the safety limit");
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) parser.record(JSON.parse(line));
      }
      if (pending.length > MAX_LINE) fail("Bootstrap transcript line exceeds the safety limit");
    }
    try { pending += decoder.decode(); } catch { return false; } // A trailing UTF-8 codepoint may still be in flight.
    const final = fs.fstatSync(descriptor);
    if (pending.length || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) return false;
    return parser.complete();
  } finally { fs.closeSync(descriptor); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 3) fail("Expected a worker registry path");
    const contract = bootstrapRegistry(process.argv[2]);
    const file = contract && transcriptPath(contract.session);
    if (!file || !verifyTranscript(file, contract)) {
      console.error("CODEX_BOOTSTRAP_PENDING: exact completed bootstrap turn is not available");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`CODEX_BOOTSTRAP_INVALID: ${String(error.message).slice(0, 500)}`);
    process.exitCode = 2;
  }
}
