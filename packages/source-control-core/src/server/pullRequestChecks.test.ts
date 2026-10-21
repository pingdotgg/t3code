import type { PullRequestCheck, PullRequestCheckStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dedupeChecks } from "./pullRequestChecks.ts";

function entry(
  name: string,
  status: PullRequestCheckStatus,
  extra: { readonly workflowName?: string | null; readonly at?: string | null } = {},
): {
  readonly check: PullRequestCheck;
  readonly workflowName: string | null;
  readonly at: string | null;
} {
  return {
    check: { name, status, description: null, url: null },
    workflowName: extra.workflowName ?? null,
    at: extra.at ?? null,
  };
}

describe("dedupeChecks", () => {
  // regression: #20094 runs were compared as timestamp text, picking the older run
  it.each([
    ["2026-10-16T12:00:00+02:00", "2026-10-16T10:30:00Z"],
    ["2026-10-16T12:00:00.00009Z", "2026-10-16T12:00:00.0001Z"],
    ["2024-03-01T01:00:00Z", "2024-02-29T23:30:00-02:00"],
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

  it.each([
    ["2026-02-30T00:00:00Z", "2026-03-01T00:00:00Z"],
    ["1900-02-29T00:00:00Z", "1900-03-01T00:00:00Z"],
    ["2026-04-31T00:00:00.0001-02:00", "2026-05-01T00:00:00Z"],
  ])("uses text fallback for impossible date %s", (malformed, valid) => {
    const malformedRun = entry("build", "success", { at: malformed });
    const validRun = entry("build", "failure", { at: valid });

    expect(
      [
        [malformedRun, validRun],
        [validRun, malformedRun],
      ].map((runs) => dedupeChecks(runs)[0]?.status),
    ).toEqual(["failure", "failure"]);
  });

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
