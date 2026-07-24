import { describe, expect, it } from "vite-plus/test";

import {
  clampPreviewMiniPlayerPosition,
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
