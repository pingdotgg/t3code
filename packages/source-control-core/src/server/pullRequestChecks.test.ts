import type { PullRequestCheck, PullRequestCheckStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CHECK_LOG_EXCERPT_BUDGET, dedupeChecks, excerptCheckLog } from "./pullRequestChecks.ts";

function entry(
  name: string,
  status: PullRequestCheckStatus,
  extra: {
    readonly workflowName?: string | null;
    readonly at?: string | null;
    readonly sequence?: number;
  } = {},
): {
  readonly check: PullRequestCheck;
  readonly workflowName: string | null;
  readonly at: string | null;
  readonly sequence?: number;
} {
  return {
    check: { name, status, description: null, url: null },
    workflowName: extra.workflowName ?? null,
    at: extra.at ?? null,
    ...(extra.sequence === undefined ? {} : { sequence: extra.sequence }),
  };
}

describe("dedupeChecks", () => {
  // regression: #20094 runs were compared as timestamp text, picking the older run
  it.each([
    ["2026-10-16T12:00:00+02:00", "2026-10-16T10:30:00Z"],
    ["2026-10-16T12:00:00.00009Z", "2026-10-16T12:00:00.0001Z"],
  ])("keeps the newer instant between %s and %s in either listing order", (older, newer) => {
    const oldRun = entry("build", "success", { at: older });
    const newRun = entry("build", "failure", { at: newer });

    expect(
      [
        [oldRun, newRun],
        [newRun, oldRun],
      ].map((runs) => dedupeChecks(runs)[0]?.status),
    ).toEqual(["failure", "failure"]);
  });

  it.each([
    ["2026-10-16T12:00:00Z", "2026-10-16T14:00:00+02:00"],
    ["2026-10-16T24:00:00.000Z", "2026-10-17T00:00:00Z"],
    ["2026-10-16T12:00Z", "2026-10-16T12:00:00Z"],
  ])("takes the last copy for equal instants %s and %s", (first, second) => {
    const forward = dedupeChecks([
      entry("build", "success", { at: first }),
      entry("build", "failure", { at: second }),
    ]);
    const reversed = dedupeChecks([
      entry("build", "success", { at: second }),
      entry("build", "failure", { at: first }),
    ]);

    expect([forward[0]?.status, reversed[0]?.status]).toEqual(["failure", "failure"]);
  });

  it("takes the higher sequence when instants tie, whichever is listed first", () => {
    const final = entry("build", "success", { at: "2026-10-12T10:14:29Z", sequence: 15 });
    const pending = entry("build", "pending", { at: "2026-10-12T10:14:29Z", sequence: 14 });

    expect(
      [
        [final, pending],
        [pending, final],
      ].map((runs) => dedupeChecks(runs)[0]?.status),
    ).toEqual(["success", "success"]);
  });

  it("lets a newer instant win over a higher sequence", () => {
    const stale = entry("build", "success", { at: "2026-10-12T10:14:29Z", sequence: 15 });
    const fresh = entry("build", "failure", { at: "2026-10-12T10:14:30Z", sequence: 14 });

    expect(
      [
        [stale, fresh],
        [fresh, stale],
      ].map((runs) => dedupeChecks(runs)[0]?.status),
    ).toEqual(["failure", "failure"]);
  });

  it("takes the last copy for equal instants when only one run has a sequence", () => {
    const checks = dedupeChecks([
      entry("build", "success", { at: "2026-10-12T10:14:29Z", sequence: 15 }),
      entry("build", "failure", { at: "2026-10-12T10:14:29Z" }),
    ]);

    expect(checks.map((check) => check.status)).toEqual(["failure"]);
  });

  it.each([
    ["2026-10-16", "2026-10-15T23:00:00-02:00", "success"],
    ["2026-10-16T00:00:00", "2026-10-15T23:00:00-02:00", "success"],
    ["2026-10-16T24:00:00.0001Z", "2026-10-17T00:00:00Z", "failure"],
  ])("uses text fallback for incomplete or invalid timestamp %s", (malformed, valid, expected) => {
    const malformedRun = entry("build", "success", { at: malformed });
    const validRun = entry("build", "failure", { at: valid });

    expect(
      [
        [malformedRun, validRun],
        [validRun, malformedRun],
      ].map((runs) => dedupeChecks(runs)[0]?.status),
    ).toEqual([expected, expected]);
  });

  it.each([["2026-02-30T00:00:00Z", "2026-03-01T00:00:00Z"]])(
    "uses text fallback for impossible date %s",
    (malformed, valid) => {
      const malformedRun = entry("build", "success", { at: malformed });
      const validRun = entry("build", "failure", { at: valid });

      expect(
        [
          [malformedRun, validRun],
          [validRun, malformedRun],
        ].map((runs) => dedupeChecks(runs)[0]?.status),
      ).toEqual(["failure", "failure"]);
    },
  );

  it("holds a check at the place it first appeared, so a re-run does not reshuffle the list", () => {
    const checks = dedupeChecks([
      entry("lint", "success", { workflowName: "CI", at: "2026-08-11T16:00:00Z" }),
      entry("test", "success", { workflowName: "CI", at: "2026-08-11T16:00:00Z" }),
      entry("lint", "failure", { workflowName: "CI", at: "2026-08-11T18:00:00Z" }),
    ]);

    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["lint", "failure"],
      ["test", "success"],
    ]);
  });

  it("puts failed and cancelled checks first, preserving each group's order after reruns", () => {
    const checks = dedupeChecks([
      entry("lint", "failure", { at: "2026-08-11T16:00:00Z" }),
      entry("integration", "cancelled"),
      entry("types", "pending"),
      entry("unit", "failure"),
      entry("format", "success"),
      entry("lint", "success", { at: "2026-08-11T18:00:00Z" }),
    ]);

    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["integration", "cancelled"],
      ["unit", "failure"],
      ["lint", "success"],
      ["types", "pending"],
      ["format", "success"],
    ]);
  });

  it("keeps distinct workflow and check pairs even when their names join to the same text", () => {
    const checks = dedupeChecks([
      entry("Linux tests", "success", {
        workflowName: "Build",
        at: "2026-08-11T16:00:00Z",
      }),
      entry("tests", "success", {
        workflowName: "Build Linux",
        at: "2026-08-11T17:00:00Z",
      }),
      entry("Linux tests", "failure", {
        workflowName: "Build",
        at: "2026-08-11T18:00:00Z",
      }),
    ]);

    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["Linux tests", "failure"],
      ["tests", "success"],
    ]);
  });

  it("loses a run that never said when it happened to one that did, whichever came first", () => {
    const undated = dedupeChecks([
      entry("build", "success", { at: "2026-08-11T16:00:00Z" }),
      entry("build", "pending"),
    ]);
    const dated = dedupeChecks([
      entry("build", "pending"),
      entry("build", "success", { at: "2026-08-11T16:00:00Z" }),
    ]);

    expect([undated[0]?.status, dated[0]?.status]).toEqual(["success", "success"]);
  });

  it("takes the last copy when neither run is dated, which is how an update is listed", () => {
    const checks = dedupeChecks([entry("build", "pending"), entry("build", "failure")]);

    expect(checks.map((check) => check.status)).toEqual(["failure"]);
  });

  it("keeps two workflows that name a job the same thing, and says which is which", () => {
    const checks = dedupeChecks([
      entry("build", "success", { workflowName: "CI", at: "2026-08-11T16:00:00Z" }),
      entry("build", "failure", { workflowName: "Release", at: "2026-08-11T16:00:00Z" }),
    ]);

    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["Release / build", "failure"],
      ["CI / build", "success"],
    ]);
  });

  it("leaves a colliding check with no workflow of its own unqualified", () => {
    const checks = dedupeChecks([
      entry("build", "success", { workflowName: "", at: "2026-08-11T16:00:00Z" }),
      entry("build", "failure", { workflowName: "CI", at: "2026-08-11T16:00:00Z" }),
    ]);

    expect(checks.map((check) => check.name)).toEqual(["CI / build", "build"]);
  });
});

