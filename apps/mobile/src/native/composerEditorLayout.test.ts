import { describe, expect, it } from "vite-plus/test";

import { composerEditorLaidOutHeight, verticalPaddingFromViewStyle } from "./composerEditorLayout";

describe("composer editor auto-height", () => {
  it("uses a collapsed fixed height instead of growing with content", () => {
    expect(
      composerEditorLaidOutHeight({
        contentHeight: 240,
        height: 36,
        minHeight: 72,
        maxHeight: 160,
        verticalPadding: 0,
      }),
    ).toBe(36);
  });

  it("grows from the minimum until the content fills the expanded frame", () => {
    expect(
      composerEditorLaidOutHeight({
        contentHeight: 20,
        minHeight: 72,
        maxHeight: 160,
        verticalPadding: 8,
      }),
    ).toBe(72);
    expect(
      composerEditorLaidOutHeight({
        contentHeight: 100,
        minHeight: 72,
        maxHeight: 160,
        verticalPadding: 8,
      }),
    ).toBe(108);
  });

  it("does not add Yoga padding when the native view fills the bounds", () => {
    expect(
      composerEditorLaidOutHeight({
        contentHeight: 100,
        minHeight: 72,
        maxHeight: 160,
        verticalPadding: 0,
      }),
    ).toBe(100);
  });

  it("stops at maxHeight so a long prompt scrolls inside the editor", () => {
    expect(
      composerEditorLaidOutHeight({
        contentHeight: 400,
        minHeight: 72,
        maxHeight: 160,
        verticalPadding: 8,
      }),
    ).toBe(160);
  });

  it("counts vertical padding once from paddingVertical", () => {
    expect(verticalPaddingFromViewStyle({ paddingVertical: 4 })).toBe(8);
    expect(verticalPaddingFromViewStyle({ paddingTop: 4, paddingBottom: 6 })).toBe(10);
    expect(verticalPaddingFromViewStyle({ padding: 3 })).toBe(6);
  });
});
