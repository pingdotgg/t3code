import { describe, expect, it } from "vite-plus/test";

import { machineVolumeTone, machineVolumeUsedShare } from "./machineResources.ts";

const GiB = 1024 ** 3;

describe("machineVolumeTone", () => {
  it.each([
    // 96% used, yet 160 GiB free is plenty.
    { totalBytes: 4_000 * GiB, availableBytes: 160 * GiB, tone: "default" },
    { totalBytes: 4_000 * GiB, availableBytes: 15 * GiB, tone: "warning" },
    { totalBytes: 4_000 * GiB, availableBytes: 4 * GiB, tone: "danger" },
    // A 16 GiB volume scales the floors down to its size.
    { totalBytes: 16 * GiB, availableBytes: 4 * GiB, tone: "default" },
    { totalBytes: 16 * GiB, availableBytes: 2 * GiB, tone: "warning" },
    { totalBytes: 16 * GiB, availableBytes: GiB / 2, tone: "danger" },
    { totalBytes: 0, availableBytes: 0, tone: "default" },
  ] as const)("$availableBytes of $totalBytes is $tone", ({ totalBytes, availableBytes, tone }) => {
    expect(machineVolumeTone({ totalBytes, availableBytes })).toBe(tone);
  });
});

describe("machineVolumeUsedShare", () => {
  it("counts root-reserved blocks as used", () => {
    // ext4 reports 5% reserved: 100 total, 0 available to the user.
    expect(machineVolumeUsedShare({ totalBytes: 100, availableBytes: 0 })).toBe(1);
    expect(machineVolumeUsedShare({ totalBytes: 100, availableBytes: 120 })).toBe(0);
  });
});
