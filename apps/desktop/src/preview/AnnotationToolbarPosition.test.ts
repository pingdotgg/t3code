import { describe, expect, it } from "vite-plus/test";
import { clampToolbarPosition } from "./AnnotationToolbarPosition.ts";

describe("clampToolbarPosition", () => {
  it("keeps a dragged toolbar in the viewport, including after a resize", () => {
    const toolbar = { width: 200, height: 40 };
    expect(
      clampToolbarPosition({ left: -10, top: 900 }, { width: 800, height: 600 }, toolbar),
    ).toEqual({ left: 0, top: 560 });
    expect(
      clampToolbarPosition({ left: 600, top: 560 }, { width: 400, height: 300 }, toolbar),
    ).toEqual({ left: 200, top: 260 });
    expect(
      clampToolbarPosition({ left: 20, top: 20 }, { width: 100, height: 20 }, toolbar),
    ).toEqual({ left: 0, top: 0 });
  });
});
