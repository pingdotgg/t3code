import { describe, expect, it } from "vite-plus/test";

import { curveYAt } from "./UsageStackedChart";
import { smoothCurve } from "./UsageProviderChart";

describe("curveYAt", () => {
  it("follows the drawn curve between interval centres, not the raw step", () => {
    const curve = smoothCurve([
      { x: 0, y: 100 },
      { x: 10, y: 100 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ]);
    expect(curveYAt(curve, 10)).toBeCloseTo(100);
    expect(curveYAt(curve, 20)).toBeCloseTo(0);
    // Halfway between a high and a low point the band edge is in between.
    const middle = curveYAt(curve, 15)!;
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(100);
    expect(curveYAt(curve, 31)).toBeNull();
  });
});
