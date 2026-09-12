import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engineErrorFrames } from "../src/engine-client.mjs";
import { safeWorker } from "../src/worker-identity.mjs";

test("dedicated backend fixtures reject empty and unknown commands without loading suites", () => {
  for (const name of ["runs", "version-probe"]) for (const args of [[], ["unknown-command"]]) {
    const file = fileURLToPath(new URL(`./fixtures/${name}-herdr.mjs`, import.meta.url));
    const result = spawnSync(process.execPath, [file, ...args], { encoding: "utf8", timeout: 2000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /fake herdr/);
    assert.equal(result.stdout, "");
  }
});

test("engine protocol preserves stable codes across chunks and ignores diagnostic prose", () => {
  const parser = engineErrorFrames();
  parser.push("PROMPT_REJECTED\n{\"schema\":1,\"code\":\"SESSION_START_");
  parser.push("UNVERIFIED\",\"message\":\"missing native session\",\"submitted\":false}\n");
  assert.deepEqual(parser.result(), { code: "SESSION_START_UNVERIFIED", message: "missing native session", submitted: false });
});

test("engine protocol rejects malformed, oversized and unterminated frames and recovers", () => {
  const parser = engineErrorFrames();
  for (const value of [null, { schema: 2, code: "BAD", message: "wrong schema" },
    { schema: 1, code: "bad code", message: "invalid code" },
    { schema: 1, code: "BAD", message: "x".repeat(4097) },
    { schema: 1, code: "BAD", message: "invalid delivery", submitted: "false" }]) {
    parser.push(JSON.stringify(value) + "\n");
    assert.equal(parser.result(), undefined);
  }
  for (let i = 0; i < 100; i++) parser.push("x".repeat(8192));
  parser.push('\n{"schema":1,"code":"GENERATION_DRIFT","message":"changed"}\n');
  parser.push('{"schema":1,"code":"BAD","message":"unterminated"}');
  assert.deepEqual(parser.result(), { code: "GENERATION_DRIFT", message: "changed" });
});

const run = { workspace: "workspace", owner: { pane: "owner", tab: "owner-tab" } };
const worker = { pane: "worker", tab: "worker-tab", terminal: "terminal", name: "axi-worker", stage: "submitted" };
const live = { pane: worker.pane, tab: worker.tab, terminal: worker.terminal, workspace: run.workspace, backendName: worker.name, session: "new-session" };

test("submitted worker requires its recorded native session, including legacy records", () => {
  for (const stage of ["submitted", "running", undefined]) {
    assert.throws(() => safeWorker(run, { ...worker, stage }, [live]), { code: "WORKER_CHANGED" });
    assert.equal(safeWorker(run, { ...worker, stage }, [live], { observe: true }), null);
  }
  assert.throws(() => safeWorker(run, { ...worker, session: "old-session" }, [live]), { code: "WORKER_CHANGED" });
  assert.equal(safeWorker(run, { ...worker, session: live.session }, [live]), live);
});

test("terminal-only unsubmitted startup remains recoverable; rearm must retain its terminal", () => {
  for (const stage of ["created", "rejected"]) assert.equal(safeWorker(run, { ...worker, stage }, [live]), live);
  assert.equal(safeWorker(run, { ...worker, session: "old-session" }, [live], { generationAdvance: true }), live);
  assert.throws(() => safeWorker(run, { ...worker, session: "old-session", terminal: undefined }, [live], { generationAdvance: true }), { code: "WORKER_CHANGED" });
  assert.equal(safeWorker(run, worker, []), undefined);
});
