import { describe, expect, it } from "vite-plus/test";

import {
  hasUnseenThreadCompletion,
  setThreadUnreadAt,
  setThreadVisitedAt,
} from "./thread-read-state";

describe("thread read state", () => {
  const completedAt = "2026-08-09T10:00:00.000Z";

  it("marks the latest completion unread and then visited", () => {
    const unread = setThreadUnreadAt({}, "environment:thread", completedAt);
    expect(unread["environment:thread"]).toBe("2026-08-09T09:59:59.999Z");
    expect(
      hasUnseenThreadCompletion({ latestTurn: { completedAt } }, unread["environment:thread"]),
    ).toBe(true);

    const visited = setThreadVisitedAt(unread, "environment:thread", completedAt);
    expect(
      hasUnseenThreadCompletion({ latestTurn: { completedAt } }, visited["environment:thread"]),
    ).toBe(false);
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

  it("never moves a visit marker backwards", () => {
    const current = { "environment:thread": completedAt };
    expect(setThreadVisitedAt(current, "environment:thread", "2026-08-09T09:00:00.000Z")).toBe(
      current,
    );
  });
});
