import { describe, expect, it } from "vite-plus/test";

import { isDesktopClientFocused } from "./desktopFocus";

describe("isDesktopClientFocused", () => {
  it("requires the T3 Code document to be both visible and focused", () => {
    expect(isDesktopClientFocused({ visibilityState: "visible", hasFocus: true })).toBe(true);
    expect(isDesktopClientFocused({ visibilityState: "visible", hasFocus: false })).toBe(false);
    expect(isDesktopClientFocused({ visibilityState: "hidden", hasFocus: true })).toBe(false);
    expect(isDesktopClientFocused({ visibilityState: "hidden", hasFocus: false })).toBe(false);
  });
});
