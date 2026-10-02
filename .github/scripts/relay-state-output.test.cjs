const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const workflow = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");
const step = workflow.match(
  /- name: Read production relay tracing config\n[\s\S]*?        run: \|\n((?:          .*\n|\n)+)/,
);
assert.ok(step, "Could not find the relay state workflow step");
const script = step[1].replace(/^          /gm, "");
const config = {
  clientTracingUrl: "https://example.invalid/traces",
  clientTracingDataset: "fixture-dataset",
  clientTracingToken: { __redacted__: "fixture-token" },
};
const json = JSON.stringify(config, null, 2);

function runStep(stdout, exitCode = 0) {
  const runnerTemp = mkdtempSync(join(tmpdir(), "t3-relay-state-test-"));
  try {
    const result = spawnSync(
      "bash",
      ["-c", 'npx() { printf "%s\\n" "$FIXTURE_STDOUT"; return "$FIXTURE_EXIT"; }\n' + script],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: runnerTemp,
          FIXTURE_STDOUT: stdout,
          FIXTURE_EXIT: String(exitCode),
        },
      },
    );
    assert.ifError(result.error);
    const envPath = join(runnerTemp, "relay-client-tracing.env");
    return {
      ...result,
      envFile: existsSync(envPath) ? readFileSync(envPath, "utf8") : undefined,
    };
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
}

for (const prefix of [
  "",
  "• Refreshing Cloudflare State Store credentials\n✓ Refreshing Cloudflare State Store credentials\n",
]) {
  test(`extracts tracing config ${prefix ? "after progress output" : "from plain JSON"}`, () => {
    const result = runStep(prefix + json);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "::add-mask::fixture-token\n");
    assert.equal(
      result.envFile,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=https://example.invalid/traces\n" +
        "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET=fixture-dataset\n" +
        "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=fixture-token\n",
    );
  });
}

for (const [name, stdout, exitCode] of [
  ["failed CLI even with valid JSON", json, 1],
  ["missing JSON", "Refreshing credentials...", 0],
  ["malformed JSON", "{not JSON", 0],
  ["missing token", JSON.stringify({ ...config, clientTracingToken: null }, null, 2), 0],
]) {
  test(`rejects ${name} without writing config`, () => {
    const result = runStep(stdout, exitCode);
    assert.notEqual(result.status, 0);
    assert.equal(result.envFile, undefined);
  });
}
