import { describe, expect, it } from "vitest";

import {
  resolveDesktopChromeSafeAreaStyle,
  resolveDesktopChromeSafeInlineSize,
} from "./desktopChromeLayout";

describe("desktop chrome layout helpers", () => {
  it("computes a safe inline inset from the number of controls", () => {
    expect(resolveDesktopChromeSafeInlineSize(0)).toBe("1rem");
    expect(resolveDesktopChromeSafeInlineSize(2)).toBe("4.5rem");
  });

  it("maps both control banks into root CSS variables", () => {
    expect(
      resolveDesktopChromeSafeAreaStyle({
        leftControlCount: 1,
        rightControlCount: 3,
      }),
    ).toEqual({
      "--desktop-chrome-safe-inline-start": "2.75rem",
      "--desktop-chrome-safe-inline-end": "6.25rem",
    });
  });
});
