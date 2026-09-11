// @effect-diagnostics nodeBuiltinImport:off - Effect FileSystem has no free-space query.
import * as NodeFSP from "node:fs/promises";
import type * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import {
  HostStorageSnapshot,
  type HostResourcesSnapshot,
  type HostStorageResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";

export class HostStorageError extends Schema.TaggedError<HostStorageError>()("HostStorageError", {
  cause: Schema.Defect(),
}) {}

type StorageStats = Pick<NodeFS.BigIntStatsFs, "blocks" | "bavail" | "bsize">;

/** A timed-out caller must not start another uncancellable statfs on the same filesystem. */
export function makeHostStorageStatFs(
  read: (path: string) => Promise<StorageStats> = (path) => NodeFSP.statfs(path, { bigint: true }),
) {
  const pending = new Map<string, Promise<StorageStats>>();
  return (path: string) =>
    Effect.tryPromise({
      try: () => {
        const current = pending.get(path);
        if (current) return current;
        const next = read(path).finally(() => pending.delete(path));
        pending.set(path, next);
        return next;
      },
      catch: (cause) => new HostStorageError({ cause }),
    });
}

export const HostStorageStatFs = Context.Reference<ReturnType<typeof makeHostStorageStatFs>>(
  "t3/resourceTelemetry/HostStorageStatFs",
  { defaultValue: makeHostStorageStatFs },
);

const decodeStorage = Schema.decodeUnknownEffect(HostStorageSnapshot);

export class HostResources extends Context.Service<
  HostResources,
  {
    readonly read: Effect.Effect<HostResourcesSnapshot>;
    readonly readStorage: Effect.Effect<HostStorageResult>;
  }
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
  // vm_stat subtracts speculative pages from its printed "Pages free" count.
  // Adding them here counts each reclaimable page once; purgeable pages overlap.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

export const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { stateDir } = yield* ServerConfig;
  const statfs = yield* HostStorageStatFs;

  const sampleStorage = Effect.fn("HostResources.sampleStorage")(
    function* () {
      const stats = yield* statfs(stateDir);
      if (stats.bsize <= 0n) return null;
      return yield* decodeStorage({
        totalBytes: Number(stats.blocks * stats.bsize),
        availableBytes: Number(stats.bavail * stats.bsize),
      });
    },
    Effect.timeout("1 second"),
    Effect.catch(() => Effect.succeed(null)),
  );

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    // CPU counters need two readings; idle servers do no polling or process scans.
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
        .pipe(Effect.catch(() => Effect.succeed("")));
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
    } else if (platform === "darwin") {
      const output = yield* spawner
        .string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.catch(() => Effect.succeed("")),
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

  // One server-lifetime cache deduplicates simultaneous requests from all sockets.
  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({
    read: Cache.get(cache, "host"),
    // Settings reads storage on demand. Keep it independent of load balancing and
    // uncached so an explicit refresh always checks the filesystem again.
    readStorage: Effect.gen(function* () {
      const storage = yield* sampleStorage();
      return { sampledAt: DateTime.toEpochMillis(yield* DateTime.now), storage };
    }),
  });
});

export const layer = Layer.effect(HostResources, make());
