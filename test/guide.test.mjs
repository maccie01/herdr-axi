import assert from "node:assert/strict";
import { test } from "node:test";
import { guide } from "../src/guide.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("guide and skill alias return identical bounded TOON without Herdr or run state", () => {
  const cli = fileURLToPath(new URL("../bin/herdr-axi.mjs", import.meta.url));
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HERDR_BIN: "/no-backend", HERDR_AXI_RUN: "/no-run" } });
  const result = run(["guide"]), alias = run(["--skill"]);
  assert.equal(result.status, 0, result.stderr); assert.equal(alias.status, 0, alias.stderr);
  assert.equal(alias.stdout, result.stdout); assert(Buffer.byteLength(result.stdout) < 3500);
  assert.match(result.stdout, /recovery\[8\]\{when,command,rule\}/);
  assert.equal(run(["guide", "--manual"]).status, 1);
  const help = run(["run", "queue", "--help"]);
  for (const flag of ["role", "kind", "model", "effort", "start", "cwd", "area", "prompt", "prompt-file", "after"]) assert(help.stdout.includes(`--${flag}`));
  assert.match(help.stdout, /do not call next again/);
});

test("agent guide stays bounded and provides a direct two-call startup recipe", () => {
  const result = guide();
  assert(Buffer.byteLength(JSON.stringify(result)) <= 3500);
  assert.deepEqual(result.start, [
    "herdr-axi run init --project PROJECT_DIR",
    'export HERDR_AXI_RUN=\'RUN_DIR\'; herdr-axi run queue TASK --role implementer --cwd WORKTREE --area AREA --prompt "task; owned files; checks" --start',
  ]);
  assert.match(result.batch, /Omit --start.*herdr-axi run next once/);
  assert.equal(result.models.choice, "--role implementer --kind claude --model claude-opus-5 --effort high");
  assert.match(result.models.policy, /access\/native-child policy preserved/);
  assert.match(result.models.budget, /App\/API model budget separate/);
  assert.match(result.models.config, /Nearest.*worktree root.*snapshot at init/);
});

test("agent guide distinguishes persisted results from verified wake delivery", () => {
  const { waiting, rules, recovery } = guide();
  assert.match(waiting.work, /independent work.*no inbox\/read polling/);
  assert.match(waiting.delivery, /One tracked.*verified completion callback/);
  assert.match(waiting.fallback, /blocking watch only when dependent/);
  assert.match(waiting.hooks, /Hooks save results; no guaranteed push/);
  assert.match(waiting.result, /no duplicate inbox fetch.*timeout != completion/);
  assert(rules.some((rule) => /isolated worktrees first/.test(rule)));
  assert.equal(recovery.find((row) => row.when === "permission/trust").command, "herdr-axi read PANE_ID --raw");
  assert.match(recovery.find((row) => row.when === "permission/trust").rule, /no automatic approval/);
  assert.match(recovery.find((row) => row.when === "stop unfinished").rule, /Whole owned tab \+ monitor; worktree retained/);
  assert.equal(recovery.find((row) => row.when === "accepted worker").command, "herdr-axi run close PANE_ID");
  assert.equal(recovery.at(-1).command, "herdr-axi run finish");
});

test("keyword guide returns bounded exact recipes rather than the full workflow", () => {
  const opus = guide(["start", "opus"]);
  assert.deepEqual(guide(["START ÓPUS"]), opus);
  assert.equal(opus.topic, "start");
  assert.equal(opus.start.length, 2);
  assert.match(opus.start[1], /--role implementer --kind claude --model claude-opus-5 --effort high.*--start$/);
  assert(!opus.recovery);
  const sonnet = guide(["start sonnet"]);
  assert.match(sonnet.start[1], /--kind claude --model sonnet --effort high/);
  assert.doesNotMatch(sonnet.start[1], /opus/);
  assert.match(guide(["model sonnet"]).choice, /--model sonnet/);
  assert.equal(guide(["start opus sonnet"]).code, "AMBIGUOUS_GUIDE_TOPIC");
  assert(Buffer.byteLength(JSON.stringify(opus)) < 1800);
  for (const [query, topic] of [["quota switch", "quota"], ["stop worker", "stop"], ["config subproject", "config"], ["wait notification", "wait"], ["trust permission", "trust"], ["worktree busy", "worktree"], ["review accept", "review"]]) {
    const result = guide([query]);
    assert.equal(result.topic, topic, query);
    assert(Buffer.byteLength(JSON.stringify(result)) < 1800, query);
    assert(!result.start, query);
  }
  assert.equal(guide(["How can I please stop my worker?"]).topic, "stop");
  assert.equal(guide(["überwachen"]).topic, "wait");
  assert.match(guide(["wait notification"]).hooks, /no guaranteed push/);
  assert.match(guide(["trust permission"]).recovery[0].rule, /no automatic approval/);
});

test("unknown or ambiguous guide queries never guess a destructive action", () => {
  for (const query of ["banana", "agent worker", "  "]) {
    const result = guide([query]);
    assert.equal(result.code, "UNKNOWN_GUIDE_TOPIC");
    assert(result.topics.includes("start"));
    assert(result.examples.every((example) => example.startsWith("herdr-axi guide ")));
    assert(!result.start && !result.recovery);
  }
  const ambiguity = guide(["stop close quota trust"]);
  assert.equal(ambiguity.code, "AMBIGUOUS_GUIDE_TOPIC");
  assert.equal(ambiguity.matches.length, 3);
  assert.equal(ambiguity.more, 1);
  assert(ambiguity.matches.every((match) => match.help === `herdr-axi guide ${match.topic}`));
  assert(!JSON.stringify(ambiguity).includes("run cancel"));
  assert.equal(guide(["start ".repeat(9)]).code, "GUIDE_QUERY_LIMIT");
  assert.equal(guide(["x".repeat(201)]).code, "GUIDE_QUERY_LIMIT");
});

test("keyword CLI guide works without a backend or selected run", () => {
  const cli = fileURLToPath(new URL("../bin/herdr-axi.mjs", import.meta.url));
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HERDR_BIN: "/no-backend", HERDR_AXI_RUN: "/no-run" } });
  const split = run(["guide", "start", "opus"]), quoted = run(["guide", "start opus"]);
  assert.equal(split.status, 0, split.stderr);
  assert.equal(quoted.status, 0, quoted.stderr);
  assert.equal(split.stdout, quoted.stdout);
  assert.match(split.stdout, /topic: start/);
  assert.match(split.stdout, /--model claude-opus-5/);
  assert(Buffer.byteLength(split.stdout) < 1800);
  const wait = run(["guide", "wait", "notification"]);
  assert.equal(wait.status, 0, wait.stderr);
  assert.match(wait.stdout, /verified completion callback/);
  assert(!wait.stdout.includes("run init"));
  const unknown = run(["guide", "banana"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout + unknown.stderr, /UNKNOWN_GUIDE_TOPIC/);
  assert.match(unknown.stdout + unknown.stderr, /topics: start, models, quota/);
  const ambiguous = run(["guide", "stop", "close"]);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stdout + ambiguous.stderr, /herdr-axi guide stop/);
  assert.match(ambiguous.stdout + ambiguous.stderr, /herdr-axi guide close/);
  assert(!(ambiguous.stdout + ambiguous.stderr).includes("run cancel"));
});
