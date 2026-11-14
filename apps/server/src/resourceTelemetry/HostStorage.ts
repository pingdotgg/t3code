// @effect-diagnostics nodeBuiltinImport:off
// Effect's FileSystem has no statfs.
import * as NodeFSP from "node:fs/promises";
import type {
  HostStorage as HostStorageSnapshot,
  HostVolume,
  HostVolumeRole,
  ResourceMonitorHostDisk,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

export interface HostStorageReading {
  readonly storage: HostStorageSnapshot;
  readonly swap?: { readonly totalBytes: number; readonly usedBytes: number };
}

export class HostStorage extends Context.Service<
  HostStorage,
  { readonly read: Effect.Effect<HostStorageReading> }
>()("t3/resourceTelemetry/HostStorage") {}

class HostStatfsFailed extends Schema.TaggedError<HostStatfsFailed>()("HostStatfsFailed", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface VolumeTarget {
  readonly role: HostVolumeRole;
  /** Real path, so symlinked homes resolve to the volume that stores them. */
  readonly path: string;
}

// Volumes change slowly; slow filesystems must not make each 5 s poll another statfs walk.
const FRESH_MS = 15_000;
const READ_DEADLINE = "3 seconds";

const PSEUDO_FILE_SYSTEMS = new Set([
  "autofs",
  "devfs",
  "devtmpfs",
  "efivarfs",
  "nullfs",
  "overlay",
  "ramfs",
  "squashfs",
  "tmpfs",
]);

// Mounts the OS manages for itself; they share free space with a user volume or hold no user data.
function isSystemMount(mountPoint: string, platform: NodeJS.Platform): boolean {
  if (platform === "darwin") {
    return (
      (mountPoint.startsWith("/System/Volumes/") && mountPoint !== "/System/Volumes/Data") ||
      mountPoint.startsWith("/private/var/") ||
      mountPoint.startsWith("/Library/Developer/CoreSimulator/")
    );
  }
  if (platform === "linux") {
    return (
      mountPoint === "/boot" ||
      mountPoint.startsWith("/boot/") ||
      mountPoint.startsWith("/snap/") ||
      mountPoint.startsWith("/var/lib/docker/") ||
      mountPoint.startsWith("/var/snap/")
    );
  }
  return false;
}

function containsPath(mountPoint: string, target: string, platform: NodeJS.Platform): boolean {
  const separator = platform === "win32" ? "\\" : "/";
  const normalize = (value: string) =>
    platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
  const mount = normalize(mountPoint);
  const path = normalize(target);
  const prefix = mount.endsWith(separator) ? mount : `${mount}${separator}`;
  return path === mount || path.startsWith(prefix);
}

/**
 * Keeps one entry per user-relevant volume. APFS lists the read-only system snapshot and the
 * Data volume of one container separately with identical capacity, so equal name, filesystem
 * and size collapse into one entry that shows the writable member.
 */
export function selectHostVolumes(
  disks: ReadonlyArray<ResourceMonitorHostDisk>,
  targets: ReadonlyArray<VolumeTarget>,
  platform: NodeJS.Platform,
): ReadonlyArray<HostVolume> {
  const rolesByDisk = new Map<ResourceMonitorHostDisk, Set<HostVolumeRole>>();
  for (const target of targets) {
    const holder = disks
      .filter((disk) => containsPath(disk.mountPoint, target.path, platform))
      .reduce<ResourceMonitorHostDisk | null>(
        (best, disk) =>
          best === null || disk.mountPoint.length > best.mountPoint.length ? disk : best,
        null,
      );
    if (holder) rolesByDisk.set(holder, (rolesByDisk.get(holder) ?? new Set()).add(target.role));
  }

  const groups = new Map<
    string,
    { members: ResourceMonitorHostDisk[]; roles: Set<HostVolumeRole> }
  >();
  for (const disk of disks) {
    const roles = rolesByDisk.get(disk);
    const relevant =
      roles !== undefined ||
      (disk.totalBytes > 0 &&
        !disk.readOnly &&
        !PSEUDO_FILE_SYSTEMS.has(disk.fileSystem.toLowerCase()) &&
        !isSystemMount(disk.mountPoint, platform));
    if (!relevant) continue;
    const key = `${disk.name}\0${disk.fileSystem}\0${disk.totalBytes}`;
    const group = groups.get(key) ?? { members: [], roles: new Set() };
    group.members.push(disk);
    for (const role of roles ?? []) group.roles.add(role);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map(({ members, roles }) => {
      const shown =
        members.find((disk) => !disk.readOnly) ??
        members.reduce((best, disk) =>
          disk.mountPoint.length < best.mountPoint.length ? disk : best,
        );
      return {
        mountPoint: shown.mountPoint,
        name: shown.name,
        fileSystem: shown.fileSystem,
        totalBytes: shown.totalBytes,
        availableBytes: Math.min(shown.availableBytes, shown.totalBytes),
        roles: (["t3Home", "worktrees"] as const).filter((role) => roles.has(role)),
      };
    })
    .toSorted(
      (left, right) =>
        right.roles.length - left.roles.length || left.mountPoint.localeCompare(right.mountPoint),
    );
}

const make = Effect.fn("makeHostStorage")(function* () {
  const native = yield* NativeTelemetryClient.NativeTelemetryClient;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;

  const realPath = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => target));

  const targets = Effect.gen(function* () {
    const worktreesSetting = yield* settings.getSettings.pipe(
      Effect.map((current) => current.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    const worktrees =
      resolveWorktreesDirectory(worktreesSetting, config.worktreesDir, path, home) ??
      config.worktreesDir;
    return [
      { role: "t3Home" as const, path: yield* realPath(config.baseDir) },
      { role: "worktrees" as const, path: yield* realPath(worktrees) },
    ];
  });

  // Without the native monitor, statfs still covers the volumes T3 writes to.
  const statfsFallback = (current: ReadonlyArray<VolumeTarget>, reason: string) =>
    Effect.forEach(current, (target) =>
      Effect.all({
        device: fs.stat(target.path).pipe(Effect.map((info) => info.dev)),
        stats: Effect.tryPromise({
          try: () => NodeFSP.statfs(target.path),
          catch: (cause) => new HostStatfsFailed({ path: target.path, cause }),
        }),
      }).pipe(
        Effect.map(({ device, stats }) => ({ target, device, stats })),
        Effect.option,
      ),
    ).pipe(
      Effect.map((results): HostStorageReading => {
        const byDevice = new Map<bigint, HostVolume>();
        for (const { target, device, stats } of results.flatMap(Option.toArray)) {
          const existing = byDevice.get(device);
          if (existing) {
            byDevice.set(device, { ...existing, roles: [...existing.roles, target.role] });
            continue;
          }
          const totalBytes = stats.blocks * stats.bsize;
          byDevice.set(device, {
            mountPoint: target.path,
            name: "",
            fileSystem: "",
            totalBytes,
            availableBytes: Math.min(totalBytes, stats.bavail * stats.bsize),
            roles: [target.role],
          });
        }
        return {
          storage: { sampledAt: 0, volumes: [...byDevice.values()], unavailableReason: reason },
        };
      }),
    );

  const sample = Effect.fn("HostStorage.sample")(function* () {
    const current = yield* targets;
    const reading = yield* native.hostSystem.pipe(
      Effect.map((system): HostStorageReading => ({
        storage: { sampledAt: 0, volumes: selectHostVolumes(system.disks, current, platform) },
        swap: { totalBytes: system.swapTotalBytes, usedBytes: system.swapUsedBytes },
      })),
      Effect.catch((error) =>
        statfsFallback(current, `Only T3 volumes are shown: ${error.message}`),
      ),
    );
    const sampledAt = DateTime.toEpochMillis(yield* DateTime.now);
    return { ...reading, storage: { ...reading.storage, sampledAt } };
  });

  const scope = yield* Effect.scope;
  const last = yield* Ref.make<Option.Option<HostStorageReading>>(Option.none());
  const inFlight = yield* Ref.make<Option.Option<Fiber.Fiber<HostStorageReading>>>(Option.none());
  const startRefresh = Effect.uninterruptible(
    Effect.gen(function* () {
      const running = yield* Ref.get(inFlight);
      if (Option.isSome(running)) return running.value;
      const fiber = yield* sample().pipe(
        Effect.tap((reading) => Ref.set(last, Option.some(reading))),
        Effect.ensuring(Ref.set(inFlight, Option.none())),
        Effect.forkIn(scope),
      );
      yield* Ref.set(inFlight, Option.some(fiber));
      return fiber;
    }),
  );

  // The refresh runs in the layer scope, so a stalled mount finishes in the background while
  // callers past the deadline get the last reading instead of waiting.
  const read = Effect.gen(function* () {
    const previous = yield* Ref.get(last);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (Option.isSome(previous) && now - previous.value.storage.sampledAt < FRESH_MS) {
      return previous.value;
    }
    const fiber = yield* startRefresh;
    const reading = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(READ_DEADLINE));
    if (Option.isSome(reading)) return reading.value;
    return Option.getOrElse(previous, () => ({
      storage: { sampledAt: now, volumes: [], unavailableReason: "Reading volumes timed out." },
    }));
  });

  return HostStorage.of({ read });
});

export const layer = Layer.effect(HostStorage, make());
