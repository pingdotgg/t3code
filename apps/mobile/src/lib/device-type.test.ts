import { describe, expect, it } from "vite-plus/test";
import { deriveDeviceType, isDuoDevice } from "./device-type";
import type { NativeLayoutMetrics } from "./reserved-regions";

// Poses reported by the iOS 27.1 iPhone Duo simulator.
const duoOuter: NativeLayoutMetrics = {
  width: 466,
  height: 678,
  hasHinge: true,
  horizontalSizeClass: "compact",
  verticalBarEdge: "right",
  safeArea: { top: 0, bottom: 34, left: 0, right: 84 },
  reservedRegions: [],
};
const duoInnerPortrait: NativeLayoutMetrics = {
  width: 669,
  height: 951,
  hasHinge: true,
  horizontalSizeClass: "regular",
  verticalBarEdge: "none",
  safeArea: { top: 82, bottom: 34, left: 0, right: 0 },
  reservedRegions: [{ kind: "occlusion", x: 535, y: 0, width: 134, height: 82 }],
};
const phone: NativeLayoutMetrics = {
  width: 393,
  height: 852,
  horizontalSizeClass: "compact",
  verticalBarEdge: "none",
  safeArea: { top: 59, bottom: 34, left: 0, right: 0 },
  reservedRegions: [],
};

describe("deriveDeviceType", () => {
  it("follows the Duo between its displays", () => {
    expect(deriveDeviceType({ isPad: false, metrics: duoOuter })).toBe("duo-folded");
    expect(deriveDeviceType({ isPad: false, metrics: duoInnerPortrait })).toBe("duo-unfolded");
    expect(
      deriveDeviceType({
        isPad: false,
        metrics: { ...duoInnerPortrait, width: 951, height: 669, verticalBarEdge: "right" },
      }),
    ).toBe("duo-unfolded");
  });

  it("treats a narrow inner-display window like the folded screen", () => {
    expect(
      deriveDeviceType({
        isPad: false,
        metrics: { ...duoInnerPortrait, width: 320, horizontalSizeClass: "compact" },
      }),
    ).toBe("duo-folded");
  });

  it("keeps ordinary phones and iPads out of the Duo branches", () => {
    expect(deriveDeviceType({ isPad: false, metrics: phone })).toBe("phone");
    expect(deriveDeviceType({ isPad: false, metrics: null })).toBe("phone");
    expect(deriveDeviceType({ isPad: true, metrics: null })).toBe("pad");
    const slideOver = { ...phone, width: 320, height: 1024 };
    expect(deriveDeviceType({ isPad: true, metrics: slideOver })).toBe("pad");
    expect(isDuoDevice(deriveDeviceType({ isPad: true, metrics: slideOver }))).toBe(false);
  });
});
