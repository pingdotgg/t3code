import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  I18nManager: { isRTL: false },
}));

import { swipeOpenDirection, swipeRevealSign } from "./swipeableDirection";

describe("swipeableDirection", () => {
  it("flips swipe reveal sign and open direction between LTR and RTL", () => {
    expect(swipeRevealSign("ltr")).toBe(-1);
    expect(swipeRevealSign("rtl")).toBe(1);
    expect(swipeOpenDirection("ltr")).toBe("left");
    expect(swipeOpenDirection("rtl")).toBe("right");
  });
});
