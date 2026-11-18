const assert = require("node:assert/strict");
const test = require("node:test");
const { classify, decide, INFRA_MESSAGE, CLOSED_AGAIN } = require("./web-test.cjs");

const esc = "\u001b";
const rule = "⎯⎯⎯⎯⎯⎯";

// Trimmed from main run 43108257661, Test Web 2, attempt 1.
const closedAfterRun = `
 ${esc}[32m✓${esc}[39m browser (chromium) src/components/CommandPaletteContent.browser.test.tsx (1 test) 191ms
${esc}[31m${rule}${esc}[39m${esc}[1m${esc}[41m Unhandled Errors ${esc}[49m${esc}[22m${esc}[31m${rule}${esc}[39m

Vitest caught 1 unhandled error during the test run.
${esc}[31m${rule}${esc}[39m${esc}[1m${esc}[41m Unhandled Error ${esc}[49m${esc}[22m${esc}[31m${rule}⎯${esc}[39m
Error: Failed to run the test /home/runner/work/conn/conn/apps/web/src/components/files/FileExplorerPane.browser.test.tsx.
Caused by: Error: [vitest] Browser connection was closed while running tests. Was the page closed unexpectedly?
Serialized Error: { code: 'VITEST_BROWSER_CONNECTION_CLOSED' }
Caused by: Error: [birpc] rpc is closed, cannot call "createTesters"

 Test Files  294 passed (302)
      Tests  2330 passed (2330)
     Errors  1 error
`;

// Trimmed from conn#33's Test Web 2: vitest died before its summary.
const closedMidRun = `
 ✓  browser (chromium)  src/components/device/DeviceToolsPanel.browser.test.tsx (1 test) 344ms
${rule} Unhandled Rejection ${rule}
Error: [vitest] There was an error when mocking a module.
Caused by: Error: [vitest] Browser connection was closed while running tests. Was the page closed unexpectedly?
Serialized Error: { code: 'VITEST_BROWSER_CONNECTION_CLOSED' }
Caused by: Error: [birpc] rpc is closed, cannot call "resolveManualMock"
`;

const failedAssertion = `
 ${esc}[31m❯${esc}[39m browser (chromium) src/components/Foo.browser.test.tsx (2 tests | 1 failed)
   ${esc}[31m×${esc}[39m renders the title 120ms
${rule} Failed Tests 1 ${rule}
 FAIL  browser (chromium) src/components/Foo.browser.test.tsx > renders the title
AssertionError: expected 'a' to be 'b'
`;

const plainFailure = `
 FAIL  unit src/lib/bar.test.ts > adds
AssertionError: expected 3 to be 4
 Test Files  1 failed | 300 passed (301)
      Tests  1 failed | 2329 passed (2330)
`;

test("a clean run passes", () => {
  assert.equal(classify("Test Files  302 passed (302)", 0), "pass");
});

test("browser closed with no failed test is a browser-closed run", () => {
  assert.equal(classify(closedAfterRun, 1), "browser-closed");
  assert.equal(classify(closedMidRun, 1), "browser-closed");
});

test("browser closed plus a failed assertion is a real failure", () => {
  assert.equal(classify(closedAfterRun + failedAssertion, 1), "fail");
  assert.equal(classify(closedMidRun + plainFailure, 1), "fail");
});

test("summary counts with a failed file or test are a real failure", () => {
  const failedFile = closedAfterRun.replace("294 passed (302)", "1 failed | 293 passed (302)");
  assert.equal(classify(failedFile, 1), "fail");
  const failedTest = closedAfterRun.replace("2330 passed (2330)", "1 failed | 2329 passed (2330)");
  assert.equal(classify(failedTest, 1), "fail");
});

test("a file that failed before its tests ran is a real failure", () => {
  const importFailed = " ❯ browser (chromium) src/components/Foo.browser.test.tsx (0 test)\n";
  assert.equal(classify(importFailed + closedMidRun, 1), "fail");
  const skipped =
    " ❯ browser (chromium) src/components/Foo.browser.test.tsx (2 tests | 2 skipped) 40ms\n";
  assert.equal(classify(skipped + closedMidRun, 1), "fail");
  assert.equal(classify(`${closedAfterRun}${rule} Failed Suites 1 ${rule}\n`, 1), "fail");
});

test("an error block without the signature is a real failure", () => {
  const uncaught = `${closedMidRun}${rule} Uncaught Exception ${rule}\nTypeError: x is not a function\n`;
  assert.equal(classify(uncaught, 1), "fail");
  const twiceCoded = closedMidRun.replace(
    "Caused by: Error: [birpc]",
    "{ code: 'VITEST_BROWSER_CONNECTION_CLOSED' }\n$&",
  );
  assert.equal(classify(`${twiceCoded}${rule} Unhandled Error ${rule}\nTypeError: y\n`, 1), "fail");
});

test("an extra unhandled error that is not browser-closed is a real failure", () => {
  const extraError = closedAfterRun
    .replace("Errors  1 error", "Errors  2 errors")
    .concat(`${rule} Unhandled Error ${rule}\nTypeError: x is not a function\n`);
  assert.equal(classify(extraError, 1), "fail");
});

