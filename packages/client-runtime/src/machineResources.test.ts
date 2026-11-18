import { describe, expect, it } from "vite-plus/test";

import {
  machineCpuDetail,
  machineDiskSpaceWarnings,
  machineGpuMemory,
  machineGpuState,
  machineStorageState,
  machineSummaryParts,
  machineVolumeTone,
  machineVolumeUsedShare,
} from "./machineResources.ts";

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

describe("machineDiskSpaceWarnings", () => {
  it("lists critical volumes first and nothing when the server reports ok or nothing", () => {
    expect(machineDiskSpaceWarnings("nuc", undefined)).toEqual([]);
    expect(machineDiskSpaceWarnings("nuc", { level: "ok", volumes: [] })).toEqual([]);
    expect(
      machineDiskSpaceWarnings("nuc", {
        level: "critical",
        volumes: [
          {
            path: "/w",
            roles: ["worktrees"],
            level: "low",
            availableBytes: 12.4 * GiB,
            totalBytes: 500 * GiB,
          },
          {
            path: "/h",
            roles: ["t3Home"],
            level: "critical",
            availableBytes: 3.21 * GiB,
            totalBytes: 500 * GiB,
          },
        ],
      }),
    ).toEqual([
      { tone: "danger", text: "nuc: 3.2 GB free on the T3 data volume" },
      { tone: "warning", text: "nuc: 12 GB free on the worktrees volume" },
    ]);
  });
});

describe("machineSummaryParts", () => {
  it("leaves out what the server did not report instead of showing zeros", () => {
    expect(
      machineSummaryParts({ cpuUtilization: null, availableMemoryBytes: 0, totalMemoryBytes: 0 }),
    ).toBeNull();
    expect(
      machineSummaryParts({
        cpuUtilization: 0.236,
        availableMemoryBytes: 8 * GiB,
        totalMemoryBytes: 32 * GiB,
        storage: {
          sampledAt: 0,
          volumes: [
            {
              mountPoint: "/",
              name: "",
              fileSystem: "",
              totalBytes: 4_000 * GiB,
              availableBytes: 15 * GiB,
              roles: ["t3Home"],
            },
          ],
        },
      }),
    ).toEqual([
      { text: "CPU 24%", tone: "default" },
      { text: "RAM 24 GB / 32 GB", tone: "default" },
      { text: "15 GB free", tone: "warning" },
    ]);
  });
});

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

describe("machineGpuState", () => {
  it("treats a server without gpu as unsupported and keeps the reason for an empty list", () => {
    expect(machineGpuState({})).toEqual({ kind: "unsupported" });
    expect(machineGpuState({ gpu: { gpus: [], unavailableReason: "No GPU found" } })).toEqual({
      kind: "empty",
      gpus: [],
      notice: "No GPU found",
    });
  });
});

describe("machineGpuMemory", () => {
  it("tells dedicated VRAM from unified memory and from nothing reported", () => {
    expect(machineGpuMemory({ name: "RTX", memoryTotalBytes: 8, memoryUsedBytes: 2 })).toEqual({
      kind: "dedicated",
      totalBytes: 8,
      usedBytes: 2,
      share: 0.25,
    });
    expect(machineGpuMemory({ name: "RTX", memoryTotalBytes: 8 })).toEqual({
      kind: "dedicated",
      totalBytes: 8,
      usedBytes: undefined,
      share: undefined,
    });
    expect(machineGpuMemory({ name: "M3", memoryUsedBytes: 2 })).toEqual({
      kind: "unified",
      usedBytes: 2,
    });
    expect(machineGpuMemory({ name: "Intel" })).toEqual({ kind: "unreported" });
  });
});
