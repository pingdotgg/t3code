import { describe, expect, it } from "@effect/vitest";

import { buildProof, readSide } from "./prove-scenario.ts";

const report = (exitCode: number, error?: { code: string; message: string }) => ({
  run: {
    exitCode,
    results: [
      { titlePath: ["Another scenario the run did not select"], attempts: [] },
      {
        titlePath: ["Tab reaches the submit button"],
        attempts: [
          {
            steps: [
              { api: "app.open", label: "/pair#token=secret", status: "passed" },
              { api: "expect.toBeFocused", label: "Continue", status: error ? "failed" : "passed" },
            ],
            ...(error === undefined ? {} : { error }),
            artifacts: [
              { kind: "screenshot", path: "tab/attempt-1/screenshots/001-after-tab.png" },
              { kind: "video", path: "tab/attempt-1/video/video.webm" },
            ],
          },
        ],
      },
    ],
  },
});

const passed = report(0);
const failed = report(1, { code: "ASSERTION_FAILED", message: "expected: focused" });
// The control the scenario clicks is missing: the scenario is broken, the bug is not shown.
const brokenScenario = report(1, { code: "LOCATOR_NOT_FOUND", message: "no node" });

describe("prove-scenario", () => {
  it.each([
    { base: failed, head: passed, failsOnBase: true, passesOnHead: true, verdict: /^Proven/ },
    // A "fix" for behavior that never happens: the scenario must fail before it can prove.
    {
      base: passed,
      head: passed,
      failsOnBase: false,
      passesOnHead: true,
      verdict: /passes on base/,
    },
    { base: failed, head: failed, failsOnBase: true, passesOnHead: false, verdict: /still fails/ },
    {
      base: brokenScenario,
      head: passed,
      failsOnBase: false,
      passesOnHead: true,
      verdict: /could not run on base/,
    },
    // e2e writes no report when the app does not start.
    {
      base: undefined,
      head: passed,
      failsOnBase: false,
      passesOnHead: true,
      verdict: /could not run on base/,
    },
  ])("reports $verdict", (row) => {
    const proof = buildProof(
      readSide("aaaaaaaaaaaa", "/out/base", row.base),
      readSide("bbbbbbbbbbbb", "/out/head", row.head),
      (path) => path,
    );
    expect(proof).toMatchObject({ failsOnBase: row.failsOnBase, passesOnHead: row.passesOnHead });
    expect(proof.verdict).toMatch(row.verdict);
  });

  it("labels captures with their side and commit and keeps the pairing token out", () => {
    const proof = buildProof(
      readSide("aaaaaaaaaaaa", "/out/base", failed),
      readSide("bbbbbbbbbbbb", "/out/head", passed),
      (path) => `https://files.example${path}`,
    );
    expect(proof.markdown).toContain("|  | Base `aaaaaaaaaa` | Head `bbbbbbbbbb` |");
    expect(proof.markdown).toContain(
      "![Base aaaaaaaaaa: after tab](https://files.example/out/base/results/tab/attempt-1/screenshots/001-after-tab.png)",
    );
    expect(proof.videos).toEqual([
      "/out/base/results/tab/attempt-1/video/video.webm",
      "/out/head/results/tab/attempt-1/video/video.webm",
    ]);
    expect(JSON.stringify(proof)).not.toContain("secret");
  });
});
