import { describe, expect, it } from "vite-plus/test";

import { hostFreezeNotice } from "./hostFreeze.ts";

const stall = {
  detectedAt: "2026-11-04T10:48:44.912Z",
  durationMs: 6_386,
  cpuCount: 56,
};

describe("hostFreezeNotice", () => {
  it("blames the CPU when load exceeds the cores and they are busy", () => {
    expect(
      hostFreezeNotice("wanqing", { ...stall, loadAverage: 61, cpuBusy: 0.97 })?.description,
    ).toBe("Its CPU is overloaded (load 61 on 56 cores, 97% busy).");
  });

  it("does not blame the CPU when load is high but the cores are idle", () => {
    expect(
      hostFreezeNotice("wanqing", { ...stall, loadAverage: 61, cpuBusy: 0.07 })?.description,
    ).toBe(
      "Its processes are waiting on disk or other I/O (load 61 on 56 cores, CPU only 7% busy).",
    );
  });

  it("reports load without a cause when an older host omits CPU busy time", () => {
    expect(hostFreezeNotice("wanqing", { ...stall, loadAverage: 61 })?.description).toBe(
      "The host is overloaded (load 61 on 56 cores).",
    );
  });

  it("says T3 Code was busy when load is within the cores", () => {
    expect(
      hostFreezeNotice("wanqing", { ...stall, loadAverage: 12, cpuBusy: 0.2 })?.description,
    ).toBe("T3 Code on wanqing was too busy to answer.");
  });
});
