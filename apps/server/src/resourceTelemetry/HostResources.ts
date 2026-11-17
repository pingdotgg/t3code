import * as NodeOS from "node:os";
import type {
  HostMemoryPressure,
  HostMemoryPressureAgent,
  HostMemoryPressureLevel,
  HostResourcesSnapshot,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as AgentScope from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

export class HostResources extends Context.Service<
  HostResources,
  {
    readonly read: Effect.Effect<HostResourcesSnapshot>;
    /** Changes only; samples while someone listens. */
    readonly memoryPressure: Stream.Stream<HostMemoryPressure>;
  }
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

/** A PSI file's 10 s average for `some` or `full`, in percent. */
export function psiAvg10(text: string, kind: "some" | "full"): number | null {
  const value = new RegExp(`^${kind} avg10=(\\d+(?:\\.\\d+)?)`, "m").exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

export interface MemoryPressureSample {
  /** Linux PSI avg10 percentages. */
  readonly hostSome: number | null;
  readonly hostFull: number | null;
  readonly agentsFull: number | null;
  /** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
  readonly darwinLevel: number | null;
}

/**
 * A level is entered above its threshold and left only well below it, so the
 * indicator does not flicker while pressure hovers. `full` means every task
 * waited; the agents slice is throttled first, so it gets looser thresholds.
 */
export function nextMemoryPressureLevel(
  previous: HostMemoryPressureLevel,
  sample: MemoryPressureSample,
): HostMemoryPressureLevel {
  const at = (value: number | null, threshold: number) => value !== null && value >= threshold;
  // A failed read is no evidence pressure ended; a host without these signals stays at none.
  if (Object.values(sample).every((value) => value === null)) return previous;
  const severe =
    previous === "severe"
      ? at(sample.hostFull, 4) || at(sample.agentsFull, 8) || at(sample.darwinLevel, 4)
      : at(sample.hostFull, 10) || at(sample.agentsFull, 20) || at(sample.darwinLevel, 4);
  if (severe) return "severe";
  const elevated =
    previous === "none"
      ? at(sample.hostSome, 10) ||
        at(sample.hostFull, 2) ||
        at(sample.agentsFull, 5) ||
        at(sample.darwinLevel, 2)
      : at(sample.hostSome, 4) ||
        at(sample.hostFull, 0.5) ||
        at(sample.agentsFull, 2) ||
        at(sample.darwinLevel, 2);
  return elevated ? "elevated" : "none";
}

const MEMORY_PRESSURE_INTERVAL = "5 seconds";
const MAX_UNREAD_PRESSURE_SAMPLES = 6;
const HEAVIEST_AGENT_COUNT = 3;
/** Up to about an eighth coarser, so ordinary growth does not push an update every sample. */
export function roundAgentMemory(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  const step = 2 ** Math.max(20, Math.floor(Math.log2(bytes)) - 3);
  return Math.ceil(bytes / step) * step;
}

/** Ranked by exact size: rounding first would tie close agents and could drop the largest. */
export function heaviestAgents(
  agents: ReadonlyArray<HostMemoryPressureAgent>,
): ReadonlyArray<HostMemoryPressureAgent> {
  return agents
    .filter((agent) => agent.memoryBytes > 0)
    .toSorted((left, right) => right.memoryBytes - left.memoryBytes)
    .slice(0, HEAVIEST_AGENT_COUNT)
    .map((agent) => ({ ...agent, memoryBytes: roundAgentMemory(agent.memoryBytes) }));
}

function cgroupNumber(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope.AgentScope;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const level = yield* Ref.make<HostMemoryPressureLevel>("none");
  const unreadSamples = yield* Ref.make(0);

  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

  // Untraced: it runs every few seconds while a client listens.
  const sampleMemoryPressure = Effect.fnUntraced(function* () {
    const agents = platform === "linux" ? yield* agentScope.controlGroups : undefined;
    const hostPressure = platform === "linux" ? yield* readFile("/proc/pressure/memory") : "";
    const agentsPressure =
      agents === undefined ? "" : yield* readFile(`/sys/fs/cgroup${agents.slice}/memory.pressure`);
    // The running sidecar reads it: under pressure a newly spawned `sysctl` may never start.
    const darwinLevel =
      platform === "darwin"
        ? yield* nativeTelemetry.memoryPressureLevel.pipe(Effect.orElseSucceed(() => null))
        : null;
    const sample: MemoryPressureSample = {
      hostSome: psiAvg10(hostPressure, "some"),
      hostFull: psiAvg10(hostPressure, "full"),
      agentsFull: psiAvg10(agentsPressure, "full"),
      darwinLevel,
    };
    const unread = Object.values(sample).every((value) => value === null)
      ? yield* Ref.updateAndGet(unreadSamples, (count) => count + 1)
      : yield* Ref.setAndGet(unreadSamples, 0);
    // A dead sidecar must not leave a warning up long after the pressure ended.
    const next =
      unread >= MAX_UNREAD_PRESSURE_SAMPLES
        ? "none"
        : nextMemoryPressureLevel(yield* Ref.get(level), sample);
    yield* Ref.set(level, next);
    const agentMemory =
      next === "none" || agents === undefined
        ? []
        : yield* Effect.forEach(agents.scopes, (scope) =>
            readFile(`/sys/fs/cgroup${scope.path}/memory.current`).pipe(
              Effect.map((text) => ({
                threadId: scope.threadId === undefined ? null : ThreadId.make(scope.threadId),
                agent: scope.agent,
                memoryBytes: Number(text.trim()) || 0,
              })),
            ),
          );
    return {
      level: next,
      heaviestAgents: heaviestAgents(agentMemory),
    } satisfies HostMemoryPressure;
  });

  const sample = Effect.fn("HostResources.sample")(function* () {
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

    const previousCpu = yield* sampleCpu();
    const previousUsage = yield* readCpuUsage();
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Effect.sleep("200 millis");
    const cpu = yield* sampleCpu();
    const usage = yield* readCpuUsage();
    const elapsedMicros = ((yield* Clock.currentTimeMillis) - startedAt) * 1000;
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    let cpuCount = cpu.count;
    const hostUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
    let cpuUtilization = hostUtilization;
    if (cpuMax) {
      const capacity = Math.min(Number(cpuMax[1]) / Number(cpuMax[2]), cpu.count);
      cpuCount = Math.max(1, Math.floor(capacity));
      const cgroupIdle =
        previousUsage !== null && usage !== null && elapsedMicros > 0
          ? capacity - (usage - previousUsage) / elapsedMicros
          : null;
      // Agents can run in sibling cgroups (agentScope.ts), so a busy host still counts.
      const hostIdle = hostUtilization === null ? null : cpu.count * (1 - hostUtilization);
      const idle =
        cgroupIdle === null || hostIdle === null
          ? (cgroupIdle ?? hostIdle)
          : Math.min(cgroupIdle, hostIdle);
      cpuUtilization = idle === null ? null : Math.min(1, Math.max(0, 1 - idle / capacity));
    }

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
  const memoryPressure = yield* Stream.fromEffectSchedule(
    sampleMemoryPressure(),
    Schedule.spaced(MEMORY_PRESSURE_INTERVAL),
  ).pipe(
    Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
    Stream.share({ capacity: 1, strategy: "sliding", replay: 1 }),
  );
  return HostResources.of({ read: Cache.get(cache, "host"), memoryPressure });
});

export const layer = Layer.effect(HostResources, make());
