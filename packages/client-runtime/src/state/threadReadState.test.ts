import { describe, expect, it } from "vite-plus/test";

import {
  hasUnseenThreadCompletion,
  resolveThreadUnreadAt,
  resolveThreadVisitedAt,
} from "./threadReadState.ts";

describe("thread read state", () => {
  const completedAt = "2026-08-09T10:00:00.000Z";

  it("marks the latest completion unread and then visited", () => {
    const unreadAt = resolveThreadUnreadAt(completedAt);
    expect(unreadAt).toBe("2026-08-09T09:59:59.999Z");
    expect(hasUnseenThreadCompletion({ latestTurn: { completedAt } }, unreadAt)).toBe(true);

    const visitedAt = resolveThreadVisitedAt(unreadAt, completedAt);
    expect(hasUnseenThreadCompletion({ latestTurn: { completedAt } }, visitedAt)).toBe(false);
  });

  it("treats never-visited and malformed completions as read", () => {
    expect(hasUnseenThreadCompletion({ latestTurn: { completedAt } }, undefined)).toBe(false);
    expect(
      hasUnseenThreadCompletion(
        { latestTurn: { completedAt: "not-a-date" } },
        "2026-08-09T09:00:00.000Z",
      ),
    ).toBe(false);
  });

  it("ignores checkpoint timestamps while the latest turn is still running", () => {
    const lastVisitedAt = "2026-08-09T09:00:00.000Z";
    expect(
      hasUnseenThreadCompletion({ latestTurn: { state: "running", completedAt } }, lastVisitedAt),
    ).toBe(false);
    expect(
      hasUnseenThreadCompletion({ latestTurn: { state: "completed", completedAt } }, lastVisitedAt),
    ).toBe(true);
  });

  it("never moves a visit marker backwards", () => {
    expect(resolveThreadVisitedAt(completedAt, "2026-08-09T09:00:00.000Z")).toBe(completedAt);
  });
});
