import assert from "node:assert/strict";
import { test } from "node:test";
import * as integrations from "../src/integrations.mjs";
const { parseIntegrationStatus } = integrations;
const installedIntegrationKinds = (records) => records.filter((record) => record.installed).map((record) => record.kind);

test("inventory preserves repair and experimental records with precise version metadata", () => {
  assert.deepEqual(parseIntegrationStatus([
    "claude: needs repair (v10) (/a)",
    "letta (experimental): current (v1) (/b)",
    "opencode: outdated (v11 < v12) (/c)",
    "pi: outdated (legacy < v4) (/d)",
  ].join("\r\n")), [
    { kind: "claude", name: "claude", status: "needs repair", installed: true, version: "10" },
    { kind: "letta", name: "letta", status: "current", installed: true, experimental: true, version: "1" },
    { kind: "opencode", name: "opencode", status: "outdated", installed: true, version: "11", expectedVersion: "12" },
    { kind: "pi", name: "pi", status: "outdated", installed: true, expectedVersion: "4" },
  ]);
});

test("launch eligibility distinguishes installed, repair and experimental integrations", () => {
  const records = parseIntegrationStatus("codex: current (v8) (/a)\nclaude: needs repair (v10) (/b)\nletta (experimental): current (v1) (/c)\nopencode: outdated (v11 < v12) (/d)");
  assert.deepEqual(installedIntegrationKinds(records), ["codex", "claude", "letta", "opencode"]);
  assert.deepEqual(integrations.launchableIntegrationKinds(records), ["codex", "opencode"]);
  assert.match(integrations.integrationProblem(records, "claude").message, /needs repair/);
  assert.match(integrations.integrationProblem(records, "letta").message, /experimental/);
  assert.match(integrations.integrationProblem(records, "cursor").message, /not installed/);
  assert.equal(integrations.integrationProblem(records, "opencode"), null);
  assert.equal(integrations.integrationDiagnostics(records).length, 3);
});

test("inventory paths are opaque, including relative homes and platform-specific separators", () => {
  for (const location of ["relative/home/hooks", "C:\\Users\\fixture\\hooks", "/tmp/home (personal)/hooks"]) {
    const records = parseIntegrationStatus(`codex: current (v8) (${location})`);
    assert.deepEqual(integrations.launchableIntegrationKinds(records), ["codex"]);
    assert.equal(records[0].version, "8");
  }
});

test("malformed and conflicting inventory entries cannot become launch candidates", () => {
  for (const lines of [
    ["codex: current (v8) (/a)", "codex: not installed (/a)"],
    ["agy: current (v1) (/a)", "antigravity-cli: needs repair (v1) (/a)"],
  ]) {
    const forward = parseIntegrationStatus(lines.join("\n"));
    const reverse = parseIntegrationStatus(lines.toReversed().join("\n"));
    assert.deepEqual(forward, reverse);
    assert.equal(forward[0].status, "conflicting");
    assert.equal(forward[0].installed, false);
  }
  for (const line of ["codex: current nonsense", "codex: current (vbroken) (/a)", "codex: mystery (/a)", "codex: current",
    "codex: current (v8)", "codex: installed (/a)", "codex: current (v8 < v9) (/a)", "codex: outdated (v8) (/a)",
    "codex: outdated (v9 < v9) (/a)", "codex: needs repair (legacy) (/a)", "codex: not installed"]) {
    const [record] = parseIntegrationStatus(line);
    assert.equal(record.status, "unknown");
    assert.equal(record.installed, false);
  }
  assert.equal(parseIntegrationStatus("codex: current (legacy) (/a)")[0].status, "current");
  const records = parseIntegrationStatus("heading\ncodex: current (v8) (/a)\ncodex: current (v8) (/a)\n");
  assert.deepEqual(installedIntegrationKinds(records), ["codex"]);
  assert.equal(records.length, 1);
});

test("experimental repair points at no install command that cannot make it launchable", () => {
  const records = parseIntegrationStatus("letta (experimental): needs repair (v2) (/a)");
  const problem = integrations.integrationProblem(records, "letta");
  assert.match(problem.message, /experimental/);
  assert.deepEqual(problem.help, ["herdr integration status", "herdr integration install --help"]);
  assert.equal(integrations.installedIntegrationKinds, undefined);
});
