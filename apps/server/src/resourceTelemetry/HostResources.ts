import * as NodeOS from "node:os";
import { HostCpuHistory, type HostResourcesSnapshot } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";

const CPU_HISTORY_INTERVAL_MS = 15_000;
const CPU_HISTORY_SAMPLES = (60 * 60_000) / CPU_HISTORY_INTERVAL_MS;

/** Appends a reading at `at`, with a null for each tick missed since the last one. */
function appendCpuReading(
  history: HostCpuHistory,
  at: number,
  cpuUtilization: number | null,
): HostCpuHistory {
  const missed =
    history.values.length === 0
      ? 0
      : Math.max(0, Math.round((at - history.endAt) / history.intervalMs) - 1);
  return {
    ...history,
    endAt: at,
    values: [
      ...history.values,
      ...Array.from({ length: Math.min(missed, CPU_HISTORY_SAMPLES) }, () => null),
      cpuUtilization === null ? null : Math.round(cpuUtilization * 1000) / 1000,
    ].slice(-CPU_HISTORY_SAMPLES),
  };
}

const decodeHistoryJson = Schema.decodeEffect(Schema.fromJsonString(HostCpuHistory));
const decodeHistory = (text: string) =>
  decodeHistoryJson(text).pipe(
    Effect.filterOrFail((entry) => entry.intervalMs === CPU_HISTORY_INTERVAL_MS),
  );

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

// Linux CPU list syntax, as in Cpus_allowed_list: "0-3,8,10-11".
function parseCpuList(list: string): ReadonlySet<number> | null {
  const cpus = new Set<number>();
  for (const range of list.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
    if (!match) return null;
    for (let cpu = Number(match[1]); cpu <= Number(match[2] ?? match[1]); cpu++) cpus.add(cpu);
  }
  return cpus;
}

// os.cpus() compacts online CPUs, so its indices are not CPU ids; /proc/stat lines are keyed.
function pinnedCpu(stat: string, allowed: ReadonlySet<number>) {
  const cpu = { idle: 0, total: 0, count: 0 };
  for (const [, id, fields] of stat.matchAll(/^cpu(\d+) (.+)$/gm)) {
    if (!allowed.has(Number(id))) continue;
    const counters = (fields ?? "").trim().split(/\s+/).map(Number);
    const at = (index: number) => counters[index] ?? 0;
    // user nice system idle iowait irq softirq steal
    const idle = at(3) + at(4);
    cpu.idle += idle;
    cpu.total += idle + at(0) + at(1) + at(2) + at(5) + at(6) + at(7);
    cpu.count++;
  }
  return cpu.count > 0 ? cpu : null;
}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
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

