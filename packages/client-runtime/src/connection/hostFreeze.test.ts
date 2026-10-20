import { describe, expect, it } from "vite-plus/test";

import { hostFreezeNotice } from "./hostFreeze.ts";

const stall = {
  detectedAt: "2026-10-20T07:50:37.633Z",
  durationMs: 12_422,
  loadAverage: 219.4,
  cpuCount: 18,
};

describe("hostFreezeNotice", () => {
  it("blames an overloaded CPU when the load is above the core count", () => {
    expect(hostFreezeNotice("leftbook", stall)).toEqual({
      title: "leftbook froze for 12s",
      description: "Its CPU is overloaded (load 219 on 18 cores).",
    });
  });

  it("blames T3 Code when the CPU had room, or the host reports no load", () => {
    const busy = "T3 Code on leftbook was too busy to answer.";
    expect(hostFreezeNotice("leftbook", { ...stall, loadAverage: 4 })?.description).toBe(busy);
    const { loadAverage: _load, ...windows } = stall;
    expect(hostFreezeNotice("leftbook", windows)?.description).toBe(busy);
  });
});
