const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const release = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");
const preview = readFileSync(join(__dirname, "../workflows/web-preview.yml"), "utf8");
const stepPattern =
  /        name: (?:Build staged deployment|Deploy preview)\n        shell: bash\n        run: \|\n((?:          .*\n|\n)+)/g;
const steps = [
  ...Array.from(release.matchAll(stepPattern), (match, index) => [
    index === 0 ? "hosted web" : "marketing",
    match[1],
  ]),
  ...Array.from(preview.matchAll(stepPattern), (match) => ["web preview", match[1]]),
];
assert.equal(steps.length, 3, "Expected both release steps and the preview step");

const url = "https://t3code-fixture-pinglabs.vercel.app";
const warning = 'Error while parsing config file: "/runner/t3code/pnpm-lock.yaml"';

function runStep(script, stdout, exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), "t3-vercel-output-"));
  const outputFile = join(directory, "output");
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'vp() { printf "%s\\n" "$FIXTURE_STDOUT"; return "$FIXTURE_EXIT"; }\n' +
          'curl() { printf \'{"id":"fixture-project"}\\n\'; }\n' +
          script.replace(/^          /gm, "").replace(/\$\{\{.*?\}\}/g, "fixture"),
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          VERCEL_TOKEN: "fixture-token",
          VERCEL_ORG_ID: "fixture-org",
          VERCEL_PROJECT_ID: "fixture-project",
          GITHUB_OUTPUT: outputFile,
          FIXTURE_STDOUT: stdout,
          FIXTURE_EXIT: String(exitCode),
        },
      },
    );
    assert.ifError(result.error);
    return {
      ...result,
      output: existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [name, script] of steps) {
  for (const [label, stdout] of [
    ["plain URL", url],
    ["lockfile warning", `${warning}\n${url}`],
    ["trailing diagnostic", `${url}\nDone`],
  ]) {
    test(`${name}: saves one deployment URL after ${label}`, () => {
      const result = runStep(script, stdout);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        result.output.split("\n").filter((line) => !line.startsWith("project_id=")),
        [`deployment_url=${url}`, ""],
      );
    });
  }

  for (const [label, stdout, exitCode] of [
    ["missing URL", warning, 0],
    ["invalid URL", "https://example.invalid/deployment", 0],
    ["multiple URLs", `${url}\nhttps://other.vercel.app`, 0],
    ["failed deployment", url, 1],
  ]) {
    test(`${name}: rejects ${label} without saving output`, () => {
      const result = runStep(script, stdout, exitCode);
      assert.notEqual(result.status, 0);
      assert.equal(result.output, "");
    });
  }
}
