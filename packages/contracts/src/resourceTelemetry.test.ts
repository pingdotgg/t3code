import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HostResourcesSnapshot,
  ResourceMonitorEvent,
  ResourceMonitorHelloEvent,
} from "./resourceTelemetry.ts";

const decodeSnapshot = Schema.decodeUnknownSync(HostResourcesSnapshot);
const decodeHello = Schema.decodeSync(ResourceMonitorHelloEvent);
const decodeMonitorEvent = Schema.decodeSync(ResourceMonitorEvent);

describe("HostResourcesSnapshot", () => {
  it("decodes a snapshot from a server that predates machine details", () => {
    const snapshot = decodeSnapshot({
      sampledAt: 1,
      cpuUtilization: 0.5,
      cpuCount: 8,
      availableMemoryBytes: 2,
      totalMemoryBytes: 4,
    });

    expect(snapshot).not.toHaveProperty("storage");
    expect(snapshot).not.toHaveProperty("swap");
  });

  it("decodes machine details", () => {
    const snapshot = decodeSnapshot({
      sampledAt: 1,
      cpuUtilization: null,
      cpuCount: 8,
      availableMemoryBytes: 2,
      totalMemoryBytes: 4,
      cpuModel: "Apple M3 Max",
      loadAverage: { one: 1, five: 2, fifteen: 3 },
      swap: { totalBytes: 8, usedBytes: 1 },
      storage: {
        sampledAt: 1,
        volumes: [
          {
            mountPoint: "/",
            name: "disk",
            fileSystem: "ext4",
            totalBytes: 100,
            availableBytes: 40,
            roles: ["t3Home", "worktrees"],
          },
        ],
        unavailableReason: "Only T3 volumes are shown.",
      },
    });

    expect(snapshot.storage?.volumes[0]?.roles).toEqual(["t3Home", "worktrees"]);
  });
});

describe("ResourceMonitorEvent", () => {
  it("decodes the hello of a monitor without the host system capability", () => {
    const hello = decodeHello({
      version: 3,
      type: "hello",
      sidecarVersion: "0.1.0",
      sidecarPid: 1,
      platform: "linux",
      arch: "x86_64",
      capabilities: {
        cumulativeCpuTime: true,
        currentCpuPercent: true,
        residentMemory: true,
        virtualMemory: true,
        ioBytes: true,
        processStartTime: true,
        processTree: true,
      },
    });

    expect(hello.capabilities.hostSystem).toBeUndefined();
  });

  it("decodes a host system event", () => {
    const event = decodeMonitorEvent({
      version: 3,
      type: "hostSystem",
      requestId: "request",
      disks: [
        {
          mountPoint: "/",
          name: "disk",
          fileSystem: "apfs",
          totalBytes: 100,
          availableBytes: 40,
          removable: false,
          readOnly: true,
        },
      ],
      swapTotalBytes: 8,
      swapUsedBytes: 1,
    });

    expect(event.type).toBe("hostSystem");
  });
});
