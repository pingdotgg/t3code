import { describe, expect, it } from "vite-plus/test";

import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_MIN_SIZE,
} from "./previewMiniPlayerLayout";

describe("previewMiniPlayerLayout", () => {
  it("bounds size and placement to the current panel", () => {
    expect(
      clampPreviewMiniPlayerSize({ width: 20, height: 20 }, { width: 800, height: 600 }),
    ).toEqual(PREVIEW_MINI_PLAYER_MIN_SIZE);
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 1_000, y: -20 },
        { width: 500, height: 400 },
        { width: 320, height: 200 },
      ),
    ).toEqual({ x: 168, y: 12 });
  });

  it("keeps the player above a reserved bottom inset", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 20, y: 1_000 },
        { width: 800, height: 600 },
        { width: 320, height: 200 },
        120,
      ),
    ).toEqual({ x: 20, y: 268 });
  });
});
