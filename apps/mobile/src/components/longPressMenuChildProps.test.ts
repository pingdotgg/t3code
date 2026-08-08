import { describe, expect, it } from "vite-plus/test";

import { IOS_MENU_LONG_PRESS_DELAY_MS, longPressMenuChildProps } from "./longPressMenuChildProps";

describe("longPressMenuChildProps", () => {
  it("gives the child an onLongPress so its tap is cancelled by the long press", () => {
    expect(typeof longPressMenuChildProps.onLongPress).toBe("function");
    expect(() => longPressMenuChildProps.onLongPress()).not.toThrow();
  });

  it("fires the injected long press before UIKit commits the context menu", () => {
    // 500ms is UIKit's context-menu threshold and React Native's default
    // long-press total, so this has to be shorter or the tap is still live
    // when the menu appears.
    expect(IOS_MENU_LONG_PRESS_DELAY_MS).toBeLessThan(500);
  });
});
