#!/usr/bin/env node
// Runs one web test shard (usage: web-test.cjs <index>/<total>). When Chromium drops
// its vitest connection with no failed test, it reruns only the unfinished files and
// passes with a warning if they pass. A second closure, a closure before any file
// passed, or any real failure fails.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INFRA_MESSAGE = "Infrastructure failure, not a test failure: the browser connection closed.";
const CLOSED_AGAIN =
  "The browser connection closed again while rerunning the unfinished files; treat it as a real failure.";
const SUMMARY = /^\s*Test Files\s+(.*)\((\d+)\)\s*$/m;

const CLOSED = /VITEST_BROWSER_CONNECTION_CLOSED|Browser connection was closed while running tests/;
// One header per error; the plural "Unhandled Errors" banner does not match.
const ERROR_HEADER =
  /(?:Unhandled (?:Error|Rejection)|Uncaught Exception|Browser Error|Test Run Error|Teardown Error) ⎯/g;
const ERRORS_SUMMARY = /^\s*Errors\s+(\d+) errors?\b/m;
const FAILURE_MARKERS = [
  /^\s*FAIL\s/m, // failed test file or test in the report
  /^\s*[×✗]\s/m, // failed test line
  /^\s*❯ .*\(\d+ tests?\b[^)]*\)/m, // file with a failure, also one that failed to import
  /Failed (?:Tests?|Suites?) \d+/, // report banners
  /^\s*(?:Test Files|Tests)\s.*\b\d+ failed\b/m, // summary counts
  /AssertionError/,
  /Snapshots?\s.*\b\d+ failed\b/,
];

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

// Returns "pass", "fail" or "browser-closed". Anything unclear is "fail".
function classify(rawOutput, exitCode) {
  if (exitCode === 0) return "pass";
  const output = stripAnsi(rawOutput);
  if (!CLOSED.test(output)) return "fail";
  if (FAILURE_MARKERS.some((marker) => marker.test(output))) return "fail";
  // Every error block must be a browser-closed one.
  const starts = [...output.matchAll(ERROR_HEADER)].map((match) => match.index);
  const blocks = starts.map((start, i) => output.slice(start, starts[i + 1]));
  if (blocks.some((block) => !CLOSED.test(block))) return "fail";
  const errors = output.match(ERRORS_SUMMARY);
  if (errors && Number(errors[1]) > Math.max(blocks.length, 1)) return "fail";
  return "browser-closed";
}

function runOnce(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      output += chunk;
    });
    child.on("error", (error) => {
      output += String(error);
      resolve({ code: 1, output });
    });
    child.on("close", (code) => resolve({ code: code === null ? 1 : code, output }));
  });
}

function summary(line) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // The summary is a convenience; the log line above already says it.
  }
}

// Reads web-test-reporter.mjs's record: the shard's files and each finished file.
function readRecord(file) {
  const record = { planned: [], finished: [] };
  if (!fs.existsSync(file)) return record;
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.planned) record.planned.push(...entry.planned);
    if (entry.finished) record.finished.push(entry.finished);
  }
  return record;
}

const key = ({ file, project }) => `${project}:${file}`;
const isDone = ({ state }) => state === "passed" || state === "skipped";

// Returns the step's exit code. `rerun(files)` runs the given test files once more.
async function decide(first, record, rerun, log = console.log) {
  if (classify(first.output, first.code) !== "browser-closed") return first.code;
  const fail = (message) => {
    log(`::error title=Web tests::${message}`);
    summary(`❌ ${message}`);
    return first.code || 1;
  };
  const output = stripAnsi(first.output);
  const file = output.match(/Failed to run the test (\S+?)\.?$/m)?.[1];
  const where = file ? ` It closed during ${file}.` : "";
  const counts = output.match(SUMMARY);
  if (!counts) return fail(`The browser connection closed before Vitest's summary.${where}`);
  const summaryPassed = Number(counts[1].match(/(\d+) passed/)?.[1] ?? 0);
  const done = new Set(record.finished.filter(isDone).map(key));
  const passed = record.finished.filter((f) => f.state === "passed").length;
  const failed = record.finished.find((f) => f.state === "failed");
  if (failed) return fail(`${failed.file} failed before the browser connection closed.`);
  if (summaryPassed === 0 || passed === 0 || record.planned.length === 0) {
    return fail(`The browser connection closed before any test file passed.${where}`);
  }
  const unfinished = record.planned.filter((spec) => !done.has(key(spec)));
  if (unfinished.length === 0) {
    log(`::warning title=Web tests::${INFRA_MESSAGE}${where} Every test file had finished.`);
    summary(`⚠️ ${INFRA_MESSAGE}${where} Every test file had finished.`);
    return 0;
  }

  const files = [...new Set(unfinished.map((spec) => spec.file))];
  log(
    `::warning title=Web tests::${INFRA_MESSAGE}${where} Rerunning the ${files.length} of ${record.planned.length} test files that did not finish.`,
  );
  const second = await rerun(files);
  const verdict = classify(second.output, second.code);
  if (verdict === "pass") {
    const rerunDone = new Set(second.record.finished.filter(isDone).map(key));
    const missing = unfinished.filter((spec) => !rerunDone.has(key(spec)));
    if (missing.length > 0) {
      return fail(`The rerun did not finish ${missing[0].file} (${missing[0].project}).`);
    }
    summary(
      `⚠️ ${INFRA_MESSAGE}${where} The ${files.length} unfinished test files passed on a rerun.`,
    );
    return 0;
  }
  if (verdict === "browser-closed") {
    log(`::error title=Web tests::${CLOSED_AGAIN}`);
    summary(`❌ ${CLOSED_AGAIN}`);
    return second.code || 1;
  }
  return second.code;
}

async function main() {
  const shard = process.argv[2];
  if (!/^\d+\/\d+$/.test(shard ?? "")) {
    console.error("usage: web-test.cjs <index>/<total>");
    process.exit(2);
  }
  const recordFile = path.join(
    process.env.RUNNER_TEMP ?? os.tmpdir(),
    `web-test-record-${process.pid}.jsonl`,
  );
  const reporters = [
    "--reporter=default",
    ...(process.env.GITHUB_ACTIONS === "true" ? ["--reporter=github-actions"] : []),
    `--reporter=${path.join(__dirname, "web-test-reporter.mjs")}`,
  ];
  const first = await runOnce(
    "vp",
    ["run", "--filter", "@t3tools/web", "test", `--shard=${shard}`, ...reporters],
    { env: { ...process.env, WEB_TEST_RECORD: recordFile } },
  );
  const code = await decide(first, readRecord(recordFile), async (files) => {
    console.log(`\n=== Rerun of ${files.length} unfinished test files ===\n`);
    const rerunRecord = `${recordFile}.rerun`;
    const result = await runOnce(
      "vp",
      ["test", "run", "--project", "unit", "--project", "browser", ...reporters, ...files],
      {
        cwd: path.join(__dirname, "../../apps/web"),
        env: { ...process.env, WEB_TEST_RECORD: rerunRecord },
      },
    );
    return { ...result, record: readRecord(rerunRecord) };
  });
  process.exit(code);
}

module.exports = { classify, decide, INFRA_MESSAGE, CLOSED_AGAIN };

if (require.main === module) main();
