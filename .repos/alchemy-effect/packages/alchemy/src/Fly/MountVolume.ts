import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";

/**
 * Spec for a per-replica Fly disk. Fly Volumes cannot be shared —
 * `count` Machines get `count` Volumes in one name-group.
 */
export interface DiskSpec {
  /**
   * Absolute path inside the Machine the disk is mounted at
   * (e.g. `/data`).
   */
  path: string;
  /**
   * Size in GB. Fly minimum is 1. Increasing size updates in place
   * via `extendVolume`. Fly cannot shrink a Volume.
   */
  sizeGb: number;
  /**
   * Encrypt the Volume at rest. Create-only.
   */
  encrypted?: boolean;
  /**
   * Filesystem type (`ext4`, …). Create-only.
   */
  fstype?: string;
  /**
   * Enable scheduled automatic snapshots.
   *
   * @default true
   */
  autoBackupEnabled?: boolean;
  /**
   * Snapshot retention in days. Updated in place via `updateVolume`.
   */
  snapshotRetention?: number;
  /**
   * Restore from an existing snapshot. Create-only.
   */
  snapshotId?: string;
  /**
   * Fork from an existing volume. Create-only.
   */
  sourceVolumeId?: string;
  /**
   * Require the Volume to land in a unique zone. Create-only.
   */
  requireUniqueZone?: boolean;
  /**
   * Fly volume-group name. If omitted, a unique name is generated
   * from the host's logical ID and {@link path}.
   */
  name?: string;
}

export interface MountVolumeOptions extends DiskSpec {}

/**
 * Runtime view of a disk mounted into a {@link Service}: the path
 * inside the Machine.
 */
export interface MountedVolume {
  /** Mount path inside the Machine (same value as {@link DiskSpec.path}). */
  path: string;
}

/**
 * Observed disk attached to a Machine / Service replica.
 */
export interface MountedDisk {
  /** Mount path inside the Machine. */
  path: string;
  /** Fly Volume id. */
  volumeId: string;
  /** Size in GB. */
  sizeGb: number;
  /** Fly volume-group name. */
  name: string;
}

const isBindHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

/**
 * Binding contract accepted by {@link Service} (and Machine) for mounted
 * disks and injected env.
 */
export interface ServiceBinding {
  env?: Record<string, any>;
  mounts?: DiskSpec[];
  /**
   * Upstash Redis add-on to attach. Redis HTTP bindings write
   * `REDIS_URL` as an App secret during Service reconcile.
   */
  redis?: { name: string; id?: string };
  /**
   * Tigris bucket to attach. Object HTTP bindings write `AWS_*` /
   * `BUCKET_NAME` as App secrets during Service reconcile.
   */
  bucket?: { name: string; id?: string };
  /**
   * Managed Postgres cluster to attach. `Fly.ConnectPostgres` packs
   * the cluster's connection URI Outputs into the host and records
   * the MPG attachment during Service reconcile.
   */
  postgres?: { clusterId: string; variableName?: string };
}

/**
 * Create a per-replica Fly Volume and mount it into a {@link Service}.
 *
 * There is no standalone Volume resource. From a {@link Machine}, pass
 * `mounts: [{ path, sizeGb }]` instead.
 *
 *
 * ### Mount into a Service
 * Yield `MountVolume` inside init. App and region come from the
 * parent Service. Provide {@link MountVolumeLive}. At runtime you get
 * `disk.path`.
 *
 * A Volume attaches to one Machine. `count: 3` creates three Volumes
 * in one name-group, one per replica.
 *
 * **Example:** Bind a path
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad", count: 3, port: 3000 },
 *   Effect.gen(function* () {
 *     const disk = yield* Fly.MountVolume({ path: "/data", sizeGb: 1 });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const text = yield* fs.readFileString(`${disk.path}/hello.txt`);
 *         return HttpServerResponse.text(text);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.MountVolumeLive)),
 * ) {}
 * ```
 *
 * ### Grow a disk
 * `sizeGb` can grow in place via `extendVolume`. Fly cannot shrink a
 * Volume. Minimum size is 1 GB.
 *
 * **Example:** 10 GB
 * ```typescript
 * const disk = yield* Fly.MountVolume({ path: "/data", sizeGb: 10 });
 * ```
 *
 * ### Encryption
 * `encrypted` encrypts the Volume at rest.
 *
 * **Example:** Encrypted
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   encrypted: true,
 * });
 * ```
 *
 * :::note[Create-only]
 * Flipping `encrypted` later is ignored.
 * :::
 *
 * ### Filesystem
 * `fstype` is the filesystem (`ext4`, …).
 *
 * **Example:** ext4
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   fstype: "ext4",
 * });
 * ```
 *
 * :::note[Create-only]
 * Flipping `fstype` later is ignored.
 * :::
 *
 * ### Scheduled snapshots
 * Scheduled snapshots default on (`autoBackupEnabled`).
 * `snapshotRetention` is days and updates in place. An on-demand
 * snapshot is {@link VolumeSnapshot}.
 *
 * **Example:** Retention
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   autoBackupEnabled: true,
 *   snapshotRetention: 5,
 * });
 * ```
 *
 * ### Restore from a snapshot
 * `snapshotId` restores into a new disk.
 *
 * **Example:** snapshotId
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   snapshotId: Nightly.snapshotId,
 * });
 * ```
 *
 * :::note[Create-only]
 * Changing `snapshotId` later is ignored.
 * :::
 *
 * ### Fork a volume
 * `sourceVolumeId` forks from an existing Volume.
 *
 * **Example:** sourceVolumeId
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   sourceVolumeId: box.mounts[0].volumeId,
 * });
 * ```
 *
 * :::note[Create-only]
 * Changing `sourceVolumeId` later is ignored.
 * :::
 *
 * ### Unique zone
 * `requireUniqueZone` asks Fly to land the Volume in a unique zone.
 *
 * **Example:** Unique zone
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   requireUniqueZone: true,
 * });
 * ```
 *
 * :::note[Create-only]
 * Flipping `requireUniqueZone` later is ignored.
 * :::
 *
 * ### Volume name
 * `name` is the Fly volume-group name. If omitted, a unique name is
 * generated from the host's logical ID and `path`.
 *
 * **Example:** Named group
 * ```typescript
 * const disk = yield* Fly.MountVolume({
 *   path: "/data",
 *   sizeGb: 1,
 *   name: "api_data",
 * });
 * ```
 *
 * @binding
 */
export interface MountVolume extends Binding.Service<
  MountVolume,
  "Fly.MountVolume",
  (options: MountVolumeOptions) => Effect.Effect<MountedVolume>
> {}

export const MountVolume = Binding.Service<MountVolume>("Fly.MountVolume");

export const MountVolumeLive = Layer.effect(
  MountVolume,
  Effect.succeed(
    Effect.fn(function* (options: MountVolumeOptions) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindHost(host)) {
          yield* host.bind`Fly.MountVolume(${options.path})`({
            mounts: [options],
          });
        }
      }
      return { path: options.path };
    }),
  ),
);
