import { describe, expect, it } from "vite-plus/test";
import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";

const resolve = (width: number, height: number, previewY: number | null = null) =>
  resolveThreadDetailsCardLayout({
    container: { width, height },
    chat: { left: (width - 736) / 2, width: 736 },
    frame: previewY === null ? null : { x: width - 332, y: previewY, width: 320, height: 240 },
  });

describe("floating details card", () => {
  it("uses the right margin without reserving chat space", () => {
    expect(resolve(1600, 900)).toEqual({
      x: 1276,
      y: 12,
      width: 312,
      height: 876,
    });
    expect(resolve(1344, 900)?.width).toBe(280);
  });
  it("hides when the margin cannot hold readable controls", () => {
    expect(resolve(1200, 900)).toBeNull();
  });
  it("keeps the card at the top right while the preview is freely dragged vertically", () => {
    for (const y of [12, 170, 250, 400, 648]) {
      expect(resolve(1600, 900, y)).toEqual({ x: 1276, y: 12, width: 312, height: 876 });
    }
  });
  it("keeps width and height independent", () => {
    expect(resolve(1344, 900, 600)).toMatchObject({ width: 280, height: 876 });
    expect(
      resolveThreadDetailsCardLayout({
        container: { width: 1600, height: 900 },
        chat: { left: 432, width: 736 },
        frame: { x: 12, y: 100, width: 320, height: 240 },
      })?.height,
    ).toBe(876);
  });
});

describe("card content fitting", () => {
  const place = (previewY: number, previewHeight = 365, overlapsDetailsCard = false) =>
    resolveThreadDetailsCardLayout({
      container: { width: 1584, height: 988 },
      chat: { left: 424, width: 736 },
      frame: { x: 1260, y: previewY, width: 240, height: previewHeight },
      overlapsDetailsCard,
    });
  it("does not fold in response to a drag while the full card can be kept clear", () => {
    for (const y of [12, 170, 225, 240, 340, 380, 611]) {
      const placement = place(y)!;
      expect(placement).toMatchObject({ x: 1260, y: 12, height: 964 });
      expect(resolveThreadDetailsCardDensity(placement.height, { full: 327, compact: 182 })).toBe(
        "full",
      );
    }
  });
  it("folds only after the preview cannot fit around the full card", () => {
    const content = { full: 327, compact: 182 };
    expect(resolveThreadDetailsCardDensity(place(351, 625, true)!.height, content)).toBe("full");
    expect(resolveThreadDetailsCardDensity(place(350, 626, true)!.height, content)).toBe("compact");
    expect(resolveThreadDetailsCardDensity(place(12)!.height, content)).toBe("full");
  });
  it("hides only when the available height cannot hold readable controls", () => {
    expect(place(184, 792, true)).toMatchObject({ y: 12, height: 160 });
    expect(place(183, 793, true)).toBeNull();
  });
  it("keeps all content as a freely moved preview approaches without colliding", () => {
    const content = { full: 162, compact: 126 };
    for (const y of [650, 450, 350, 250]) {
      expect(resolveThreadDetailsCardDensity(resolve(1600, 900, y)!.height, content)).toBe("full");
    }
  });
  it("folds only detail that cannot fit and restores it when space returns", () => {
    const content = { full: 570, compact: 180 };
    expect(resolveThreadDetailsCardDensity(600, content)).toBe("full");
    expect(resolveThreadDetailsCardDensity(400, content)).toBe("compact");
    expect(resolveThreadDetailsCardDensity(170, content)).toBe("essential");
    expect(resolveThreadDetailsCardDensity(570, content)).toBe("full");
  });
  it("measures unseen content before deciding to fold it", () => {
    expect(resolveThreadDetailsCardDensity(300, { full: 0, compact: 0 })).toBe("full");
    expect(resolveThreadDetailsCardDensity(300, { full: 570, compact: 0 })).toBe("compact");
  });
});
