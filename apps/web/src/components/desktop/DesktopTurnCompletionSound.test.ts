import { describe, expect, it } from "vite-plus/test";

import {
  createTurnCompletionTracker,
  type TurnCompletionSnapshot,
} from "./DesktopTurnCompletionSound";

function snapshot(overrides: Partial<TurnCompletionSnapshot> = {}): TurnCompletionSnapshot {
  return {
    threadKey: "environment-1:thread-1",
    turnId: "turn-1",
    state: "running",
    completedAt: null,
    ...overrides,
  };
}

describe("createTurnCompletionTracker", () => {
  it("reports a turn that transitions from running to completed", () => {
    const tracker = createTurnCompletionTracker();

    expect(tracker.sync([snapshot()])).toBe(0);
    expect(
      tracker.sync([snapshot({ state: "completed", completedAt: "2026-08-03T08:00:00.000Z" })]),
    ).toBe(1);
  });

  it("does not report the initial snapshot or repeat a completed turn", () => {
    const tracker = createTurnCompletionTracker();
    const completed = snapshot({
      state: "completed",
      completedAt: "2026-08-03T08:00:00.000Z",
    });

    expect(tracker.sync([completed])).toBe(0);
    expect(tracker.sync([completed])).toBe(0);
  });

  it("does not repeat a completed turn when its completion timestamp changes", () => {
    const tracker = createTurnCompletionTracker();

    expect(tracker.sync([snapshot()])).toBe(0);
    expect(
      tracker.sync([snapshot({ state: "completed", completedAt: "2026-08-03T08:00:00.000Z" })]),
    ).toBe(1);
    expect(
      tracker.sync([snapshot({ state: "completed", completedAt: "2026-08-03T08:00:01.000Z" })]),
    ).toBe(0);
  });

  it("reports a newer completed turn for an already observed thread", () => {
    const tracker = createTurnCompletionTracker();

    expect(
      tracker.sync([snapshot({ state: "completed", completedAt: "2026-08-03T08:00:00.000Z" })]),
    ).toBe(0);
    expect(
      tracker.sync([
        snapshot({
          turnId: "turn-2",
          state: "completed",
          completedAt: "2026-08-03T09:00:00.000Z",
        }),
      ]),
    ).toBe(1);
  });

  it("ignores interrupted and errored turns", () => {
    const tracker = createTurnCompletionTracker();

    expect(tracker.sync([snapshot()])).toBe(0);
    expect(
      tracker.sync([snapshot({ state: "interrupted", completedAt: "2026-08-03T08:00:00.000Z" })]),
    ).toBe(0);
    expect(
      tracker.sync([
        snapshot({
          turnId: "turn-2",
          state: "error",
          completedAt: "2026-08-03T09:00:00.000Z",
        }),
      ]),
    ).toBe(0);
  });

  it("does not report a completed thread that appears after initialization", () => {
    const tracker = createTurnCompletionTracker();

    expect(tracker.sync([snapshot()])).toBe(0);
    expect(
      tracker.sync([
        snapshot(),
        snapshot({
          threadKey: "environment-1:thread-2",
          turnId: "turn-2",
          state: "completed",
          completedAt: "2026-08-03T09:00:00.000Z",
        }),
      ]),
    ).toBe(0);
  });
});
