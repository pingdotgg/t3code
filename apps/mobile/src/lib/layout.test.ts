import { describe, expect, it } from "vite-plus/test";

import { deriveLayout, SPLIT_LAYOUT_MIN_HEIGHT, SPLIT_LAYOUT_MIN_WIDTH } from "./layout";

describe("deriveLayout", () => {
  it.each([
    { name: "small iPhone portrait", width: 375, height: 667 },
    { name: "large iPhone portrait", width: 430, height: 932 },
    { name: "small iPhone landscape", width: 667, height: 375 },
    { name: "large iPhone landscape", width: 932, height: 430 },
    { name: "short wide window", width: 1_024, height: 599 },
    { name: "narrow tall window", width: 719, height: 1_024 },
  ])("keeps a $name in the compact shell", ({ width, height }) => {
    expect(deriveLayout({ width, height })).toEqual({
      variant: "compact",
      usesSplitView: false,
      listPaneWidth: null,
      shellPadding: 0,
    });
  });

  it.each([
    { name: "small tablet portrait", width: 744, height: 1_133 },
    { name: "tablet landscape", width: 1_024, height: 768 },
    { name: "large resizable window", width: 1_366, height: 1_024 },
    { name: "foldable-sized window", width: 800, height: 700 },
  ])("uses the split shell for a $name", ({ width, height }) => {
    expect(deriveLayout({ width, height })).toMatchObject({
      variant: "split",
      usesSplitView: true,
    });
  });

  it("switches only after both space requirements are met", () => {
    expect(
      deriveLayout({ width: SPLIT_LAYOUT_MIN_WIDTH, height: SPLIT_LAYOUT_MIN_HEIGHT }).variant,
    ).toBe("split");
    expect(
      deriveLayout({ width: SPLIT_LAYOUT_MIN_WIDTH - 1, height: SPLIT_LAYOUT_MIN_HEIGHT }).variant,
    ).toBe("compact");
    expect(
      deriveLayout({ width: SPLIT_LAYOUT_MIN_WIDTH, height: SPLIT_LAYOUT_MIN_HEIGHT - 1 }).variant,
    ).toBe("compact");
  });

  it("keeps the sidebar within usable native-column bounds", () => {
    expect(deriveLayout({ width: 720, height: 1_000 }).listPaneWidth).toBe(280);
    expect(deriveLayout({ width: 1_024, height: 768 }).listPaneWidth).toBe(328);
    expect(deriveLayout({ width: 1_600, height: 1_000 }).listPaneWidth).toBe(380);
  });
});
