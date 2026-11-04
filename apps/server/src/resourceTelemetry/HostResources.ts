// @effect-diagnostics nodeBuiltinImport:off - iowait exists only in /proc/stat, which must be read at the same instant as os.cpus() and has no Effect equivalent.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

// os.cpus() drops iowait from idle and from the total, so a disk-blocked core reads as busy.
// libuv turns the 100 Hz tick counters behind os.cpus() into milliseconds, hence the scale here.
function readDiskWait(platform: NodeJS.Platform): number | null {
  if (platform !== "linux") return 0;
  try {
    const stat = NodeFS.readFileSync("/proc/stat", "utf8");
    // cpu user nice system idle iowait irq softirq steal guest guest_nice
    const ioWaitTicks = Number(stat.slice(0, stat.indexOf("\n")).split(/\s+/)[5]);
    return Number.isFinite(ioWaitTicks) ? ioWaitTicks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * A load average above the core count can mean disk wait on Linux alone:
 * macOS counts runnable threads only, and Windows reports no load average.
 */
export const loadAverageCountsDiskWait = (platform: NodeJS.Platform) => platform === "linux";

export function readCpu(platform: NodeJS.Platform) {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  const diskWait = readDiskWait(platform);
  return {
    idle: cpu.idle + (diskWait ?? 0),
    total: cpu.total + (diskWait ?? 0),
    count: cpus.length,
    diskWait,
  };
}

type CpuTimes = ReturnType<typeof readCpu>;

/** Share of core time spent running work between two readings, null if they are not comparable. */
export function cpuBusyBetween(previous: CpuTimes, next: CpuTimes): number | null {
  if (previous.diskWait === null || next.diskWait === null) return null;
  const totalDelta = next.total - previous.total;
  const idleDelta = next.idle - previous.idle;
  return previous.count === next.count && totalDelta > 0 && idleDelta >= 0
    ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
    : null;
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat excludes speculative from free; add it once, without overlapping purgeable pages.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu(platform);
    yield* Effect.sleep("200 millis");
    const cpu = readCpu(platform);
    const cpuUtilization = cpuBusyBetween(previousCpu, cpu);
    const totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => ""));
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
    } else if (platform === "darwin") {
      const output = yield* spawner
        .string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes;
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

export const layer = Layer.effect(HostResources, make());
