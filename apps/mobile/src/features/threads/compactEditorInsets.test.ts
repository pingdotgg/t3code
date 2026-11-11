import { describe, expect, it } from "vite-plus/test";

import { compactEditorInsets } from "./compactEditorInsets";

describe("compact editor insets", () => {
  it("keeps the measured slot position in left-to-right layouts", () => {
    expect(compactEditorInsets({ slotX: 48, slotWidth: 200, rowWidth: 360, isRTL: false })).toEqual(
      { left: 52, right: 116 },
    );
  });

  it("swaps the insets in right-to-left layouts so the editor stays over its slot", () => {
    expect(compactEditorInsets({ slotX: 112, slotWidth: 200, rowWidth: 360, isRTL: true })).toEqual(
      { left: 52, right: 116 },
    );
  });
});
