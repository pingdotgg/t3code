const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { decide, readWorkspace } = require("./ci-changes.cjs");

const { outputs } = decide(["docs/internals/testing.md"], readWorkspace(), false);
const docsOnly = {
  changes: {
    result: "success",
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([key, value]) => [key, String(value)]),
    ),
  },
  lint: { result: "skipped" },
  build: { result: "skipped" },
  test: { result: "skipped" },
  test_web: { result: "skipped" },
  test_server: { result: "success" },
  rust: { result: "skipped" },
  mobile_native_static_analysis: { result: "skipped" },
  release_smoke: { result: "skipped" },
};

const workflow = readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
const step = workflow.split("      - name: Require every job to pass\n")[1];
const checkScript = step?.match(/^        run: \|\n((?:^ {10}[^\n]*\n)+)/m)?.[1];
assert.ok(checkScript, "CI must have a shell step that checks the job results");

function check(fork, jobs = {}) {
  const result = spawnSync("bash", ["-e", "-c", checkScript], {
    env: {
      ...process.env,
      FORK_CI: String(fork),
      RESULTS: JSON.stringify({ ...docsOnly, ...jobs }),
    },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert.equal(result.stderr, "");
  assert.ok(result.status === 0 || result.status === 1, `unexpected jq exit: ${result.status}`);
  return result.status === 0;
}

test("docs-only fork CI requires the build job that runs lint", () => {
  assert.equal(check(true), false, "both Lint and Build were skipped");
  assert.equal(check(true, { build: { result: "success" } }), true);
  assert.equal(check(true, { build: { result: "cancelled" } }), false);
  assert.equal(check(true, { build: { result: "failure" } }), false);
});

test("docs-only upstream CI requires Lint and can skip Build", () => {
  assert.equal(check(false), false);
  assert.equal(check(false, { lint: { result: "success" } }), true);
});

test("fork Rust may skip only when Rust and Release Smoke are both unnecessary", () => {
  assert.equal(
    check(true, {
      build: { result: "success" },
      changes: {
        ...docsOnly.changes,
        outputs: { ...docsOnly.changes.outputs, release_smoke: "true" },
      },
    }),
    false,
  );
});
