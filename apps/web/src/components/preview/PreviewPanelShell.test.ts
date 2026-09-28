import { describe, expect, it } from "vite-plus/test";

import { getPreviewPanelMaxWidth } from "./PreviewPanelShell";

describe("getPreviewPanelMaxWidth", () => {
  it("reserves the sibling column minimum beside an open app sidebar", () => {
    // Fullscreen 14" MacBook: viewport 1512, sidebar ~256 → row of 1256.
    expect(getPreviewPanelMaxWidth(1_256)).toBe(896);
  });

  it("reserves the same sibling minimum when the app sidebar is closed", () => {
    // The row is the whole 1800px viewport; the chat still keeps only 360px,
    // not 30% of the viewport.
    expect(getPreviewPanelMaxWidth(1_800)).toBe(1_440);
  });

  it("has no pixel ceiling on ultra-wide rows", () => {
    expect(getPreviewPanelMaxWidth(6_000)).toBe(5_640);
  });

  it("rounds fractional row widths down", () => {
    expect(getPreviewPanelMaxWidth(1_256.6)).toBe(896);
  });

  it("never drops below the panel minimum when the row cannot fit both columns", () => {
    // ~1000px window with an expanded sidebar → row of 700. The sibling
    // reservation (700 − 360 = 340) would undercut the panel's own 360
    // minimum and invert the resize clamp, so the floor wins.
    expect(getPreviewPanelMaxWidth(700)).toBe(360);
  });

  it("stays at the panel minimum even when the row is narrower than the reservation", () => {
    expect(getPreviewPanelMaxWidth(300)).toBe(360);
  });
});
