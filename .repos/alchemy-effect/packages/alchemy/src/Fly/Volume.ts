import type { Volume as FlyVolume } from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { listOwnedApps } from "./App.ts";
import {
  createFlyVolumeName,
  matchesAlchemyPhysicalName,
  sanitizeFlyVolumeName,
} from "./Metadata.ts";
import type { DiskSpec } from "./MountVolume.ts";

export const DEFAULT_VOLUME_REGION = "iad";
export const MIN_SIZE_GB = 1;

export class VolumeNotCreated extends Data.TaggedError("Fly.VolumeNotCreated")<{
  name: string;
  appName: string;
}> {}

class VolumePending extends Data.TaggedError("Fly.VolumePending")<{
  volumeId: string;
  state: string;
}> {}

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

export const destroying = (state: string | undefined) =>
  state === "destroyed" ||
  state === "pending_destroy" ||
  state === "scheduled_for_destruction";

const transientState = (state: string | undefined) =>
  state === "creating" || state === "pending" || state === "extending";

export const getVolumeById = (appName: string, volumeId: string) =>
  machines.getVolumeById({ app_name: appName, volume_id: volumeId }).pipe(
    Effect.map((volume) => (destroying(volume.state) ? undefined : volume)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const listVolumesByApp = (appName: string) =>
  machines.listVolumes({ app_name: appName }).pipe(
    Effect.map((volumes) =>
      volumes.filter((volume) => !destroying(volume.state)),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])),
  );

const newestFirst = (left: FlyVolume, right: FlyVolume) => {
  const byCreated =
    Date.parse(left.created_at ?? "") - Date.parse(right.created_at ?? "");
  if (byCreated !== 0) return byCreated;
  return (left.id ?? "").localeCompare(right.id ?? "");
};

export const listVolumeGroup = (
  appName: string,
  name: string,
  region: string,
) =>
  listVolumesByApp(appName).pipe(
    Effect.map((volumes) =>
      volumes
        .filter((volume) => volume.name === name && volume.region === region)
        .sort(newestFirst),
    ),
  );

export const waitUntilVolumeReady = (appName: string, volumeId: string) =>
  getVolumeById(appName, volumeId).pipe(
    Effect.flatMap((volume) => {
      if (volume === undefined) return Effect.succeed(undefined);
      if (transientState(volume.state)) {
        return Effect.fail(
          new VolumePending({
            volumeId,
            state: volume.state ?? "creating",
          }),
        );
      }
      return Effect.succeed(volume);
    }),
    Effect.retry({
      while: (e) => e._tag === "Fly.VolumePending",
      times: 8,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.VolumePending", () =>
      getVolumeById(appName, volumeId),
    ),
  );

export const waitUntilVolumeGone = (appName: string, volumeId: string) =>
  getVolumeById(appName, volumeId).pipe(
    Effect.map((volume) => volume === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (gone) => gone,
      times: 10,
    }),
  );

export const pathKey = (path: string): string => {
  const key = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key.length === 0 ? "data" : key;
};

export const volumeGroupName = (
  id: string,
  disk: Pick<DiskSpec, "path" | "name">,
) =>
  Effect.gen(function* () {
    if (disk.name !== undefined) return sanitizeFlyVolumeName(disk.name);
    return yield* createFlyVolumeName(`${id}/${pathKey(disk.path)}`);
  });

export const createVolume = Effect.fn(function* (input: {
  appName: string;
  name: string;
  region: string;
  disk: DiskSpec;
}) {
  const sizeGb = Math.max(input.disk.sizeGb, MIN_SIZE_GB);
  const created = yield* machines
    .createVolume({
      app_name: input.appName,
      name: input.name,
      region: input.region,
      size_gb: sizeGb,
      encrypted: input.disk.encrypted,
      fstype: input.disk.fstype,
      auto_backup_enabled: input.disk.autoBackupEnabled,
      snapshot_retention: input.disk.snapshotRetention,
      snapshot_id: input.disk.snapshotId,
      source_volume_id: input.disk.sourceVolumeId,
      require_unique_zone: input.disk.requireUniqueZone,
    })
    .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
  if (created?.id !== undefined && created.id.length > 0) {
    return (yield* waitUntilVolumeReady(input.appName, created.id)) ?? created;
  }
  const group = yield* listVolumeGroup(input.appName, input.name, input.region);
  const hit = group.at(-1);
  if (hit === undefined || hit.id === undefined) {
    return yield* new VolumeNotCreated({
      name: input.name,
      appName: input.appName,
    });
  }
  return (yield* waitUntilVolumeReady(input.appName, hit.id)) ?? hit;
});

