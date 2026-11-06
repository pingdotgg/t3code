import { describe, expect, it } from "vite-plus/test";
import { resolveDeviceShape } from "./shapeProfile.ts";

const shape = (platform: "ios" | "android", name: string, portraitAspect = 0.46) =>
  resolveDeviceShape({ platform, name, portraitAspect }).id;

describe("resolveDeviceShape", () => {
  it.each([
    "samsung SM-R950",
    "SM-R960",
    "SM-R870",
    "SM-L705U",
    "Galaxy Watch6 Classic",
    "Galaxy_Watch6_Classic",
    "Pixel Watch 3",
    "Wear OS Large Round",
    "Wear_OS_Large_Round",
  ])("draws %s as a round watch", (name) => {
    expect(shape("android", name, 1)).toBe("round-watch");
  });

  it("draws Apple Watch and rectangular Wear OS devices as rounded rectangles", () => {
    expect(shape("ios", "Apple Watch Series 10 (46mm)", 0.84)).toBe("square-watch");
    expect(shape("ios", "Apple Watch Ultra 2 (49mm)", 0.82)).toBe("square-watch");
    expect(shape("android", "Wear OS Square", 1)).toBe("square-watch");
    expect(shape("android", "Wear_OS_Square", 1)).toBe("square-watch");
  });

  it("keeps Galaxy Buds, phones, tablets, and square foldables out of the watch shapes", () => {
    expect(shape("android", "samsung SM-R170")).toBe("android-phone");
    expect(shape("android", "samsung SM-R510")).toBe("android-phone");
    expect(shape("android", "samsung SM-S928B")).toBe("android-phone");
    expect(shape("android", "samsung SM-X910", 0.63)).toBe("android-tablet");
    expect(shape("android", "Pixel 9 Pro Fold", 0.94)).toBe("android-tablet");
    expect(shape("android", "", 1)).toBe("android-tablet");
    expect(shape("ios", "iPhone 18 Pro")).toBe("ios-phone");
  });
});
