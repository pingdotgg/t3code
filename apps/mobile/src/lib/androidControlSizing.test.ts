import { describe, expect, it } from "vite-plus/test";

import { resolveAndroidControlSizing } from "./androidControlSizing";

describe("Android control sizing", () => {
  it.each([
    [11, 17, 48, 48, 172, 48],
    [16, 24, 48, 56, 250, 48],
    [22, 33, 66, 77, 344, 66],
  ])(
    "scales controls at %ipt",
    (fontSize, iconSize, buttonSize, fabSize, menuWidth, menuItemHeight) => {
      expect(resolveAndroidControlSizing(fontSize)).toMatchObject({
        iconSize,
        buttonSize,
        fabSize,
        menuWidth,
        menuItemHeight,
      });
    },
  );
});