function cgroupNumber(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

  const { cgroup, readCounters, cpuLoad } = yield* Effect.gen(function* () {
    // cgroup v2 only; limits of the server's own cgroup, which is `/` inside a container.
    const cgroupPath =
      platform === "linux"
        ? /^0::(\/.*)$/m.exec(yield* readFile("/proc/self/cgroup"))?.[1]
        : undefined;
    const cgroup =
      cgroupPath === undefined ? null : `/sys/fs/cgroup${cgroupPath.replace(/\/$/, "")}`;
    const cpuMax = cgroup
      ? /^(\d+) (\d+)$/.exec((yield* readFile(`${cgroup}/cpu.max`)).trim())
      : null;
    const readCpuUsage = () =>
      cpuMax
        ? Effect.map(readFile(`${cgroup}/cpu.stat`), (stat) =>
            cgroupNumber(stat, /^usage_usec (\d+)$/m),
          )
        : Effect.succeed(null);
    // Affinity (cpuset) pins the server to some CPUs; idle CPUs outside it are of no use.
    const allowedCpus =
      platform === "linux"
        ? parseCpuList(
            /^Cpus_allowed_list:\s*(\S+)$/m.exec(yield* readFile("/proc/self/status"))?.[1] ?? "",
          )
        : null;

    const sampleCpu = () =>
      allowedCpus
        ? Effect.map(readFile("/proc/stat"), (stat) => pinnedCpu(stat, allowedCpus) ?? readCpu())
        : Effect.sync(readCpu);

    const readCounters = Effect.fn("HostResources.readCounters")(function* () {
      return {
        cpu: yield* sampleCpu(),
        usage: yield* readCpuUsage(),
        at: yield* Clock.currentTimeMillis,
      };
    });
    type Counters = Effect.Success<ReturnType<typeof readCounters>>;
    const cpuLoad = (previous: Counters, current: Counters) => {
      const { cpu } = current;
      const elapsedMicros = (current.at - previous.at) * 1000;
      const totalDelta = cpu.total - previous.cpu.total;
      const idleDelta = cpu.idle - previous.cpu.idle;
      const hostUtilization =
        previous.cpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
          ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
          : null;
      if (!cpuMax) return { cpuCount: cpu.count, cpuUtilization: hostUtilization };
      const capacity = Math.min(Number(cpuMax[1]) / Number(cpuMax[2]), cpu.count);
      const cgroupIdle =
        previous.usage !== null && current.usage !== null && elapsedMicros > 0
          ? capacity - (current.usage - previous.usage) / elapsedMicros
          : null;
      // Agents can run in sibling cgroups (agentScope.ts), so a busy host still counts.
      const hostIdle = hostUtilization === null ? null : cpu.count * (1 - hostUtilization);
      const idle =
        cgroupIdle === null || hostIdle === null
          ? (cgroupIdle ?? hostIdle)
          : Math.min(cgroupIdle, hostIdle);
      return {
        cpuCount: Math.max(1, Math.floor(capacity)),
        cpuUtilization: idle === null ? null : Math.min(1, Math.max(0, 1 - idle / capacity)),
      };
    };
    return { cgroup, readCounters, cpuLoad };
  });

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previous = yield* readCounters();
    yield* Effect.sleep("200 millis");
    const { cpuCount, cpuUtilization } = cpuLoad(previous, yield* readCounters());

    let totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    if (platform === "linux") {
      const meminfo = yield* readFile("/proc/meminfo");
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
    const memoryMax = cgroup
      ? cgroupNumber(yield* readFile(`${cgroup}/memory.max`), /^(\d+)$/m)
      : null;
    const memoryCurrent =
      memoryMax === null
        ? null
        : cgroupNumber(yield* readFile(`${cgroup}/memory.current`), /^(\d+)$/m);
    // Without usage, a capped total would read as a near-empty cgroup; keep host values instead.
    if (memoryMax !== null && memoryCurrent !== null) {
      totalMemoryBytes = Math.min(totalMemoryBytes, memoryMax);
      // inactive_file is page cache the kernel reclaims before hitting memory.max.
      const stat = yield* readFile(`${cgroup}/memory.stat`);
      const reclaimable = cgroupNumber(stat, /^inactive_file (\d+)$/m) ?? 0;
      availableMemoryBytes = Math.min(
        availableMemoryBytes,
        memoryMax - (memoryCurrent - reclaimable),
      );
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });

  // Kept on disk so a restarted server still shows the past hour; downtime reads as a gap.
  const historyPath = path.join(config.stateDir, "host-cpu-history.json");
  const saved = yield* fs
    .readFileString(historyPath)
    .pipe(Effect.flatMap(decodeHistory), Effect.option);
  const history = yield* Ref.make<HostCpuHistory>(
    Option.match(saved, {
      onSome: (entry) => entry,
      onNone: () => ({ endAt: 0, intervalMs: CPU_HISTORY_INTERVAL_MS, values: [] }),
    }),
  );
  const persist = Ref.get(history).pipe(
    Effect.flatMap((entry) =>
      writeFileStringAtomically({ filePath: historyPath, contents: JSON.stringify(entry) }),
    ),
    Effect.ignore({ log: true }),
  );
  yield* Effect.addFinalizer(() => persist);

  yield* Effect.gen(function* () {
    yield* Effect.sleep(CPU_HISTORY_INTERVAL_MS);
    let previous = yield* readCounters();
    for (let tick = 1; ; tick += 1) {
      yield* Effect.sleep(CPU_HISTORY_INTERVAL_MS);
      const current = yield* readCounters();
      // A late tick (host asleep) averages over the whole gap; record the gap instead.
      const reading =
        current.at - previous.at > 2 * CPU_HISTORY_INTERVAL_MS
          ? null
          : cpuLoad(previous, current).cpuUtilization;
      previous = current;
      yield* Ref.update(history, (entry) => appendCpuReading(entry, current.at, reading));
      if (tick % 4 === 0) yield* persist;
    }
  }).pipe(Effect.forkScoped);

  return HostResources.of({
    read: Effect.gen(function* () {
      const snapshot = yield* Cache.get(cache, "host");
      const cpuHistory = yield* Ref.get(history);
      return cpuHistory.values.length > 0 ? { ...snapshot, cpuHistory } : snapshot;
    }),
  });
});

export const layer = Layer.effect(HostResources, make());