test("a plain failure without the signature is a real failure", () => {
  assert.equal(classify(plainFailure, 1), "fail");
  assert.equal(classify("", 1), "fail");
});

const spec = (file, project = "browser") => ({ file, project });
const planned = Array.from({ length: 81 }, (_, i) => spec(`src/f${i}.browser.test.tsx`));
const finishedFirst = (n) => planned.slice(0, n).map((f) => ({ ...f, state: "passed" }));
const closedWith = (summaryLine) => `${closedMidRun}\n${summaryLine}\n     Errors  1 error\n`;

async function decideWith(first, record, ...reruns) {
  const lines = [];
  const rerunCalls = [];
  const code = await decide(
    first,
    record,
    async (files) => {
      rerunCalls.push(files);
      return reruns[rerunCalls.length - 1];
    },
    (line) => lines.push(line),
  );
  return { code, lines, rerunCalls };
}

test("a pass or a real failure keeps its exit code and does not rerun", async () => {
  const record = { planned, finished: finishedFirst(81) };
  for (const [result, expected] of [
    [{ code: 0, output: "" }, 0],
    [{ code: 1, output: closedAfterRun + failedAssertion }, 1],
    [{ code: 1, output: plainFailure }, 1],
  ]) {
    const run = await decideWith(result, record);
    assert.equal(run.code, expected);
    assert.equal(run.rerunCalls.length, 0);
  }
});

test("a closed browser reruns only the unfinished files and passes when they pass", async () => {
  const run = await decideWith(
    { code: 1, output: closedWith(" Test Files  75 passed (81)") },
    { planned, finished: finishedFirst(75) },
    {
      code: 0,
      output: " Test Files  6 passed (6)",
      record: { finished: finishedFirst(81).slice(75) },
    },
  );
  assert.equal(run.code, 0);
  assert.deepEqual(run.rerunCalls, [planned.slice(75).map((f) => f.file)]);
  assert.ok(run.lines[0].startsWith(`::warning title=Web tests::${INFRA_MESSAGE}`));
});

test("a closed browser fails when the rerun closes again or fails", async () => {
  const record = { planned, finished: finishedFirst(1) };
  const closedAgain = await decideWith(
    { code: 1, output: closedWith(" Test Files  1 passed (81)") },
    record,
    { code: 1, output: closedWith(" Test Files  3 passed (80)") },
  );
  assert.equal(closedAgain.code, 1);
  assert.equal(closedAgain.rerunCalls[0].length, 80);
  assert.ok(closedAgain.lines.includes(`::error title=Web tests::${CLOSED_AGAIN}`));

  const realFailure = await decideWith(
    { code: 1, output: closedWith(" Test Files  1 passed (81)") },
    record,
    { code: 1, output: plainFailure },
  );
  assert.equal(realFailure.code, 1);
});

test("a closed browser fails without a rerun when no summary or no passed file", async () => {
  for (const [output, finished] of [
    [closedMidRun, finishedFirst(40)],
    [closedWith(" Test Files  (81)"), finishedFirst(0)],
    [closedWith(" Test Files  1 passed (81)"), finishedFirst(0)],
    [closedWith(" Test Files  1 passed (81)"), []],
  ]) {
    const run = await decideWith({ code: 1, output }, { planned, finished });
    assert.equal(run.code, 1);
    assert.equal(run.rerunCalls.length, 0);
    assert.ok(run.lines[0].startsWith("::error title=Web tests::"));
  }
  const noRecord = await decideWith(
    { code: 1, output: closedWith(" Test Files  5 passed (81)") },
    { planned: [], finished: [] },
  );
  assert.equal(noRecord.code, 1);
  assert.equal(noRecord.rerunCalls.length, 0);
});

test("a closed browser after every file finished passes with a warning", async () => {
  const run = await decideWith(
    { code: 1, output: closedWith(" Test Files  81 passed (81)") },
    { planned, finished: finishedFirst(81) },
  );
  assert.equal(run.code, 0);
  assert.equal(run.rerunCalls.length, 0);
  assert.match(run.lines[0], /^::warning title=Web tests::/);
});

test("a closed browser fails when a recorded file failed or the rerun missed a file", async () => {
  const failedFile = await decideWith(
    { code: 1, output: closedWith(" Test Files  75 passed (81)") },
    { planned, finished: [...finishedFirst(74), { ...planned[74], state: "failed" }] },
  );
  assert.equal(failedFile.code, 1);
  assert.equal(failedFile.rerunCalls.length, 0);

  const tooFew = await decideWith(
    { code: 1, output: closedWith(" Test Files  75 passed (81)") },
    { planned, finished: finishedFirst(75) },
    {
      code: 0,
      output: " Test Files  6 passed (6)",
      record: {
        finished: [
          ...finishedFirst(80).slice(75),
          { ...planned[80], project: "unit", state: "passed" },
        ],
      },
    },
  );
  assert.equal(tooFew.code, 1);
  assert.ok(
    tooFew.lines.some((line) => line.includes("did not finish src/f80.browser.test.tsx (browser)")),
  );
});
