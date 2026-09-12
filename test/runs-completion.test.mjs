import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fixture, exhaustedWorker, owner } from "./support/run-fixture.mjs";

  test("valid settled report takes precedence over a stale monitor failure", () => {
    const f = fixture();
    try {
      f.queue("task"); f.ok(["run", "next"]); const w = f.state().workers[0];
      for (const generation of ["-", w.generation]) {
        fs.writeFileSync(w.receipt + ".monitor-error", `${generation}\ttransient monitor failure`);
        f.complete(w);
        const inbox = f.ok(["run", "inbox"]);
        assert.match(inbox, /run accept/); assert.doesNotMatch(inbox, /transient monitor failure/);
      }
      f.ok(["run", "accept", w.pane, "--evidence", "reviewed saved report"]);
    } finally { f.clean(); }
  });

  for (const [quota, action] of [[false, "watch"], [false, "task-watch"], [true, "watch"], [true, "switch"], [false, "accept"], [true, "accept"], [false, "revise"]]) test(`${action} collects late native proof without losing completed work${quota ? " despite quota banner" : ""}`, () => {
    const f = fixture();
    try {
      const w = exhaustedWorker(f);
      const session = w.session;
      f.env.HOME = path.join(f.dir, "home");
      const transcript = path.join(f.env.HOME, ".copilot/session-state", session, "events.jsonl");
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, [
        { type: "user.message", data: { content: `Current assignment: write completion proof to ${w.receipt}.proof.${w.generation}` } },
        { type: "session.task_complete", data: { summary: "LATE_REPORT: checks passed" } },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n");
      fs.writeFileSync(`${w.receipt}.proof.${w.generation}`, w.generation + "\n");
      if (!quota) fs.writeFileSync(path.join(f.dir, `screen-${w.pane}`), "Task finished");
      if (action === "accept") {
        const output = f.ok(["run", "accept", w.pane, "--evidence", "Independently reviewed current result/checks"]);
        assert.match(output, /accepted: quota-task/);
        assert.match(f.state().tasks[0].result, /LATE_REPORT/);
        assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
        return;
      }
      if (action === "revise") {
        f.ok(["run", "revise", w.pane, "--prompt", "Small correction; recheck"]);
        assert.equal(f.state().tasks[0].pane, w.pane);
        assert.notEqual(f.state().workers[0].generation, w.generation);
        assert.match(f.state().tasks[0].revisions[0].summary, /LATE_REPORT/);
        assert.equal(f.calls().filter((c) => c.action === "prompt").length, 2);
        return;
      }
      if (action === "switch") {
        const r = f.execute(["run", "switch", w.pane, "--kind", "codex", "--model", "gpt-5.6-sol"]);
        assert.equal(r.status, 1); assert.match(r.output, /NOT_SWITCHABLE/);
        assert(!f.calls().some((c) => c.action === "close"));
        assert.equal(f.state().tasks[0].state, "running");
      }
      const out = f.ok(["watch", ...(action === "task-watch" ? ["--task", "quota-task"] : []), "--timeout-ms", "100"]);
      assert.match(out, /LATE_REPORT/); assert.match(out, /review/); assert.match(out, /run accept/);
      assert.doesNotMatch(out, /herdr-axi run inbox|herdr-axi run switch/);
      f.ok(["run", "accept", w.pane, "--evidence", "Verified actual result and checks"]);
    } finally { f.clean(); }
  });

  test("completion survives a real input hook and is the report displayed and accepted", () => {
    const f = fixture();
    try {
      f.queue("notification"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      a.agent_status = "blocked"; fs.writeFileSync(file, JSON.stringify(a));
      const hook = spawnSync("bash", [fileURLToPath(new URL("../engine/herdr-hook-notify.sh", import.meta.url)), "input", JSON.stringify({ title: "Approval", message: "UNRELATED_PERMISSION_QUESTION" })], {
        env: { ...f.env, HERDR_AXI_NODE: process.execPath, HERDR_MONITOR_ENABLED: "1", HERDR_MONITOR_INBOX: "1", HERDR_MONITOR_AGENT: w.name, HERDR_MONITOR_ORCHESTRATOR: owner.pane_id, HERDR_WORKSPACE_ID: w.workspace, HERDR_RECEIPT_ROOT: path.dirname(path.dirname(w.receipt)), HERDR_MONITOR_RECEIPT: w.receipt }, encoding: "utf8", timeout: 20000,
      });
      assert.equal(hook.status, 0, hook.stderr);
      assert.match(f.ok(["run", "inbox"]), /UNRELATED_PERMISSION_QUESTION/);
      a.agent_status = "idle"; fs.writeFileSync(file, JSON.stringify(a));
      const inbox = f.ok(["run", "inbox"]);
      assert.match(inbox, /checks passed/); assert.doesNotMatch(inbox, /UNRELATED_PERMISSION_QUESTION/);
      f.ok(["run", "accept", w.pane, "--evidence", "Reviewed original checks"]);
      assert.equal(f.state().tasks[0].result, "checks passed");
    } finally { f.clean(); }
  });

  for (const invalid of ["input", "wrong-generation"]) test(`accept and revise refuse ${invalid} report despite completed receipt`, () => {
    const f = fixture();
    try {
      f.queue("report"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      const event = { event: "input", generation: w.generation, summary: "not completion" };
      if (invalid === "wrong-generation") event.completion = { event: "settled", generation: "old", summary: "old completion" };
      fs.writeFileSync(w.receipt + ".inbox", JSON.stringify(event));
      for (const args of [["run", "accept", w.pane, "--evidence", "reviewed"], ["run", "revise", w.pane, "--prompt", "fix"]]) {
        const failed = f.execute(args);
        assert.equal(failed.status, 1); assert.match(failed.output, /RESULT_UNAVAILABLE/);
      }
      const inbox = f.ok(["run", "inbox"]);
      assert.match(inbox, /errors/); assert.doesNotMatch(inbox, /herdr-axi run accept/);
      assert.equal(f.state().tasks[0].state, "running");
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
    } finally { f.clean(); }
  });

  test("inbox returns bounded saved completion details without reading changed terminal history", () => {
    const f = fixture();
    try {
      f.queue("detail"); f.ok(["run", "next"]); const w = f.state().workers[0]; f.complete(w);
      const detail = "summary ".repeat(90) + "UNIQUE_SAVED_CHECK";
      fs.writeFileSync(w.receipt + ".inbox", JSON.stringify({ event: "input", generation: w.generation, summary: "UNRELATED_UI", completion: { event: "settled", generation: w.generation, summary: detail.slice(0, 600), detail, truncated: false } }));
      const output = f.ok(["run", "inbox"]);
      assert.match(output, /UNIQUE_SAVED_CHECK/); assert.doesNotMatch(output, /UNRELATED_UI/);
      assert.match(output, /herdr-axi run accept/); assert(Buffer.byteLength(output) < 4000);
    } finally { f.clean(); }
  });

  test("cosmetic relabel failure cannot corrupt task delivery or trigger a resend", () => {
    const f = fixture();
    try {
      f.queue("first", "shared"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      fs.writeFileSync(path.join(f.dir, "rename-fail"), "");
      f.queue("second", "shared");
      const result = f.ok(["run", "next"]);
      assert.match(result, /labelError/); assert.doesNotMatch(result, /uncertain/);
      assert.equal(f.state().tasks[1].state, "running");
      assert.notEqual(f.state().workers[0].generation, w.generation);
      assert.equal(f.execute(["run", "recover", w.pane]).status, 1);
      assert.equal(f.calls().filter((c) => c.action === "prompt").length, 2);
    } finally { f.clean(); }
  });

  test("inbox keeps healthy worker events when another collection or inbox is broken", () => {
    const f = fixture();
    try {
      f.queue("a"); f.queue("b"); const started = f.ok(["run", "next"]);
      assert.equal(f.state().workers.length, 2, started);
      const [bad, good] = f.state().workers;
      f.complete(bad, "idle"); f.complete(good);
      fs.unlinkSync(bad.receipt);
      fs.writeFileSync(`${bad.receipt}.proof.${bad.generation}`, bad.generation);
      fs.writeFileSync(`${bad.receipt}.inbox`, "broken json");
      // Fail only engine subprocesses after startup; status reads remain live.
      fs.symlinkSync("/usr/bin/false", path.join(f.dir, "bin/bash"));
      const result = f.ok(["run", "inbox"]);
      assert.match(result, /Engine failed/); assert.match(result, /errors/); assert.match(result, /checks passed/);
    } finally { f.clean(); }
  });

  test("accept refuses a missing or corrupt result; postcommit lease failure is recoverable even archived", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      for (const payload of [null, "broken", JSON.stringify({ generation: "old", summary: "stale" })]) {
        if (payload === null) fs.unlinkSync(`${w.receipt}.inbox`); else fs.writeFileSync(`${w.receipt}.inbox`, payload);
        assert.match(f.execute(["run", "accept", w.pane, "--evidence", "checked"]).output, /RESULT_UNAVAILABLE/);
        assert.equal(f.state().tasks[0].state, "running");
      }
      f.complete(w);
      const leases = path.join(f.env.HERDR_AXI_STATE_HOME, "writers"), lease = path.join(leases, fs.readdirSync(leases)[0]);
      const original = fs.readFileSync(lease); fs.writeFileSync(lease, "null");
      const accepted = f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      assert.match(accepted, /committed: true/); assert.match(accepted, /LEASE_UNVERIFIED/);
      assert.equal(f.state().tasks[0].state, "accepted"); assert.equal(f.state().tasks[0].summary, "checks passed");
      assert(f.ok(["run", "leases"]).includes(lease));
      f.ok(["run", "close", w.pane]);
      assert.match(f.execute(["run", "finish"]).output, /LEASE_UNVERIFIED/);
      assert(f.state().finishedAt, "archive published; lease cleanup warning must not misreport rollback");
      fs.writeFileSync(lease, original); f.ok(["run", "finish"]); assert(!fs.existsSync(lease));
      const archived = JSON.parse(gunzipSync(fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "detail.json.gz"))));
      assert.equal(JSON.parse(archived.inboxes[w.name]).summary, "checks passed");
      fs.writeFileSync(lease, original); // Legacy archive with a leaked own lease.
      const before = f.calls().length;
      const recovered = f.execute(["run", "recover", "a"], { HERDR_ENV: "" });
      assert.equal(recovered.status, 0, recovered.output); assert.match(recovered.output, /leaseReleased: true/);
      assert(!fs.existsSync(lease)); assert.equal(f.calls().length, before, "archived repair is offline, exact ownership only");
    } finally { f.clean(); }
  });

  test("revise preserves prior evidence and refuses corrupt reports before resubmission", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      const file = `${w.receipt}.inbox`, original = fs.readFileSync(file);
      for (const payload of ["broken", "null", JSON.stringify({ generation: "old", summary: "stale" })]) {
        fs.writeFileSync(file, payload);
        const before = fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "run.json"), "utf8");
        const r = f.execute(["run", "revise", w.pane, "--prompt", "Correction; recheck"]);
        assert.equal(r.status, 1, r.output);
        assert.match(r.output, /RESULT_UNAVAILABLE/);
        assert.equal(fs.readFileSync(path.join(f.env.HERDR_AXI_RUN, "run.json"), "utf8"), before);
        assert.equal(f.calls().filter((c) => c.action === "prompt").length, 1);
      }
      const report = { ...JSON.parse(original), detail: "Prior detailed checks and rationale", truncated: true };
      fs.writeFileSync(file, JSON.stringify(report));
      f.ok(["run", "revise", w.pane, "--prompt", "Correction; recheck"]);
      assert.equal(f.state().tasks[0].revisions[0].result, report.detail);
      assert.equal(f.state().tasks[0].revisions[0].truncated, true);
      assert.equal(f.state().tasks[0].revisions[0].generation, w.generation);
      const next = f.state().workers[0]; f.complete(next);
      fs.writeFileSync(`${next.receipt}.inbox`, "broken");
      const replacement = path.join(f.dir, "reviewed.txt"); fs.writeFileSync(replacement, "Reviewed replacement; exact checks preserved");
      f.ok(["run", "revise", next.pane, "--prompt", "Final correction", "--result-file", replacement]);
      assert.equal(f.state().tasks[0].revisions[1].resultSource, "coordinator-replacement");
      assert.equal(f.state().tasks[0].revisions[1].result, fs.readFileSync(replacement, "utf8"));
    } finally { f.clean(); }
  });

  test("unusable replacement report names the supplied file instead of blaming the intact inbox", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w);
      const file = path.join(f.dir, "reviewed.md");
      for (const content of [null, "", "   \n", "x".repeat(3501), "y".repeat(20000)]) {
        if (content === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, content);
        const r = f.execute(["run", "accept", w.pane, "--evidence", "verified checks", "--result-file", file]);
        assert.equal(r.status, 1, r.output);
        assert.match(r.output, /RESULT_UNAVAILABLE/);
        assert(r.output.includes(file), r.output);
        assert.match(r.output, /1\.\.3500 characters/);
        assert(r.output.includes(`wc -c '${file}'`), r.output);
        assert.doesNotMatch(r.output, /Report unavailable at/);
        assert.equal(f.state().tasks[0].state, "running");
      }
      // The inbox was never the problem: acceptance without --result-file works.
      f.ok(["run", "accept", w.pane, "--evidence", "verified checks"]);
      assert.equal(f.state().tasks[0].summary, "checks passed");
      assert.equal(f.state().tasks[0].resultSource, undefined);
    } finally { f.clean(); }
  });

  test("explicit reviewed report replacement survives finish without weakening completion proof", () => {
    const f = fixture();
    try {
      f.queue("a"); f.ok(["run", "next"]); const w = f.state().workers[0];
      const file = path.join(f.dir, "replacement"); fs.writeFileSync(file, "task: a\nchecks: reviewed manually\nlimitations: original report lost\n");
      const args = ["run", "accept", w.pane, "--evidence", "verified artifact", "--result-file", file];
      assert.match(f.execute(args).output, /NOT_COMPLETE/);
      f.complete(w); fs.unlinkSync(`${w.receipt}.inbox`);
      f.ok(args); assert.equal(f.state().tasks[0].resultSource, "coordinator-replacement");
      f.ok(["run", "close", w.pane]); f.ok(["run", "finish"]);
      const history = f.ok(["run", "history", "--task", "a"]);
      assert.match(history, /coordinator-replacement/); assert.match(history, /original report lost/);
    } finally { f.clean(); }
  });

  test("reused tab cosmetics validate the new session, not the old generation", () => {
    const f = fixture();
    try {
      f.queue("a", "shared"); f.ok(["run", "next"]);
      const r = f.state(), w = r.workers[0]; w.session = "original"; f.write(r);
      const file = path.join(f.dir, `${w.pane}.agent`), a = JSON.parse(fs.readFileSync(file));
      a.agent_session = { value: "original" }; fs.writeFileSync(file, JSON.stringify(a));
      const registryFile = path.join(path.dirname(w.receipt), `${w.name}.json`);
      const registry = JSON.parse(fs.readFileSync(registryFile));
      registry.native_identity.session = "original"; fs.writeFileSync(registryFile, JSON.stringify(registry));
      f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      fs.writeFileSync(path.join(f.dir, "session-rotate"), ""); f.queue("b", "shared");
      assert.doesNotMatch(f.ok(["run", "next"]), /labelError|uncertain/);
      assert.notEqual(f.state().workers[0].session, "original");
      assert.equal(JSON.parse(fs.readFileSync(file)).label, "b · codex");
    } finally { f.clean(); }
  });

  test("slow tab cosmetics see an already published task and time out promptly", async () => {
    const f = fixture(); let launch;
    try {
      f.queue("a", "shared"); f.ok(["run", "next"]);
      const w = f.state().workers[0]; f.complete(w); f.ok(["run", "accept", w.pane, "--evidence", "checked"]);
      f.queue("b", "shared"); fs.writeFileSync(path.join(f.dir, "rename-delay"), "");
      launch = f.asyncRun(["run", "next"]);
      const deadline = Date.now() + 10000;
      while (!f.calls().some((c) => c.action === "rename") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert(f.calls().some((c) => c.action === "rename"));
      assert.equal(f.state().tasks[1].state, "running");
      const at = Date.now(), result = await launch;
      assert.equal(result.status, 0, result.output); assert.match(result.output, /labelError/);
      assert(Date.now() - at < 2000, "cosmetic timeout cannot hold publication hostage");
    } finally { if (launch) await launch; f.clean(); }
  });
