import { describe, expect, it } from "vite-plus/test";

import { hexToHsv, hsvToHex } from "./color";

describe("picker color conversion", () => {
  it.each(["#000000", "#ffffff", "#808080", "#ff0000", "#00ff00", "#0000ff", "#2563eb"])(
    "round trips %s through HSV without changing the persisted color",
    (hex) => {
      const { h, s, v } = hexToHsv(hex);
      expect(hsvToHex(h, s, v)).toBe(hex);
    },
  );

  it("represents black and greys without undefined saturation", () => {
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv("#ffffff")).toEqual({ h: 0, s: 0, v: 1 });
  });
});
