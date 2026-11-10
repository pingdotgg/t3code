import { describe, expect, it } from "vite-plus/test";

import { pinOrderKeyBetween, topOfPinnedRunOrderKey } from "./pinOrderKey.ts";

describe("topOfPinnedRunOrderKey", () => {
  it("sorts before the smallest existing key and ignores keyless pins", () => {
    const key = topOfPinnedRunOrderKey(["t", null, "g", undefined, "m"]);
    expect(key).toBe(pinOrderKeyBetween(null, "g"));
    expect(key! < "g").toBe(true);
  });

  it("starts a fresh key when no pin has one", () => {
    expect(topOfPinnedRunOrderKey([])).toBe(pinOrderKeyBetween(null, null));
    expect(topOfPinnedRunOrderKey([null])).toBe(pinOrderKeyBetween(null, null));
  });

  it("returns null when the smallest key is corrupt", () => {
    expect(topOfPinnedRunOrderKey(["ga", "t"])).toBeNull();
  });
});