describe("check log excerpts", () => {
  it.each([
    { chunks: [""], text: "", lines: 0 },
    {
      chunks: ["2026-10-30T12:00:00.1234567Z \u001b[31merror\u001b[0m\n"],
      text: "error",
      lines: 1,
    },
    { chunks: ["one\ntw", "o\nthree"], text: "one\ntwo\nthree", lines: 3 },
    {
      chunks: [
        [
          " ❯ ~effect/Effect/successCont ../../node_modules/.pnpm/effect@4.1.3/node_modules/effect/dist/esm/Effect.js:1:1",
          " ❯ FiberImpl.runLoop ../../node_modules/.pnpm/effect@4.1.3/node_modules/effect/dist/esm/internal/fiberRuntime.js:1:1",
          "##[start-action display=Install dependencies;id=install]",
          "##[end-action id=install;outcome=success;conclusion=success;duration_ms=900]",
          "Post job cleanup.",
          "Cleaning up orphan processes",
          " ❯ runAssertion src/example.test.ts:10:5",
        ].join("\n"),
      ],
      text: " ❯ runAssertion src/example.test.ts:10:5",
      lines: 7,
    },
    {
      chunks: [
        [
          "##[error]TypeError: boom",
          "    at Object.<anonymous> (/home/runner/work/app/node_modules/foo/index.js:1:1)",
          "    at Object.<anonymous> (/home/runner/work/app/src/build.js:2:2)",
        ].join("\n"),
      ],
      text: "##[error]TypeError: boom\n    at Object.<anonymous> (/home/runner/work/app/src/build.js:2:2)",
      lines: 3,
    },
    {
      chunks: [
        [
          "##[start-action display=Install dependencies;id=install]",
          "##[end-action id=install;outcome=success;conclusion=success;duration_ms=900]",
          "##[start-action display=Build;id=build]",
          "##[error]The action has timed out.",
          "##[end-action id=build;outcome=failure;conclusion=failure;duration_ms=1250]",
        ].join("\n"),
      ],
      text: "##[error]The action has timed out.\n##[end-action id=build;outcome=failure;conclusion=failure;duration_ms=1250]",
      lines: 5,
    },
  ])(
    "strips formatting and counts lines across chunks %#",
    ({ chunks, text, lines, truncated = false }) => {
      expect(excerptCheckLog(chunks)).toEqual({
        _tag: "excerpt",
        text,
        totalLines: lines,
        truncated,
      });
    },
  );

  it("does not let noise consume error context or tail slots", () => {
    const noise = [
      " ❯ FiberImpl.runLoop ../../node_modules/.pnpm/effect@4.1.3/node_modules/effect/dist/esm/internal/fiberRuntime.js:1:1",
      "##[start-action display=Install dependencies;id=install]",
      "##[end-action id=install;outcome=success;conclusion=success;duration_ms=900]",
      "Post job cleanup.",
      "Cleaning up orphan processes",
    ];
    const expected = [
      "##[group]Run vp test",
      "before 1",
      "before 2",
      "before 3",
      "##[error]Assertion failed",
      "after 1",
      "after 2",
      "after 3",
      ...Array.from({ length: 20 }, (_, i) => `tail ${i}`),
    ];
    const result = excerptCheckLog([
      [
        ...expected.slice(0, 4),
        ...noise,
        ...expected.slice(4, 5),
        ...noise,
        ...expected.slice(5),
        ...noise,
      ].join("\n"),
    ]);

    expect(result.text).toBe(expected.join("\n"));
    expect(result.totalLines).toBe(expected.length + noise.length * 3);
    // Every real line is present, so dropped noise alone does not mark the excerpt truncated.
    expect(result.truncated).toBe(false);
  });

  it("keeps error context, its Run header and the tail within both budgets", () => {
    const lines = [
      "##[group]Run vp test",
      ...Array.from({ length: 100 }, (_, i) => `line ${i}`),
      "before",
      "##[error]Assertion failed",
      "after",
      ...Array.from({ length: 100 }, (_, i) => `cleanup ${i}`),
    ];
    const result = excerptCheckLog([lines.join("\n")]);
    expect(result.text).toContain("##[group]Run vp test");
    expect(result.text).toContain("before\n##[error]Assertion failed\nafter");
    expect(result.text).toContain("cleanup 99");
    expect(result.totalLines).toBe(lines.length);
    expect(result.truncated).toBe(true);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(CHECK_LOG_EXCERPT_BUDGET.maxLines);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(CHECK_LOG_EXCERPT_BUDGET.maxBytes);
  });

  it("keeps the failed section's tail over a later same-named step that passed", () => {
    const result = excerptCheckLog([
      [
        "##[group]Run vp test",
        "##[error]Assertion failed",
        "exit 1",
        "##[group]Run vp test",
        "all green",
        "more output",
        "still more",
        "done",
      ].join("\n"),
    ]);
    expect(result.text).toBe(
      "##[group]Run vp test\n##[error]Assertion failed\nexit 1\n##[group]Run vp test\nall green",
    );
    expect(result.totalLines).toBe(8);
    expect(result.truncated).toBe(true);
  });

  it.each([
    { name: "short", tailLineBytes: 16, oldestTailKept: true },
    { name: "long", tailLineBytes: 1024, oldestTailKept: false },
  ])("keeps the error window ahead of $name tail lines", ({ tailLineBytes, oldestTailKept }) => {
    const lines = [
      "##[group]Run vp test",
      "##[error]Assertion failed",
      "after",
      ...Array.from({ length: 30 }, (_, i) => `filler ${i}`),
      ...Array.from({ length: 20 }, (_, i) => `tail ${i} `.padEnd(tailLineBytes, "x")),
    ];
    const result = excerptCheckLog([lines.join("\n")]);
    expect(result.text).toContain("##[group]Run vp test\n##[error]Assertion failed\nafter");
    expect(result.text).toContain("tail 19 ");
    expect(result.text.includes("tail 0 ")).toBe(oldestTailKept);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(CHECK_LOG_EXCERPT_BUDGET.maxLines);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(CHECK_LOG_EXCERPT_BUDGET.maxBytes);
  });

  it("bounds huge Unicode lines and retains the end of a long stream", () => {
    function* chunks() {
      yield "🔥".repeat(20_000);
      yield "\n";
      for (let i = 0; i < 100_000; i++) yield `row ${i}\n`;
    }
    const result = excerptCheckLog(chunks());
    expect(result.totalLines).toBe(100_001);
    expect(result.text).toContain("row 99999");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(CHECK_LOG_EXCERPT_BUDGET.maxBytes);
  });
});
