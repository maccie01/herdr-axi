import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("run test runner uses dependencies from the incoming PATH and pins fake Herdr", (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "herdr-axi-test-path-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const name of ["jq", "rg"]) {
    const resolved = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    assert.equal(resolved.status, 0, `${name} must be available on the incoming PATH`);
    // The engine checks rg availability without invoking it; exercise nested PATH lookup from jq.
    const nestedLookup = name === "jq" ? "rg --version >/dev/null || exit 92\n" : "";
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf used >> ${quote(path.join(dir, `${name}.used`))}\n${nestedLookup}exec ${quote(resolved.stdout.trim())} "$@"\n`, { mode: 0o755 });
  }
  const hostileHerdr = path.join(dir, "herdr");
  fs.writeFileSync(hostileHerdr, `#!/bin/sh\nprintf invoked > ${quote(path.join(dir, "herdr.used"))}\nexit 91\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, HERDR_BIN: hostileHerdr };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--test", "--test-name-pattern=^one queue-start call",
    fileURLToPath(new URL("./runs-startup.test.mjs", import.meta.url)),
  ], {
    encoding: "utf8", timeout: 30000,
    env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /one queue-start call/);
  for (const name of ["jq", "rg"]) assert(fs.existsSync(path.join(dir, `${name}.used`)), `runner must execute ${name} supplied on incoming PATH`);
  assert(!fs.existsSync(path.join(dir, "herdr.used")), "runner must pin the fake backend");
});
