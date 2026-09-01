import { describe, expect, it } from "vite-plus/test";

import { resolveBoardCardVisitedAt } from "./BoardSessionCard";

describe("resolveBoardCardVisitedAt", () => {
  it("acknowledges a timer wake at its wake timestamp", () => {
    const wakeAt = "2026-09-01T12:00:00.000Z";

    expect(
      resolveBoardCardVisitedAt(
        {
          snoozedUntil: wakeAt,
          snoozedAt: "2026-09-01T11:00:00.000Z",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          session: null,
          latestTurn: null,
        },
        "2026-09-01T12:01:00.000Z",
      ),
    ).toBe(wakeAt);
  });
});
