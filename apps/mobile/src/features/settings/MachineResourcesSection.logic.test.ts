import { describe, expect, it } from "vite-plus/test";

import { machineGpuDetail, machineMemoryDetail } from "./MachineResourcesSection.logic";

const GiB = 1024 ** 3;

describe("machineMemoryDetail", () => {
  it("shows swap only when the machine has some", () => {
    expect(machineMemoryDetail({ availableMemoryBytes: 4 * GiB })).toBe("4.0 GB available");
    expect(
      machineMemoryDetail({
        availableMemoryBytes: 4 * GiB,
        swap: { totalBytes: 0, usedBytes: 0 },
      }),
    ).toBe("4.0 GB available");
    expect(
      machineMemoryDetail({
        availableMemoryBytes: 4 * GiB,
        swap: { totalBytes: 2 * GiB, usedBytes: GiB },
      }),
    ).toBe("4.0 GB available · swap 1.0 GB / 2.0 GB");
  });
});

describe("machineGpuDetail", () => {
  it("omits memory for unified-memory GPUs", () => {
    expect(machineGpuDetail({ name: "Apple M3 Max", utilization: 0.2 })).toBeNull();
    expect(machineGpuDetail({ name: "Apple M3 Max", memoryUsedBytes: 2 * GiB })).toBe(
      "Unified memory · 2.0 GB in use",
    );
    expect(machineGpuDetail({ name: "RTX", memoryTotalBytes: 8 * GiB })).toBe("8.0 GB memory");
    expect(
      machineGpuDetail({ name: "RTX", memoryTotalBytes: 8 * GiB, memoryUsedBytes: 2 * GiB }),
    ).toBe("2.0 GB / 8.0 GB memory");
  });
});
