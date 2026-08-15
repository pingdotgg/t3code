import { describe, expect, it } from "vite-plus/test";

import { boardCardVisitTimestamp, shouldShowBoardStatusIcon } from "./BoardSessionCard.logic.ts";

describe("board card focus", () => {
  it("acknowledges the completed turn currently on screen", () => {
    expect(
      boardCardVisitTimestamp({
        latestTurn: {
          completedAt: "2026-08-15T05:00:00.000Z",
        },
      }),
    ).toBe("2026-08-15T05:00:00.000Z");
    expect(boardCardVisitTimestamp({ latestTurn: null })).toBeNull();
  });
});

describe("board card status glyph", () => {
  it("matches the sidebar by omitting seen idle while retaining Done", () => {
    expect(shouldShowBoardStatusIcon("idle")).toBe(false);
    expect(shouldShowBoardStatusIcon("done")).toBe(true);
    expect(shouldShowBoardStatusIcon("working")).toBe(true);
  });
});
