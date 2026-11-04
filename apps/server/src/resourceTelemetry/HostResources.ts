// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect FileSystem has no statfs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
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

const decodeRecommendedUpdates = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        "Display Name": Schema.optionalKey(Schema.String),
        "Display Version": Schema.optionalKey(Schema.String),
      }),
    ),
  ),
);

/** `RecommendedUpdates` from com.apple.SoftwareUpdate.plist, as `plutil -extract ... json`. */
export function parseDarwinRecommendedUpdates(json: string): OsUpdates | undefined {
  const entries = Option.getOrUndefined(decodeRecommendedUpdates(json));
  if (!entries) return undefined;
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

  const readDisk = Effect.tryPromise(() => NodeFSP.statfs(homeDirectory, { bigint: true })).pipe(
    Effect.timeout("1 second"),
    Effect.map(({ bavail, blocks, bsize }) => ({
      availableBytes: Number(bavail * bsize),
      totalBytes: Number(blocks * bsize),
    })),
    Effect.option,
  );

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    yield* Effect.sleep("200 millis");
    const cpu = readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
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
    const disk = yield* readDisk;
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      ...(Option.isSome(disk) ? { disk: disk.value } : {}),
      ...(yield* Cache.get(osUpdatesCache, "host")),
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
