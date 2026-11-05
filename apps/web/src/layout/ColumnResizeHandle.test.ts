import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("../motion/stripCamera"), () => ({ settleStripCamera: () => {} }));

import { stepPreset } from "./ColumnResizeHandle";

describe("stepPreset", () => {
  it("steps to the next preset that visibly changes the size, within the bounds", () => {
    const narrow = { min: 420 / 1170, max: 1 };
    expect(stepPreset(0.6694, -1, narrow, 1170)).toBe(1 / 2);
    expect(stepPreset(1 / 2, -1, narrow, 1170)).toBe(420 / 1170);
    expect(stepPreset(420 / 1170, -1, narrow, 1170)).toBe(420 / 1170);
    expect(stepPreset(0.6694, 1, narrow, 1170)).toBe(1);
    expect(stepPreset(1 / 2, -1, { min: 420 / 1440, max: 1 }, 1440)).toBe(1 / 3);
  });
});
