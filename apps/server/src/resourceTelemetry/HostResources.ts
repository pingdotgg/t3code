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

/**
 * Core time from a /proc/stat "cpu" line, in the milliseconds os.cpus() reports: disk wait
 * counts as idle, and softirq and steal as work. os.cpus() leaves all three out of the total,
 * so a core blocked on a disk or spent on interrupts reads as the wrong one of the two.
 */
export function parseLinuxCpu(stat: string): { idle: number; total: number } | null {
  const end = stat.indexOf("\n");
  // cpu user nice system idle iowait irq softirq steal guest guest_nice
  const ticks = (end === -1 ? stat : stat.slice(0, end)).split(/\s+/).slice(1, 9).map(Number);
  if (ticks.length !== 8 || !ticks.every(Number.isFinite)) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, ioWait = 0, irq = 0, softirq = 0, steal = 0] =
    ticks;
  // libuv turns these 100 Hz counters into the milliseconds os.cpus() reports.
  const idleMs = (idle + ioWait) * 10;
  const busyMs = (user + nice + system + irq + softirq + steal) * 10;
  return { idle: idleMs, total: idleMs + busyMs };
}

/**
 * A load average above the core count can mean disk wait on Linux alone:
 * macOS counts runnable threads only, and Windows reports no load average.
 */
export const loadAverageCountsDiskWait = (platform: NodeJS.Platform) => platform === "linux";

/** Cores a cgroup CPU quota allows, or null when it sets none. */
export function cpuQuotaCores(quota: number, period: number): number | null {
  return quota > 0 && period > 0 ? quota / period : null;
}

const readIfPresent = (path: string) => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** A controller file from this process's own cgroup, which is not the mount root under systemd. */
function selfCgroupFile(controller: string, file: string): string | undefined {
  for (const line of (readIfPresent("/proc/self/cgroup") ?? "").split("\n")) {
    const [, controllers = "", path = ""] = line.split(":");
    // A cgroup v2 line names no controllers; a v1 line lists them in no fixed order.
    const hierarchy = controllers === "" ? ["unified"] : controllers.split(",");
    if (!hierarchy.includes(controller)) continue;
    const found = readIfPresent(`/sys/fs/cgroup${path}/${file}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

// availableParallelism() rounds a fractional quota up, so a container held to half a core on a
// single-core host still reports one, and host-wide busy time looks idle while it is throttled.
function cgroupCpuQuotaCores(): number | null {
  const v2 = selfCgroupFile("unified", "cpu.max") ?? readIfPresent("/sys/fs/cgroup/cpu.max");
  if (v2 !== undefined) {
    const [quota, period] = v2.trim().split(/\s+/);
    return quota === undefined || quota === "max"
      ? null
      : cpuQuotaCores(Number(quota), Number(period));
  }
  const cpu = (file: string) => selfCgroupFile("cpu", file);
  const quota = cpu("cpu.cfs_quota_us");
  if (quota === undefined) return null;
  return cpuQuotaCores(Number(quota), Number(cpu("cpu.cfs_period_us") ?? "100000"));
}

/** Whether host-wide core time describes what this process can use. */
export const cpuLimitCoversHost = (cores: number) => {
  const quota = cgroupCpuQuotaCores();
  return quota === null || quota >= cores;
};

export interface CpuTimes {
  readonly idle: number;
  readonly total: number;
  readonly count: number;
}

/** Cumulative core time, or nothing when this platform's counters cannot tell work from its absence. */
export function readCpu(platform: NodeJS.Platform): CpuTimes | null {
  const cpus = NodeOS.cpus();
  if (platform === "linux") {
    try {
      const parsed = parseLinuxCpu(NodeFS.readFileSync("/proc/stat", "utf8"));
      return parsed === null ? null : { ...parsed, count: cpus.length };
    } catch {
      return null;
    }
  }
  return {
    ...cpus.reduce(
      (sum, { times }) => ({
        idle: sum.idle + times.idle,
        total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
      }),
      { idle: 0, total: 0 },
    ),
    count: cpus.length,
  };
}

/** Share of core time spent running work between two readings, null if they are not comparable. */
export function cpuBusyBetween(previous: CpuTimes, next: CpuTimes): number | null {
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
    const cpuUtilization =
      previousCpu === null || cpu === null ? null : cpuBusyBetween(previousCpu, cpu);
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
      cpuCount: cpu?.count ?? NodeOS.cpus().length,
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
