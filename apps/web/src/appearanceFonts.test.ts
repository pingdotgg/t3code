import { describe, expect, it } from "vite-plus/test";

import { chatFontScale } from "./appearanceFonts";

describe("chatFontScale", () => {
  it("follows the interface when unset or equal to it", () => {
    expect(chatFontScale(null, 16)).toBeNull();
    expect(chatFontScale(16, 16)).toBeNull();
  });

  it("scales chat text relative to the interface size", () => {
    expect(chatFontScale(20, 16)).toBe(1.25);
    expect(chatFontScale(12, 16)).toBe(0.75);
    expect(chatFontScale(18, 12)).toBe(1.5);
  });

  it("clamps out-of-range sizes before scaling", () => {
    expect(chatFontScale(40, 16)).toBe(20 / 16);
    expect(chatFontScale(20, 40)).toBeNull();
  });
});
