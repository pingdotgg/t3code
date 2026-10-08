import { describe, expect, it } from "vite-plus/test";
import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";

const lane = { padding: 20, minChatWidth: 640 };
const resolve = (width: number, height: number) =>
  resolveThreadDetailsCardLayout({
    container: { width, height },
    lane,
  });

describe("workspace card", () => {
  it("pins to the top right at a fixed width", () => {
    expect(resolve(1600, 900)).toEqual({
      x: 1308,
      y: 12,
      width: 280,
      height: 876,
    });
    expect(resolve(1344, 900)).toMatchObject({ x: 1052, width: 280 });
  });
  it("hides when a readable chat lane cannot fit beside it", () => {
    expect(resolve(984, 900)).toMatchObject({ x: 692 });
    expect(resolve(983, 900)).toBeNull();
  });
  it("hides when the window cannot hold readable controls", () => {
    expect(resolve(1600, 184)).toMatchObject({ height: 160 });
    expect(resolve(1600, 183)).toBeNull();
  });
});

describe("card content fitting", () => {
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
