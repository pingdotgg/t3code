// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect FileSystem has no statfs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

type OsUpdates = NonNullable<HostResourcesSnapshot["osUpdates"]>;

class HostDiskReadError extends Schema.TaggedError<HostDiskReadError>()("HostDiskReadError", {
  cause: Schema.Defect(),
}) {}

const decodeRecommendedUpdates = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        Identifier: Schema.optionalKey(Schema.String),
        "Display Name": Schema.optionalKey(Schema.String),
        "Display Version": Schema.optionalKey(Schema.String),
      }),
    ),
  ),
);

/** `RecommendedUpdates` from com.apple.SoftwareUpdate.plist, as `plutil -extract ... json`. */
export function parseDarwinRecommendedUpdates(json: string): OsUpdates | undefined {
  const decoded = Option.getOrUndefined(decodeRecommendedUpdates(json));
  if (!decoded) return undefined;
  // Major OS upgrades are optional, as Ubuntu's count leaves out release upgrades.
  const entries = decoded.filter(({ Identifier }) => !Identifier?.endsWith("_major"));
  const names = entries.flatMap(({ "Display Name": name, "Display Version": version }) => {
    if (!name) return [];
    return [version && !name.endsWith(version) ? `${name} ${version}` : name];
  });
  return { available: entries.length, names: names.slice(0, 20) };
}

/** Ubuntu's MOTD fragment at /var/lib/update-notifier/updates-available, old and new wording. */
export function parseUpdateNotifier(text: string): OsUpdates | undefined {
  const available = /^(\d+) (?:updates?|packages?) can be (?:applied immediately|updated)/m.exec(
    text,
  )?.[1];
  if (!available) return undefined;
  const security =
    /^(\d+) (?:of these )?updates? (?:is|are) (?:a )?(?:standard )?security updates?\./m.exec(
      text,
    )?.[1];
  return {
    available: Number(available),
    ...(security ? { security: Number(security) } : {}),
  };
}

function cgroupNumber(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const homeDirectory = yield* HostProcess.HomeDirectory;

  // Reads only what the OS's own background check recorded; never starts a network check.
  const readOsUpdates = Effect.fn("HostResources.readOsUpdates")(function* (): Effect.fn.Return<
    Pick<HostResourcesSnapshot, "osUpdates" | "rebootRequired">
  > {
    if (platform === "darwin") {
      const json = yield* spawner
        .string(
          ChildProcess.make(
            "/usr/bin/plutil",
            [
              "-extract",
              "RecommendedUpdates",
              "json",
              "-o",
              "-",
              "/Library/Preferences/com.apple.SoftwareUpdate.plist",
            ],
            { stdin: "ignore", stderr: "ignore" },
          ),
        )
        .pipe(
          Effect.timeout("2 seconds"),
          Effect.orElseSucceed(() => ""),
        );
      const osUpdates = parseDarwinRecommendedUpdates(json);
      return osUpdates ? { osUpdates } : {};
    }
    if (platform === "linux") {
      const notifier = yield* fs
        .readFileString("/var/lib/update-notifier/updates-available")
        .pipe(Effect.orElseSucceed(() => ""));
      const osUpdates = parseUpdateNotifier(notifier);
      const rebootRequired = yield* fs
        .exists("/var/run/reboot-required")
        .pipe(Effect.orElseSucceed(() => false));
      return { ...(osUpdates ? { osUpdates } : {}), rebootRequired };
    }
    return {};
  });
  const osUpdatesCache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => readOsUpdates(),
    timeToLive: "10 minutes",
  });

  const readDisk = Effect.tryPromise({
    try: () => NodeFSP.statfs(homeDirectory, { bigint: true }),
    catch: (cause) => new HostDiskReadError({ cause }),
  }).pipe(
    Effect.timeout("1 second"),
    Effect.map(({ bavail, blocks, bsize }) => ({
      availableBytes: Number(bavail * bsize),
      totalBytes: Number(blocks * bsize),
    })),
    Effect.option,
  );

  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

  const sampleCpuAndMemory = Effect.fn("HostResources.sampleCpuAndMemory")(function* () {
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
      cpuUtilization,
      cpuCount,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
    };
  });

  const sample = Effect.fn("HostResources.sample")(function* () {
    const [cpuAndMemory, disk, osUpdates] = yield* Effect.all(
      [sampleCpuAndMemory(), readDisk, Cache.get(osUpdatesCache, "host")],
      { concurrency: "unbounded" },
    );
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      ...cpuAndMemory,
      ...(Option.isSome(disk) ? { disk: disk.value } : {}),
      ...osUpdates,
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
