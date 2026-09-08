import type { VolumeSnapshot as FlyVolumeSnapshot } from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { App } from "./App.ts";
import type { Providers } from "./Providers.ts";
import { listOwnedVolumes } from "./Volume.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface VolumeSnapshotProps {
  /**
   * Parent Fly App. Changing it replaces the snapshot (a new snapshot is
   * created on the new App's Volume). There is no delete API for the old
   * snapshot — it follows Volume `snapshot_retention`.
   */
  app: Ref<App>;
  /**
   * Fly Volume id to snapshot (`vol_…`). Changing it replaces the
   * snapshot. Identity is the snapshot `id` returned by a subsequent
   * `listVolumeSnapshots`.
   */
  volumeId: string;
}

export type VolumeSnapshot = Resource<
  "Fly.VolumeSnapshot",
  VolumeSnapshotProps,
  {
    /** Parent Fly App name. */
    appName: string;
    /** Fly Volume id this snapshot belongs to. */
    volumeId: string;
    /** Fly snapshot id (`vs_…`). Identity of the resource. */
    snapshotId: string;
    /** Observed snapshot status, if the API returned one. */
    status: string | undefined;
    /** Content digest of the snapshot. */
    digest: string | undefined;
    /** Snapshot size in bytes, if the API returned one. */
    size: number | undefined;
    /** Source volume size in GB at snapshot time. */
    volumeSize: number | undefined;
    /** Retention in days. */
    retentionDays: number | undefined;
    /** RFC3339 creation timestamp. */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Fly.VolumeSnapshot is an on-demand snapshot of a mounted disk.
 *
 * Create is fire-and-forget. Identity is the snapshot id from a
 * subsequent list. Destroy is a no-op. Snapshots follow Volume
 * retention. `nuke` skips this type.
 *
 * @see https://fly.io/docs/machines/api/volumes-resource/
 *
 * ### Create a snapshot
 * Point it at a Volume id from the parent {@link Machine} or
 * {@link Service} (`mounts[0].volumeId`).
 *
 * **Example:** Snapshot a mounted disk
 * ```typescript
 * const box = yield* Fly.Machine("Box", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   mounts: [{ path: "/data", sizeGb: 1 }],
 * });
 *
 * export const Nightly = Fly.VolumeSnapshot("Nightly", {
 *   app: Site,
 *   volumeId: box.mounts[0].volumeId,
 * });
 * ```
 *
 * :::caution[Changing `app` or `volumeId` replaces the snapshot]
 * A new snapshot is created. There is no delete API for the old one.
 * It follows Volume `snapshot_retention`.
 * :::
 *
 * ### Restore
 * Restore into a new disk with `snapshotId` on the mount. Create-only.
 * The new Machine gets a copy. The original Volume is unchanged.
 *
 * **Example:** Restore onto a Machine
 * ```typescript
 * const restored = yield* Fly.Machine("Restored", {
 *   app: Site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   mounts: [{ path: "/data", sizeGb: 1, snapshotId: Nightly.snapshotId }],
 * });
 * ```
 *
 * ### Restore into a Service
 * Pass `snapshotId` on {@link MountVolume}. Same create-only rule.
 *
 * **Example:** Restore onto a Service
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad", port: 3000 },
 *   Effect.gen(function* () {
 *     const disk = yield* Fly.MountVolume({
 *       path: "/data",
 *       sizeGb: 1,
 *       snapshotId: Nightly.snapshotId,
 *     });
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text(disk.path)),
 *     };
 *   }).pipe(Effect.provide(Fly.MountVolumeLive)),
 * ) {}
 * ```
 *
 * @resource
 */
export const VolumeSnapshot = Resource<VolumeSnapshot>("Fly.VolumeSnapshot");

export class VolumeSnapshotNotCreated extends Data.TaggedError(
  "Fly.VolumeSnapshotNotCreated",
)<{
  appName: string;
  volumeId: string;
}> {}

export class VolumeSnapshotRefsMissing extends Data.TaggedError(
  "Fly.VolumeSnapshotRefsMissing",
)<{
  message: string;
}> {}

class VolumeSnapshotPending extends Data.TaggedError(
  "Fly.VolumeSnapshotPending",
)<{
  volumeId: string;
}> {}

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const appNameOf = (value: unknown): string | undefined => {
  if (value == null || typeof value !== "object") return undefined;
  const name = (value as { appName?: unknown }).appName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const volumeIdOf = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (value == null || typeof value !== "object") return undefined;
  const id = (value as { volumeId?: unknown }).volumeId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

const toAttrs = (
  appName: string,
  volumeId: string,
  snapshot: FlyVolumeSnapshot,
): VolumeSnapshot["Attributes"] => ({
  appName,
  volumeId,
  snapshotId: snapshot.id ?? "",
  status: snapshot.status,
  digest: snapshot.digest,
  size: snapshot.size,
  volumeSize: snapshot.volume_size,
  retentionDays: snapshot.retention_days,
  createdAt: snapshot.created_at,
});

const listSnapshots = (appName: string, volumeId: string) =>
  machines
    .listVolumeSnapshots({
      app_name: appName,
      volume_id: volumeId,
    })
    .pipe(
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as FlyVolumeSnapshot[]),
      ),
    );

const findById = (appName: string, volumeId: string, snapshotId: string) =>
  listSnapshots(appName, volumeId).pipe(
    Effect.map((snapshots) =>
      snapshots.find((snapshot) => snapshot.id === snapshotId),
    ),
  );

const newestFirst = (left: FlyVolumeSnapshot, right: FlyVolumeSnapshot) =>
  Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? "");

const pickNewest = (
  snapshots: FlyVolumeSnapshot[],
): FlyVolumeSnapshot | undefined =>
  snapshots
    .filter((snapshot) => (snapshot.id ?? "").length > 0)
    .sort(newestFirst)[0];

const waitForNewSnapshot = (
  appName: string,
  volumeId: string,
  knownIds: ReadonlySet<string>,
) =>
  listSnapshots(appName, volumeId).pipe(
    Effect.flatMap((snapshots) => {
      const next = pickNewest(
        snapshots.filter(
          (snapshot) => snapshot.id !== undefined && !knownIds.has(snapshot.id),
        ),
      );
      if (next !== undefined) return Effect.succeed(next);
      return Effect.fail(new VolumeSnapshotPending({ volumeId }));
    }),
    Effect.retry({
      while: (e) => e._tag === "Fly.VolumeSnapshotPending",
      times: 8,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.VolumeSnapshotPending", () =>
      Effect.succeed(undefined),
    ),
  );

export const VolumeSnapshotProvider = () =>
  Provider.succeed(VolumeSnapshot, {
    stables: ["snapshotId", "volumeId", "appName"],
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredApp = appNameOf(news.app);
      const appChanged =
        desiredApp !== undefined && desiredApp !== output.appName;
      const desiredVolume = volumeIdOf(news.volumeId);
      const volumeChanged =
        desiredVolume !== undefined && desiredVolume !== output.volumeId;
      if (appChanged || volumeChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const appName = output?.appName ?? appNameOf(olds?.app);
      const volumeId = output?.volumeId ?? volumeIdOf(olds?.volumeId);
      if (appName === undefined || volumeId === undefined) return undefined;
      const snapshotId = output?.snapshotId;
      if (snapshotId === undefined || snapshotId.length === 0) {
        return undefined;
      }
      const found = yield* findById(appName, volumeId, snapshotId);
      if (found === undefined) return undefined;
      return toAttrs(appName, volumeId, found);
    }),

    list: Effect.fn(function* () {
      const volumes = yield* listOwnedVolumes();
      const groups = yield* Effect.forEach(
        volumes,
        ({ appName, volumeId }) =>
          listSnapshots(appName, volumeId).pipe(
            Effect.map((snapshots) =>
              snapshots
                .filter(
                  (snapshot) =>
                    snapshot.id !== undefined && snapshot.id.length > 0,
                )
                .map((snapshot) => toAttrs(appName, volumeId, snapshot)),
            ),
          ),
        { concurrency: 8 },
      );
      return groups.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const props = news ?? ({} as VolumeSnapshotProps);
      const appName = appNameOf(props.app) ?? output?.appName;
      const volumeId = volumeIdOf(props.volumeId) ?? output?.volumeId;
      if (appName === undefined || volumeId === undefined) {
        return yield* new VolumeSnapshotRefsMissing({
          message:
            "Fly.VolumeSnapshot requires a resolved App with appName and a volumeId.",
        });
      }

      // Observe by cached snapshot id on the target volume.
      const observed = yield* listSnapshots(appName, volumeId);
      let current =
        output?.snapshotId !== undefined && output.snapshotId.length > 0
          ? observed.find((snapshot) => snapshot.id === output.snapshotId)
          : undefined;

      if (current === undefined) {
        const knownIds = new Set(
          observed.flatMap((snapshot) =>
            snapshot.id !== undefined && snapshot.id.length > 0
              ? [snapshot.id]
              : [],
          ),
        );
        yield* machines
          .createVolumeSnapshot({
            app_name: appName,
            volume_id: volumeId,
          })
          .pipe(
            Effect.asVoid,
            Effect.catchTag("Conflict", () => Effect.void),
            Effect.retry({
              while: (e) =>
                e._tag === "NotFound" ||
                (e._tag === "BadRequest" &&
                  e.message.includes("uninitialized volume")),
              times: 8,
              schedule: backoff,
            }),
          );
        current = yield* waitForNewSnapshot(appName, volumeId, knownIds);
      }

      if (current === undefined || current.id === undefined) {
        return yield* new VolumeSnapshotNotCreated({ appName, volumeId });
      }

      return toAttrs(appName, volumeId, current);
    }),

    delete: Effect.fn(function* () {
      // Fly has no snapshot delete API. Snapshots expire with Volume
      // snapshot_retention or when the Volume is deleted.
    }),
  });
