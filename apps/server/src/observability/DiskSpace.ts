// @effect-diagnostics nodeBuiltinImport:off
// Effect's FileSystem has no statfs.
import * as NodeFSP from "node:fs/promises";

import {
  diskSpaceLevelSeverity,
  nextDiskSpaceLevel,
  type DiskSpaceLevel,
  type HostVolumeRole,
  type ServerDiskSpace,
  type ServerDiskSpaceVolume,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";

// Disks fill over minutes to hours, and statfs is one syscall per directory.
const SAMPLE_INTERVAL = "5 minutes";

class DiskSpaceStatfsFailed extends Schema.TaggedError<DiskSpaceStatfsFailed>()(
  "DiskSpaceStatfsFailed",
  { path: Schema.String, cause: Schema.Defect() },
) {}

export interface DiskSpaceTarget {
  readonly role: HostVolumeRole;
  readonly path: string;
}

export interface DiskSpaceReading {
  readonly path: string;
  readonly roles: ReadonlyArray<HostVolumeRole>;
  readonly availableBytes: number;
  readonly totalBytes: number;
}

export const EMPTY_DISK_SPACE: ServerDiskSpace = { level: "ok", volumes: [] };

const volumeKey = (roles: ReadonlyArray<HostVolumeRole>) => roles.join(",");

/** Folds a new reading into the previous state; a volume that could not be read keeps its level. */
export function applyDiskSpaceReadings(
  previous: ServerDiskSpace,
  readings: ReadonlyArray<DiskSpaceReading>,
): ServerDiskSpace {
  if (readings.length === 0) return previous;
  const previousLevels = new Map(
    previous.volumes.map((volume) => [volumeKey(volume.roles), volume.level]),
  );
  const volumes: Array<ServerDiskSpaceVolume> = [];
  let level: DiskSpaceLevel = "ok";
  for (const reading of readings) {
    const volumeLevel = nextDiskSpaceLevel(
      previousLevels.get(volumeKey(reading.roles)) ?? "ok",
      reading,
    );
    if (volumeLevel === "ok") continue;
    volumes.push({
      path: reading.path,
      roles: reading.roles,
      level: volumeLevel,
      availableBytes: reading.availableBytes,
      totalBytes: reading.totalBytes,
    });
    if (diskSpaceLevelSeverity(volumeLevel) > diskSpaceLevelSeverity(level)) level = volumeLevel;
  }
  return { level, volumes };
}

/** Clients are told only when a level changes; byte counts alone never push an update. */
export function sameDiskSpaceLevels(left: ServerDiskSpace, right: ServerDiskSpace): boolean {
  return (
    left.level === right.level &&
    left.volumes.length === right.volumes.length &&
    left.volumes.every(
      (volume, index) =>
        volume.level === right.volumes[index]?.level &&
        volumeKey(volume.roles) === volumeKey(right.volumes[index]?.roles ?? []),
    )
  );
}

/** One statfs per directory; directories on the same device collapse into one reading. */
export const readDiskSpace = Effect.fn("DiskSpace.read")(function* (
  targets: ReadonlyArray<DiskSpaceTarget>,
) {
  const fs = yield* FileSystem.FileSystem;
  const results = yield* Effect.forEach(targets, (target) =>
    Effect.all({
      device: fs.stat(target.path).pipe(Effect.map((info) => info.dev)),
      stats: Effect.tryPromise({
        try: () => NodeFSP.statfs(target.path),
        catch: (cause) => new DiskSpaceStatfsFailed({ path: target.path, cause }),
      }),
    }).pipe(
      Effect.map(({ device, stats }) => ({ target, device, stats })),
      Effect.option,
    ),
  );
  const byDevice = new Map<bigint, DiskSpaceReading>();
  for (const { target, device, stats } of results.flatMap(Option.toArray)) {
    const existing = byDevice.get(device);
    if (existing) {
      byDevice.set(device, { ...existing, roles: [...existing.roles, target.role] });
      continue;
    }
    const totalBytes = stats.blocks * stats.bsize;
    byDevice.set(device, {
      path: target.path,
      roles: [target.role],
      totalBytes,
      availableBytes: Math.min(totalBytes, stats.bavail * stats.bsize),
    });
  }
  return [...byDevice.values()];
});

interface DiskSpaceService {
  /** The latest reading, byte counts included; levels carry hysteresis. */
  readonly current: Effect.Effect<ServerDiskSpace>;
  /** The current value, then each level change. */
  readonly streamChanges: Stream.Stream<ServerDiskSpace>;
}

// A Reference so harnesses that build ws.ts without it get a disk that never warns.
export class DiskSpace extends Context.Reference<DiskSpaceService>("t3/observability/DiskSpace", {
  defaultValue: () => ({
    current: Effect.succeed(EMPTY_DISK_SPACE),
    streamChanges: Stream.make(EMPTY_DISK_SPACE),
  }),
}) {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;

  const targets = Effect.gen(function* () {
    const setting = yield* settings.getSettings.pipe(
      Effect.map((current) => current.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    const worktrees =
      resolveWorktreesDirectory(setting, config.worktreesDir, path, home) ?? config.worktreesDir;
    // The worktrees directory may not exist yet; its parent is on the same volume.
    const existing = (target: string) =>
      fs.exists(target).pipe(
        Effect.orElseSucceed(() => false),
        Effect.map((exists) => (exists ? target : path.dirname(target))),
      );
    return [
      { role: "t3Home" as const, path: config.baseDir },
      { role: "worktrees" as const, path: yield* existing(worktrees) },
    ];
  });

  let latest = EMPTY_DISK_SPACE;
  const published = yield* SubscriptionRef.make(EMPTY_DISK_SPACE);

  const sample = Effect.gen(function* () {
    latest = applyDiskSpaceReadings(latest, yield* readDiskSpace(yield* targets));
    const current = yield* SubscriptionRef.get(published);
    if (!sameDiskSpaceLevels(current, latest)) {
      yield* SubscriptionRef.set(published, latest);
      yield* Effect.logInfo("Disk space level changed.").pipe(
        Effect.annotateLogs({ level: latest.level }),
      );
    }
  }).pipe(Effect.withSpan("DiskSpace.sample"), Effect.ignoreCause({ log: true }));

  yield* sample.pipe(Effect.repeat(Schedule.spaced(SAMPLE_INTERVAL)), Effect.forkScoped);

  return {
    current: Effect.sync(() => latest),
    streamChanges: SubscriptionRef.changes(published),
  } satisfies DiskSpaceService;
});

export const layer = Layer.effect(DiskSpace, make);