export const syncVolume = Effect.fn(function* (
  appName: string,
  volume: FlyVolume,
  disk: DiskSpec,
) {
  const volumeId = volume.id;
  if (volumeId === undefined || volumeId.length === 0) return volume;
  let current = volume;
  const sizeGb = Math.max(disk.sizeGb, MIN_SIZE_GB);
  const observedSize = current.size_gb ?? 0;
  if (sizeGb > observedSize) {
    const extended = yield* machines.extendVolume({
      app_name: appName,
      volume_id: volumeId,
      size_gb: sizeGb,
    });
    current =
      extended.volume ??
      (yield* waitUntilVolumeReady(appName, volumeId)) ??
      current;
  }

  const backupChanged =
    disk.autoBackupEnabled !== undefined &&
    disk.autoBackupEnabled !== current.auto_backup_enabled;
  const retentionChanged =
    disk.snapshotRetention !== undefined &&
    disk.snapshotRetention !== current.snapshot_retention;
  if (backupChanged || retentionChanged) {
    current = yield* machines.updateVolume({
      app_name: appName,
      volume_id: volumeId,
      auto_backup_enabled: disk.autoBackupEnabled,
      snapshot_retention: disk.snapshotRetention,
    });
  }
  return current;
});

/**
 * Observe-ensure-sync a Fly volume group (`name` shared, `count`
 * independent volumes). Extras are left in place for the caller to
 * delete after the Machines that mount them are gone.
 */
export const ensureVolumeGroup = Effect.fn(function* (input: {
  appName: string;
  name: string;
  region: string;
  count: number;
  disk: DiskSpec;
  preferIds?: readonly string[];
}) {
  const prefer = new Set((input.preferIds ?? []).filter((id) => id.length > 0));
  let group = yield* listVolumeGroup(input.appName, input.name, input.region);
  const preferred = group.filter(
    (volume) => volume.id !== undefined && prefer.has(volume.id),
  );
  const rest = group.filter(
    (volume) => volume.id === undefined || !prefer.has(volume.id),
  );
  group = [...preferred, ...rest];

  let attempts = 0;
  while (group.length < input.count && attempts < input.count + 3) {
    attempts += 1;
    const created = yield* createVolume({
      appName: input.appName,
      name: input.name,
      region: input.region,
      disk: input.disk,
    });
    if (
      created.id !== undefined &&
      !group.some((volume) => volume.id === created.id)
    ) {
      group.push(created);
    } else {
      group = yield* listVolumeGroup(input.appName, input.name, input.region);
    }
  }
  if (group.length < input.count) {
    return yield* new VolumeNotCreated({
      name: input.name,
      appName: input.appName,
    });
  }

  const kept = group.slice(0, input.count);
  const extras = group.slice(input.count);
  const synced: FlyVolume[] = [];
  for (const volume of kept) {
    synced.push(yield* syncVolume(input.appName, volume, input.disk));
  }
  return { volumes: synced, extras };
});

export const deleteVolume = Effect.fn(function* (
  appName: string,
  volumeId: string,
) {
  if (appName.length === 0 || volumeId.length === 0) return;
  yield* machines
    .deleteVolume({
      app_name: appName,
      volume_id: volumeId,
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.retry({
        while: (e) => e._tag === "Conflict",
        times: 8,
        schedule: backoff,
      }),
    );
  yield* waitUntilVolumeGone(appName, volumeId);
});

export const listOwnedVolumes = Effect.fn(function* () {
  const apps = yield* listOwnedApps();
  const groups = yield* Effect.forEach(
    apps,
    (app) =>
      listVolumesByApp(app.appName).pipe(
        Effect.map((volumes) =>
          volumes.flatMap((volume) => {
            if (!matchesAlchemyPhysicalName(volume.name)) return [];
            const volumeId = volume.id;
            if (volumeId === undefined || volumeId.length === 0) return [];
            return [{ appName: app.appName, volumeId, volume }];
          }),
        ),
      ),
    { concurrency: 8 },
  );
  return groups.flat();
});
