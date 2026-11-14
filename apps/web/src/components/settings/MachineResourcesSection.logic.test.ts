import { describe, expect, it } from "vite-plus/test";

import { machineCpuDetail, machineStorageState } from "./MachineResourcesSection.logic";

describe("machineCpuDetail", () => {
  it("omits what a server did not report", () => {
    expect(machineCpuDetail({ cpuCount: 1 })).toBe("1 core");
    expect(
      machineCpuDetail({
        cpuCount: 16,
        cpuModel: "Apple M3 Max",
        loadAverage: { one: 1.5, five: 2, fifteen: 0.25 },
      }),
    ).toBe("Apple M3 Max · 16 cores · load 1.50 2.00 0.25");
  });
});

describe("machineStorageState", () => {
  it("treats a server without storage as unsupported, not empty", () => {
    expect(machineStorageState({})).toEqual({ kind: "unsupported" });
    expect(machineStorageState({ storage: { sampledAt: 1, volumes: [] } })).toEqual({
      kind: "empty",
      volumes: [],
      notice: null,
    });
  });

  it("carries the fallback notice alongside the volumes it could read", () => {
    const volume = {
      mountPoint: "/",
      name: "",
      fileSystem: "",
      totalBytes: 10,
      availableBytes: 5,
      roles: ["t3Home" as const],
    };
    expect(
      machineStorageState({
        storage: {
          sampledAt: 1,
          volumes: [volume],
          unavailableReason: "Only T3 volumes are shown.",
        },
      }),
    ).toEqual({ kind: "volumes", volumes: [volume], notice: "Only T3 volumes are shown." });
  });
});
