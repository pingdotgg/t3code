import { describe, expect, it } from "vite-plus/test";

import { formatThreadHeaderElapsed, resolveThreadHeaderStatus } from "./threadHeaderPresentation";

describe("thread header presentation", () => {
  it("formats the working timer as compact minutes and seconds", () => {
    expect(
      formatThreadHeaderElapsed("2026-07-31T12:00:00.000Z", Date.parse("2026-07-31T12:02:14.000Z")),
    ).toBe("2:14");
    expect(formatThreadHeaderElapsed("invalid", Date.now())).toBeNull();
  });

  it("prioritizes actionable states over active work", () => {
    expect(
      resolveThreadHeaderStatus({
        hasPendingApproval: true,
        hasPendingUserInput: true,
        active: true,
        failed: false,
        activeWorkStartedAt: "2026-07-31T12:00:00.000Z",
        nowMs: Date.parse("2026-07-31T12:02:14.000Z"),
      }).kind,
    ).toBe("approval");
    expect(
      resolveThreadHeaderStatus({
        hasPendingApproval: false,
        hasPendingUserInput: true,
        active: true,
        failed: false,
        activeWorkStartedAt: null,
        nowMs: 0,
      }).kind,
    ).toBe("input");
  });

  it("shows a timed working state and a green done state", () => {
    expect(
      resolveThreadHeaderStatus({
        hasPendingApproval: false,
        hasPendingUserInput: false,
        active: true,
        failed: false,
        activeWorkStartedAt: "2026-07-31T12:00:00.000Z",
        nowMs: Date.parse("2026-07-31T12:02:14.000Z"),
      }),
    ).toMatchObject({ kind: "working", label: "2:14", nativeLabel: "2:14" });
    expect(
      resolveThreadHeaderStatus({
        hasPendingApproval: false,
        hasPendingUserInput: false,
        active: false,
        failed: false,
        activeWorkStartedAt: null,
        nowMs: 0,
      }),
    ).toMatchObject({ kind: "done", label: "Done", nativeLabel: "Done" });
  });

  it("does not label failed work as done", () => {
    expect(
      resolveThreadHeaderStatus({
        hasPendingApproval: false,
        hasPendingUserInput: false,
        active: false,
        failed: true,
        activeWorkStartedAt: null,
        nowMs: 0,
      }),
    ).toMatchObject({ kind: "failed", label: "Failed" });
  });
});
