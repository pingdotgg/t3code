import { describe, expect, it } from "vite-plus/test";

import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
} from "./previewMiniPlayerLayout";

describe("clampPreviewMiniPlayerPosition", () => {
  it("keeps a dragged player within the chat viewport", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 900, y: -40 },
        { width: 1_000, height: 700 },
        { width: 360, height: 240 },
      ),
    ).toEqual({
      x: 628,
      y: PREVIEW_MINI_PLAYER_EDGE_GAP,
    });
  });

  it("keeps an edge gap when the player is larger than its container", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 20, y: 30 },
        { width: 200, height: 160 },
        { width: 360, height: 240 },
      ),
    ).toEqual({
      x: PREVIEW_MINI_PLAYER_EDGE_GAP,
      y: PREVIEW_MINI_PLAYER_EDGE_GAP,
    });
  });

  it("keeps the player above a growing composer inset", () => {
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 500, y: 448 },
        { width: 1_000, height: 700 },
        { width: 360, height: 240 },
        160,
      ),
    ).toEqual({
      x: 500,
      y: 288,
    });
  });
});

describe("clampPreviewMiniPlayerSize", () => {
  it("allows resizing within the available chat viewport", () => {
    expect(
      clampPreviewMiniPlayerSize({ width: 520, height: 360 }, { width: 1_000, height: 700 }, 120),
    ).toEqual({ width: 520, height: 360 });
  });

  it("bounds oversized players above the composer", () => {
    expect(
      clampPreviewMiniPlayerSize(
        { width: 2_000, height: 2_000 },
        { width: 1_000, height: 700 },
        120,
      ),
    ).toEqual({ width: 976, height: 556 });
  });
});
