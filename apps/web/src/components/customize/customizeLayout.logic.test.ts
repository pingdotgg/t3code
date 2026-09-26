import { describe, expect, it } from "vite-plus/test";

import {
  type PaletteLayoutInput,
  resolvePaletteLayout,
  shouldUseCompactPaletteLayout,
} from "./customizeLayout.logic";

const rect = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

const base: PaletteLayoutInput = {
  viewport: { width: 1600, height: 1000 },
  sidebar: rect(0, 0, 300, 1000),
  header: rect(300, 0, 1600, 52),
  composer: rect(600, 820, 1300, 960),
  sizes: {
    threadList: { width: 288, height: 400 },
    chatHeader: { width: 288, height: 180 },
    appearance: { width: 304, height: 500 },
    composer: { width: 340, height: 260 },
  },
  dock: { width: 344, height: 56 },
};

describe("resolvePaletteLayout", () => {
  it("places each palette beside the surface it edits", () => {
    const layout = resolvePaletteLayout(base);
    expect(layout.threadList).toEqual({ x: 312, y: 64 });
    expect(layout.chatHeader).toEqual({ x: 1300, y: 64 });
    expect(layout.appearance).toEqual({ x: 1284, y: 256 });
    // Centered over the composer and resting just above it.
    expect(layout.composer).toEqual({ x: 780, y: 548 });
  });

  it("slides the thread list palette to the edge when the sidebar is closed", () => {
    const layout = resolvePaletteLayout({ ...base, sidebar: rect(-300, 0, 0, 1000) });
    expect(layout.threadList.x).toBe(12);
  });

  it("keeps the composer palette between the side palettes on a full-width chat", () => {
    const layout = resolvePaletteLayout({ ...base, composer: rect(300, 820, 1600, 960) });
    const threadListRight = layout.threadList.x + base.sizes.threadList.width;
    expect(layout.composer.x).toBeGreaterThanOrEqual(threadListRight + 12);
    expect(layout.composer.x + base.sizes.composer.width).toBeLessThanOrEqual(
      layout.appearance.x - 12,
    );
  });

  it("stays on screen when a surface is missing", () => {
    const layout = resolvePaletteLayout({ ...base, header: null, composer: null });
    for (const [id, point] of Object.entries(layout)) {
      const size = base.sizes[id as keyof typeof base.sizes];
      expect(point.x).toBeGreaterThanOrEqual(12);
      expect(point.y).toBeGreaterThanOrEqual(12);
      expect(point.x + size.width).toBeLessThanOrEqual(base.viewport.width - 12);
      expect(point.y + Math.min(size.height, 200)).toBeLessThanOrEqual(base.viewport.height - 12);
    }
  });

  it("keeps a tall appearance palette below the header palette instead of over it", () => {
    const sizes = { ...base.sizes, appearance: { width: 304, height: 900 } };
    const layout = resolvePaletteLayout({ ...base, sizes });
    expect(layout.appearance.y).toBe(layout.chatHeader.y + sizes.chatHeader.height + 12);
  });

  it("never lifts a palette over the chat header", () => {
    const composer = rect(600, 200, 1300, 340);
    const layout = resolvePaletteLayout({ ...base, composer });
    expect(layout.composer.y).toBeGreaterThanOrEqual(52 + 12);
  });

  it("opens the composer palette below a composer centred in an empty thread", () => {
    // 174px above the composer can't hold the 260px palette; below can.
    const composer = rect(600, 250, 1300, 390);
    const layout = resolvePaletteLayout({ ...base, composer });
    expect(layout.composer.y).toBe(390 + 12);
  });
});

describe("shouldUseCompactPaletteLayout", () => {
  const sidebar = rect(0, 0, 300, 768);

  it("floats palettes when three columns fit beside the sidebar", () => {
    expect(
      shouldUseCompactPaletteLayout({
        viewportWidth: 1512,
        sidebar,
        header: null,
        paletteWidth: 288,
      }),
    ).toBe(false);
  });

  it("uses the sheet when the composer palette would cover the side palettes", () => {
    expect(
      shouldUseCompactPaletteLayout({
        viewportWidth: 1024,
        sidebar,
        header: null,
        paletteWidth: 288,
      }),
    ).toBe(true);
  });

  it("gives the palettes the sidebar's width once it closes", () => {
    expect(
      shouldUseCompactPaletteLayout({
        viewportWidth: 1024,
        sidebar: rect(-300, 0, 0, 768),
        header: null,
        paletteWidth: 288,
      }),
    ).toBe(false);
  });

  it("uses the sheet when a right-hand panel narrows the chat column", () => {
    expect(
      shouldUseCompactPaletteLayout({
        viewportWidth: 1512,
        sidebar: rect(0, 0, 300, 900),
        header: rect(300, 0, 1012, 52),
        paletteWidth: 288,
      }),
    ).toBe(true);
  });
});
