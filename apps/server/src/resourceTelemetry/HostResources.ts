// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query, and its calls cannot be kept to one in flight.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type {
  HostPressure,
  HostPressureAgent,
  HostPressureLevel,
  HostResourcesSnapshot,
} from "@t3tools/contracts";
import { CALM_HOST_PRESSURE, ThreadId } from "@t3tools/contracts";
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

import * as Config from "../config.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

export class HostResources extends Context.Service<
  HostResources,
  {
    readonly read: Effect.Effect<HostResourcesSnapshot>;
    /** Changes only; samples while someone listens. */
    readonly pressure: Stream.Stream<HostPressure>;
    /** The latest pressure, sampling once when nobody listens. */
    readonly readPressure: Effect.Effect<HostPressure>;
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

/** A PSI file's `some` or `full` average over 10 or 60 s, in percent. */
export function psiAverage(
  text: string,
  kind: "some" | "full",
  window: "avg10" | "avg60",
): number | null {
  const value = new RegExp(`^${kind} .*\\b${window}=(\\d+(?:\\.\\d+)?)`, "m").exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

/**
 * `/proc/diskstats` summed over whole devices: milliseconds with I/O in flight (`io_ticks`)
 * and requests in flight now. Partitions repeat their device's time, so they are left out.
 */
export function blockDeviceActivity(
  diskstats: string,
  devices: ReadonlySet<string>,
): { readonly busyMs: number; readonly inFlight: boolean } | null {
  let found = false;
  let busyMs = 0;
  let inFlight = false;
  for (const line of diskstats.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const requests = Number(fields[11]);
    const ioTicks = Number(fields[12]);
    if (!devices.has(fields[2] ?? "") || !Number.isFinite(requests) || !Number.isFinite(ioTicks)) {
      continue;
    }
    found = true;
    busyMs += ioTicks;
    inFlight ||= requests > 0;
  }
  return found ? { busyMs, inFlight } : null;
}

// Types on an anonymous device (major 0) whose waits still end at a block device, or nowhere.
// Network filesystems are absent on purpose, and so is anything unknown.
const LOCAL_ANONYMOUS_FILESYSTEMS = new Set([
  "autofs",
  "bcachefs",
  "binder",
  "binfmt_misc",
  "bpf",
  "btrfs",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "ecryptfs",
  "efivarfs",
  "fuse.lxcfs",
  // Passes documents through from other mounts, which are judged by their own rows.
  "fuse.portal",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nfsd",
  "nsfs",
  "overlay",
  "proc",
  "pstore",
  "ramfs",
  "rootfs",
  "rpc_pipefs",
  "securityfs",
  "selinuxfs",
  "sysfs",
  "tmpfs",
  "tracefs",
  "zfs",
]);

/**
 * The mounts in `/proc/self/mountinfo` whose stalls may never reach a block device. NFS keeps
 * counters and the GVFS bridge lists its shares, so those two can be told idle from in use.
 * Nothing tells that of the rest, nor of an unreadable table: there, being mounted is enough.
 */
export function mountsOffBlockDevices(
  mountinfo: string,
  ownAppDir: string | undefined,
): { readonly nfs: boolean; readonly gvfs: ReadonlyArray<string>; readonly unknown: boolean } {
  const mounts = mountinfo.split("\n").filter((line) => line.trim() !== "");
  const gvfs: Array<string> = [];
  let nfs = false;
  let unknown = mounts.length === 0;
  for (const line of mounts) {
    const mount = /^\d+ \d+ (\d+):\d+ \S+ (\S+) .* - (\S+) /.exec(line);
    const type = mount?.[3] ?? "";
    const mountPoint = (mount?.[2] ?? "").replace(/\\(\d{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    if (mount?.[1] !== "0") unknown ||= !mount;
    else if (type === "nfs" || type === "nfs4") nfs = true;
    else if (type === "fuse.gvfsd-fuse") gvfs.push(mountPoint);
    // The AppImage this server runs from is a FUSE mount of a local file.
    else if (type.startsWith("fuse.") && mountPoint === ownAppDir?.replace(/\/+$/, "")) continue;
    else unknown ||= !LOCAL_ANONYMOUS_FILESYSTEMS.has(type);
  }
  return { nfs, gvfs, unknown };
}

/**
 * Every NFS mount's `events` and `bytes` lines from `/proc/self/mountstats`. They count each
 * call into the filesystem as it starts, so a stall that began and ended between two samples
 * still moves them.
 */
function nfsCounters(mountstats: string): string {
  return (mountstats.match(/^\s*(?:events|bytes):.*$/gm) ?? []).join("\n");
}

export interface BlockReading {
  readonly at: number;
  /** Null when block devices cannot account for every storage stall, or were unreadable. */
  readonly busyMs: number | null;
  readonly inFlight: boolean;
}

/**
 * An upper bound, in percent, on the share of the readings' span that tasks waited on a block
 * device: none can wait longer than some device has I/O in flight, and devices busy at
 * different times add up. Null when any reading leaves that open.
 */
export function blockBusyPercent(readings: ReadonlyArray<BlockReading>): number | null {
  const first = readings[0];
  const last = readings.at(-1);
  if (!first || !last || last.at <= first.at) return null;
  let busyMs = 0;
  for (const [index, reading] of readings.entries()) {
    if (reading.busyMs === null) return null;
    const before = readings[index - 1];
    if (!before || before.busyMs === null) continue;
    // A removed device or a counter reset.
    if (reading.busyMs < before.busyMs) return null;
    // `io_ticks` counts a request when it completes, so a hung disk never advances it.
    busyMs +=
      before.inFlight && reading.inFlight ? reading.at - before.at : reading.busyMs - before.busyMs;
  }
  return Math.min(100, (busyMs / (last.at - first.at)) * 100);
}

export interface PressureSample {
  /** Linux PSI avg10 percentages for memory. */
  readonly memorySome: number | null;
  readonly memoryFull: number | null;
  readonly agentsMemoryFull: number | null;
  /** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
  readonly darwinMemoryLevel: number | null;
  /** Linux PSI avg60 percentages; a minute, so a build's burst is not an overload. */
  readonly cpuSome: number | null;
  readonly ioFull: number | null;
  /**
   * `blockBusyPercent` over about the same minute. PSI also counts waits behind which no
   * storage works, such as a terminal idling in `io_uring_enter`, so it is capped by this.
   */
  readonly blockBusy: number | null;
  /** One-minute load average per CPU, where PSI is missing. */
  readonly loadPerCpu: number | null;
  readonly diskFreeBytes: number | null;
  readonly diskTotalBytes: number | null;
}

export interface PressureLevels {
  readonly memory: HostPressureLevel;
  readonly cpu: HostPressureLevel;
  readonly io: HostPressureLevel;
  readonly disk: HostPressureLevel;
}

export const CALM: PressureLevels = { memory: "none", cpu: "none", io: "none", disk: "none" };

const RANK = { none: 0, elevated: 1, severe: 2 } as const;
// A level is left only well below where it was entered, so it does not flicker.
const EXIT_RATIO = 0.4;
const GiB = 1024 ** 3;
const IO_ELEVATED = 10;

const worst = (levels: ReadonlyArray<HostPressureLevel>): HostPressureLevel =>
  levels.reduce((left, right) => (RANK[right] > RANK[left] ? right : left), "none");

function grade(
  previous: HostPressureLevel,
  value: number | null,
  elevated: number,
  severe: number,
): HostPressureLevel {
  if (value === null) return "none";
  const holds = (level: HostPressureLevel, threshold: number) =>
    value >= (RANK[previous] >= RANK[level] ? threshold * EXIT_RATIO : threshold);
  if (holds("severe", severe)) return "severe";
  return holds("elevated", elevated) ? "elevated" : "none";
}

function diskLevel(previous: HostPressureLevel, free: number, total: number): HostPressureLevel {
  const below = (level: HostPressureLevel, limit: number) =>
    free < (RANK[previous] >= RANK[level] ? limit * 1.25 : limit);
  if (below("severe", Math.min(5 * GiB, total * 0.05))) return "severe";
  return below("elevated", Math.min(20 * GiB, total * 0.15)) ? "elevated" : "none";
}

/**
 * `full` means every task waited. The agents slice is throttled first, so it
 * gets looser thresholds. A kind with nothing readable keeps its level: a
 * failed read is no evidence the pressure ended.
 */
export function nextPressureLevels(
  previous: PressureLevels,
  sample: PressureSample,
): PressureLevels {
  const memoryRead =
    sample.memorySome !== null ||
    sample.memoryFull !== null ||
    sample.agentsMemoryFull !== null ||
    sample.darwinMemoryLevel !== null;
  const memory = memoryRead
    ? worst([
        grade(previous.memory, sample.memorySome, 10, Number.POSITIVE_INFINITY),
        grade(previous.memory, sample.memoryFull, 2, 10),
        grade(previous.memory, sample.agentsMemoryFull, 5, 20),
        sample.darwinMemoryLevel === null
          ? "none"
          : sample.darwinMemoryLevel >= 4
            ? "severe"
            : sample.darwinMemoryLevel >= 2
              ? "elevated"
              : "none",
      ])
    : previous.memory;
  const cpu =
    sample.cpuSome !== null
      ? grade(previous.cpu, sample.cpuSome, 25, 60)
      : sample.loadPerCpu !== null
        ? grade(previous.cpu, sample.loadPerCpu, 1.5, 3)
        : previous.cpu;
  const io =
    sample.ioFull === null
      ? previous.io
      : grade(
          previous.io,
          sample.blockBusy === null ? sample.ioFull : Math.min(sample.ioFull, sample.blockBusy),
          IO_ELEVATED,
          30,
        );
  const disk =
    sample.diskFreeBytes === null || sample.diskTotalBytes === null
      ? previous.disk
      : diskLevel(previous.disk, sample.diskFreeBytes, sample.diskTotalBytes);
  return { memory, cpu, io, disk };
}

const PRESSURE_INTERVAL = "5 seconds";
const MAX_UNREAD_PRESSURE_SAMPLES = 6;
const HEAVIEST_AGENT_COUNT = 3;
const CPU_SAMPLE_MAX_AGE_MS = 30_000;
// The span of the avg60 PSI that io pressure is graded on.
const BLOCK_BUSY_WINDOW_MS = 60_000;

/** Up to about an eighth coarser, so ordinary growth does not push an update every sample. */
export function roundCoarsely(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  const step = 2 ** Math.max(20, Math.floor(Math.log2(bytes)) - 3);
  return Math.ceil(bytes / step) * step;
}

/** Half a core below two cores, whole cores above. */
function roundCores(cores: number): number {
  if (!Number.isFinite(cores) || cores <= 0) return 0;
  return cores < 2 ? Math.round(cores * 2) / 2 : Math.round(cores);
}

/** Ranked by exact size: rounding first would tie close agents and could drop the largest. */
export function heaviestAgents(
  agents: ReadonlyArray<HostPressureAgent>,
  by: "memory" | "cpu",
): ReadonlyArray<HostPressureAgent> {
  const size = (agent: HostPressureAgent) =>
    by === "memory" ? agent.memoryBytes : (agent.cpuCores ?? 0);
  return agents
    .filter((agent) => size(agent) > 0)
    .toSorted((left, right) => size(right) - size(left))
    .slice(0, HEAVIEST_AGENT_COUNT)
    .map((agent) => ({
      ...agent,
      memoryBytes: roundCoarsely(agent.memoryBytes),
      cpuCores: agent.cpuCores === null ? null : roundCores(agent.cpuCores),
    }));
}

function cgroupNumber(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope.AgentScope;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const config = yield* Config.ServerConfig;
  const levels = yield* Ref.make(CALM);
  const unreadSamples = yield* Ref.make({ memory: 0, cpu: 0, io: 0, disk: 0 });
  const lastAgentCpu = yield* Ref.make<{
    readonly at: number;
    readonly usage: ReadonlyMap<string, number>;
  } | null>(null);
  const blockReadings = yield* Ref.make<ReadonlyArray<BlockReading>>([]);
  const lastNfsCounters = yield* Ref.make<string | null>(null);

  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

  // libuv cannot cancel a started call, so a hung mount gets at most one of a kind in flight.
  const pendingOnMount = new Set<string>();
  const onMount = <A>(call: string, directory: string, run: (directory: string) => Promise<A>) =>
    Effect.promise(() => {
      const key = `${call} ${directory}`;
      if (pendingOnMount.has(key)) return Promise.resolve(null);
      pendingOnMount.add(key);
      // An unreadable volume is reported as unknown, not as an error.
      return run(directory)
        .catch(() => null)
        .finally(() => pendingOnMount.delete(key));
    }).pipe(
      // A hung network mount must not hold the sample.
      Effect.timeoutOption("1 second"),
      Effect.map((result) => (result._tag === "Some" ? result.value : null)),
    );
  const readDiskSpace = (directory: string) =>
    onMount("statfs", directory, (path) => NodeFSP.statfs(path)).pipe(
      Effect.map((stats) =>
        stats === null
          ? null
          : { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize },
      ),
    );

  // The volume under the most pressure decides, so a severe small volume is not hidden by a larger one.
  const diskSpace = Effect.gen(function* () {
    const previous = (yield* Ref.get(levels)).disk;
    const volumes = yield* Effect.forEach(
      [...new Set([config.baseDir, config.worktreesDir])],
      readDiskSpace,
      { concurrency: "unbounded" },
    );
    const rank = (volume: { free: number; total: number }) =>
      RANK[diskLevel(previous, volume.free, volume.total)];
    return volumes.reduce<{ free: number; total: number } | null>(
      (chosen, volume) =>
        volume !== null &&
        (chosen === null ||
          rank(volume) > rank(chosen) ||
          (rank(volume) === rank(chosen) && volume.free < chosen.free))
          ? volume
          : chosen,
      null,
    );
  });

  const readBlockDevices = Effect.gen(function* () {
    const devices = yield* fs.readDirectory("/sys/block").pipe(Effect.orElseSucceed(() => []));
    const activity = blockDeviceActivity(yield* readFile("/proc/diskstats"), new Set(devices));
    const offBlock = mountsOffBlockDevices(
      yield* readFile("/proc/self/mountinfo"),
      environment.APPDIR,
    );
    const nfs = offBlock.nfs ? nfsCounters(yield* readFile("/proc/self/mountstats")) : "";
    // Compared with the reading before, however old: the counters only ever grow.
    const nfsBefore = yield* Ref.getAndSet(lastNfsCounters, nfs);
    const nfsIdle = offBlock.nfs ? nfs !== "" && nfs === nfsBefore : !nfsBefore;
    // The bridge shows each share it carries as an entry; with none, nothing can wait on it.
    const gvfsShares = yield* Effect.forEach(offBlock.gvfs, (directory) =>
      onMount("readdir", directory, (path) => NodeFSP.readdir(path)),
    );
    const bounded =
      activity !== null &&
      !offBlock.unknown &&
      nfsIdle &&
      gvfsShares.every((shares) => shares?.length === 0);
    return {
      at: yield* Clock.currentTimeMillis,
      busyMs: bounded ? activity.busyMs : null,
      inFlight: activity?.inFlight ?? false,
    } satisfies BlockReading;
  });
  // Every sample is kept for a minute, so the bound covers the stalls PSI still remembers.
  // With nothing kept, a reading 200 ms later stands in, taken only when PSI could raise a level.
  const sampleBlockBusy = Effect.fnUntraced(function* (ioFull: number) {
    const reading = yield* readBlockDevices;
    const kept = (yield* Ref.get(blockReadings)).filter(
      (earlier) => reading.at - earlier.at <= BLOCK_BUSY_WINDOW_MS,
    );
    yield* Ref.set(blockReadings, [...kept, reading]);
    if (kept.length > 0) return blockBusyPercent([...kept, reading]);
    if (ioFull < IO_ELEVATED * EXIT_RATIO || reading.busyMs === null) return null;
    yield* Effect.sleep("200 millis");
    return blockBusyPercent([reading, yield* readBlockDevices]);
  });

  // Untraced: it runs every few seconds while a client listens.
  const samplePressure = Effect.fnUntraced(function* () {
    const linux = platform === "linux";
    const agents = linux ? yield* agentScope.controlGroups : undefined;
    const memoryPsi = linux ? yield* readFile("/proc/pressure/memory") : "";
    const cpuPsi = linux ? yield* readFile("/proc/pressure/cpu") : "";
    const ioPsi = linux ? yield* readFile("/proc/pressure/io") : "";
    const agentsPsi =
      agents === undefined ? "" : yield* readFile(`/sys/fs/cgroup${agents.slice}/memory.pressure`);
    // The running sidecar reads it: under pressure a newly spawned `sysctl` may never start.
    const darwinMemoryLevel =
      platform === "darwin"
        ? yield* nativeTelemetry.memoryPressureLevel.pipe(Effect.orElseSucceed(() => null))
        : null;
    const cpuSome = psiAverage(cpuPsi, "some", "avg60");
    // Windows reports a zero load average, which would read as calm.
    const loadPerCpu =
      cpuSome === null && platform !== "win32"
        ? NodeOS.loadavg()[0]! / Math.max(1, NodeOS.availableParallelism())
        : null;
    const disk = yield* diskSpace;
    const ioFull = psiAverage(ioPsi, "full", "avg60");
    const sample: PressureSample = {
      memorySome: psiAverage(memoryPsi, "some", "avg10"),
      memoryFull: psiAverage(memoryPsi, "full", "avg10"),
      agentsMemoryFull: psiAverage(agentsPsi, "full", "avg10"),
      darwinMemoryLevel,
      cpuSome,
      ioFull,
      blockBusy: ioFull === null ? null : yield* sampleBlockBusy(ioFull),
      loadPerCpu,
      diskFreeBytes: disk?.free ?? null,
      diskTotalBytes: disk?.total ?? null,
    };
    const unread = yield* Ref.updateAndGet(unreadSamples, (counts) => ({
      memory:
        sample.memorySome === null &&
        sample.memoryFull === null &&
        sample.agentsMemoryFull === null &&
        darwinMemoryLevel === null
          ? counts.memory + 1
          : 0,
      cpu: cpuSome === null && loadPerCpu === null ? counts.cpu + 1 : 0,
      io: sample.ioFull === null ? counts.io + 1 : 0,
      disk: disk === null ? counts.disk + 1 : 0,
    }));
    const graded = nextPressureLevels(yield* Ref.get(levels), sample);
    // A dead sidecar or a vanished mount must not leave a warning up long after it ended.
    const next = {
      memory: unread.memory >= MAX_UNREAD_PRESSURE_SAMPLES ? "none" : graded.memory,
      cpu: unread.cpu >= MAX_UNREAD_PRESSURE_SAMPLES ? "none" : graded.cpu,
      io: unread.io >= MAX_UNREAD_PRESSURE_SAMPLES ? "none" : graded.io,
      disk: unread.disk >= MAX_UNREAD_PRESSURE_SAMPLES ? "none" : graded.disk,
    } satisfies PressureLevels;
    yield* Ref.set(levels, next);

    // CPU use is a difference of two readings, so it is read every sample while the scopes exist.
    const now = yield* Clock.currentTimeMillis;
    const cpuUsage = new Map(
      agents === undefined
        ? []
        : yield* Effect.forEach(agents.scopes, (scope) =>
            readFile(`/sys/fs/cgroup${scope.path}/cpu.stat`).pipe(
              Effect.map(
                (stat) => [scope.path, cgroupNumber(stat, /^usage_usec (\d+)$/m)] as const,
              ),
            ),
          ),
    );
    const previousCpu = yield* Ref.getAndSet(lastAgentCpu, {
      at: now,
      usage: new Map(
        [...cpuUsage].flatMap(([path, usage]) => (usage === null ? [] : [[path, usage] as const])),
      ),
    });
    const elapsedMicros =
      previousCpu === null || now - previousCpu.at > CPU_SAMPLE_MAX_AGE_MS
        ? null
        : (now - previousCpu.at) * 1000;
    // The more pressured resource names the culprits; `hostPressureRanking` mirrors this.
    const rankBy =
      next.memory === "none" && next.cpu === "none"
        ? null
        : RANK[next.cpu] > RANK[next.memory]
          ? "cpu"
          : "memory";
    const agentUsage =
      rankBy === null || agents === undefined
        ? []
        : yield* Effect.forEach(agents.scopes, (scope) =>
            readFile(`/sys/fs/cgroup${scope.path}/memory.current`).pipe(
              Effect.map((text): HostPressureAgent => {
                const usage = cpuUsage.get(scope.path);
                const before = previousCpu?.usage.get(scope.path);
                return {
                  threadId: scope.threadId === undefined ? null : ThreadId.make(scope.threadId),
                  agent: scope.agent,
                  memoryBytes: Number(text.trim()) || 0,
                  cpuCores:
                    elapsedMicros === null ||
                    elapsedMicros <= 0 ||
                    usage === null ||
                    usage === undefined ||
                    before === undefined
                      ? null
                      : Math.max(0, usage - before) / elapsedMicros,
                };
              }),
            ),
          );
    return {
      ...next,
      diskFreeBytes: next.disk === "none" || disk === null ? null : roundCoarsely(disk.free),
      heaviestAgents: rankBy === null ? [] : heaviestAgents(agentUsage, rankBy),
    } satisfies HostPressure;
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
    const disk = yield* diskSpace;
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      diskFreeBytes: disk?.free ?? null,
      diskTotalBytes: disk?.total ?? null,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  const pressure = yield* Stream.fromEffectSchedule(
    samplePressure(),
    Schedule.spaced(PRESSURE_INTERVAL),
  ).pipe(
    Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
    Stream.share({ capacity: 1, strategy: "sliding", replay: 1 }),
  );
  const readPressure = Stream.runHead(pressure).pipe(
    Effect.map((latest) => (latest._tag === "Some" ? latest.value : CALM_HOST_PRESSURE)),
  );
  return HostResources.of({ read: Cache.get(cache, "host"), pressure, readPressure });
});

export const layer = Layer.effect(HostResources, make());
