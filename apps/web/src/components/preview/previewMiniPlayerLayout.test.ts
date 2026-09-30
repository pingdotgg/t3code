import { describe, expect, it } from "vite-plus/test";

import {
  clampPreviewMiniPlayerPosition,
  resolvePreviewMiniPlayerFrame,
} from "./previewMiniPlayerLayout";

describe("previewMiniPlayerLayout", () => {
  it("bounds placement and preserves source aspect ratio", () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: 20,
        position: null,
        source: { width: 393, height: 852 },
        container: { width: 800, height: 600 },
      }),
    ).toMatchObject({ width: 240, height: 520 });
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
