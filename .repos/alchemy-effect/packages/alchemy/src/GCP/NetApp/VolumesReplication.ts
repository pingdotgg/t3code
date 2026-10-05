import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldMask,
  fingerprint,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotReady,
  ResourceNotResolved,
  storagePoolOf,
  toPhysicalId,
  userLabels,
  volumeOf,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const DEFAULT_SCHEDULE = "HOURLY";
const STOPPED = "STOPPED";
const ENABLED_MIRROR_STATES = new Set([
  "PREPARING",
  "MIRRORED",
  "TRANSFERRING",
  "BASELINE_TRANSFERRING",
  "PENDING_PEERING",
]);

export type ReplicationTieringPolicy = {
  /**
   * Enable or pause auto-tiering on the destination volume.
   * @default "PAUSED"
   */
  tierAction?: netapp.TieringPolicyTierActionEnum | (string & {});
  /**
   * Days before data is eligible for tiering (2-183).
   * @default 31
   */
  coolingThresholdDays?: number;
  /**
   * Hot-tier bypass for Flex service level.
   * @default false
   */
  hotTierBypassModeEnabled?: boolean;
};

export type DestinationVolumeParameters = {
  /**
   * Destination storage pool. Full name
   * `projects/{project}/locations/{location}/storagePools/{pool}`
   * recommended (destination pools are usually in another region). A
   * bare id is expanded in the source volume location.
   */
  storagePool: string;
  /**
   * Share name of the destination volume. Defaults to the source share
   * name.
   */
  shareName?: string;
  /**
   * Description of the destination volume.
   */
  description?: string;
  /**
   * Destination volume id. Defaults to the source volume id.
   */
  volumeId?: string;
  /**
   * Auto-tiering policy for the destination volume. Requires auto-tiering
   * on the destination pool.
   */
  tieringPolicy?: ReplicationTieringPolicy;
};

export type VolumesReplicationProps = {
  /**
   * Source volume. Full name
   * `projects/{project}/locations/{location}/volumes/{volume}` or the
   * volume id (combined with `location`). Immutable — changing it
   * replaces the replication.
   */
  volume: string;
  /**
   * Region used when `volume` is a bare id. Immutable — changing it
   * replaces the replication. `US-CENTRAL1` is accepted and normalized
   * to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Replication id (the `{replication}` segment of
   * `.../volumes/{volume}/replications/{replication}`). If omitted, a
   * unique RFC1035 name is generated from the stack, stage, and logical
   * id. Immutable — changing it replaces the replication.
   */
  replicationId?: string;
  /**
   * Replication interval.
   * @default "HOURLY"
   */
  replicationSchedule?:
    | netapp.ReplicationReplicationScheduleEnum
    | (string & {});
  /**
   * Destination volume parameters. Input-only on create. Changing
   * `storagePool`, `volumeId`, or `shareName` replaces the replication.
   */
  destinationVolumeParameters: DestinationVolumeParameters;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * On-prem cluster location for hybrid replication.
   */
  clusterLocation?: string;
  /**
   * Whether the mirror is running. `false` force-stops the relationship
   * so the destination volume becomes read-write. Resuming overwrites
   * destination changes with the source.
   * @default true
   */
  replicationEnabled?: boolean;
  /**
   * Force-stop while a transfer is in progress. Required to delete a
   * replication that is still PREPARING or TRANSFERRING.
   * @default true
   */
  forceStopping?: boolean;
  /**
   * Delete the destination volume when this replication is destroyed.
   * The destination volume is created as a side effect and is otherwise
   * left behind.
   * @default false
   */
  deleteDestinationVolume?: boolean;
  /**
   * Wait until `mirrorState` is MIRRORED (or STOPPED when disabling).
   * Baseline transfers can take hours — leave false unless the volume
   * is empty.
   * @default false
   */
  waitForMirror?: boolean;
};

export type VolumesReplication = Resource<
  "GCP.NetApp.VolumesReplication",
  VolumesReplicationProps,
  {
    /** Full resource name. */
    name: string;
    /** Replication id (last path segment). */
    replicationId: string;
    /** Source volume resource name. */
    volume: string;
    /** Project id. */
    project: string;
    /** Location id of the source volume. */
    location: string;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Replication interval. */
    replicationSchedule: string | undefined;
    /** On-prem cluster location, if set. */
    clusterLocation: string | undefined;
    /** Destination volume resource name. */
    destinationVolume: string | undefined;
    /** Source volume resource name reported by the API. */
    sourceVolume: string | undefined;
    /** SOURCE or DESTINATION. */
    role: string | undefined;
    /** Mirror state (PREPARING, MIRRORED, STOPPED, …). */
    mirrorState: string | undefined;
    /** Resource state (CREATING, READY, …). */
    state: string | undefined;
    /** Server-reported state details. */
    stateDetails: string | undefined;
    /** Whether the most recent scheduled transfer succeeded. */
    healthy: boolean | undefined;
    /** Hybrid replication type, if this is a hybrid relationship. */
    hybridReplicationType: string | undefined;
    /** Whether the mirror is currently running. */
    replicationEnabled: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes cross-region replication. Creating it also
 * creates a destination volume in the destination pool.
 *
 * Changing `replicationId`, `volume`, `location`, or destination
 * identity (`storagePool` / `volumeId` / `shareName`) replaces the
 * replication. Schedule, description, labels, `clusterLocation`, and
 * `replicationEnabled` update in place.
 *
 * ### Creating a Replication
 * **Example:** Hourly mirror into another region
 * ```typescript
 * const replica = yield* GCP.NetApp.VolumesReplication("Dr", {
 *   volume: sourceVolume.name,
 *   replicationSchedule: "HOURLY",
 *   destinationVolumeParameters: {
 *     storagePool: destPool.name,
 *     volumeId: "app-dr",
 *     shareName: "app",
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Ten-minute schedule with description
 * ```typescript
 * const replica = yield* GCP.NetApp.VolumesReplication("Dr", {
 *   volume: sourceVolume.name,
 *   replicationSchedule: "EVERY_10_MINUTES",
 *   destinationVolumeParameters: {
 *     storagePool: destPool.name,
 *   },
 *   description: "us-central1 to us-east1",
 * });
 * ```
 *
 * ### Updating a Replication
 * **Example:** Pause the mirror
 * ```typescript
 * const replica = yield* GCP.NetApp.VolumesReplication("Dr", {
 *   volume: sourceVolume.name,
 *   replicationSchedule: "HOURLY",
 *   destinationVolumeParameters: {
 *     storagePool: destPool.name,
 *   },
 *   replicationEnabled: false,
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const VolumesReplication = Resource<VolumesReplication>(
  "GCP.NetApp.VolumesReplication",
);

const resourceName = (volume: string, replicationId: string) =>
  `${volume}/replications/${replicationId}`;

const desiredSchedule = (value: string | undefined) =>
  (value ?? DEFAULT_SCHEDULE).toUpperCase();

const destFingerprint = (params: DestinationVolumeParameters | undefined) =>
  fingerprint({
    storagePool: params?.storagePool,
    volumeId: params?.volumeId,
    shareName: params?.shareName,
  });

const isMirrorRunning = (mirrorState: string | undefined) =>
  ENABLED_MIRROR_STATES.has((mirrorState ?? "").toUpperCase());

const toAttrs = (
  replication: netapp.Replication,
  project: string,
  region: string,
) => {
  const name = replication.name ?? "";
  const parsed = parseName(name, "replications", region);
  return {
    name,
    replicationId: parsed.id,
    volume: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    description: replication.description,
    labels: userLabels(replication.labels),
    replicationSchedule: replication.replicationSchedule,
    clusterLocation: replication.clusterLocation,
    destinationVolume: replication.destinationVolume,
    sourceVolume: replication.sourceVolume,
    role: replication.role,
    mirrorState: replication.mirrorState,
    state: replication.state,
    stateDetails: replication.stateDetails,
    healthy: replication.healthy,
    hybridReplicationType: replication.hybridReplicationType,
    replicationEnabled: isMirrorRunning(replication.mirrorState),
    createTime: replication.createTime,
  };
};

const destBody = (
  params: DestinationVolumeParameters,
  project: string,
  location: string,
): netapp.DestinationVolumeParameters => ({
  storagePool: storagePoolOf(params.storagePool, project, location),
  shareName: params.shareName,
  description: params.description,
  volumeId: params.volumeId,
  tieringPolicy: params.tieringPolicy,
});

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : netapp
        .getProjectsLocationsVolumesReplications({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "volumes/-", (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsVolumesReplications.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.replications,
      (item) => item.labels,
    ),
  );

const waitUntilMirror = (name: string, enabled: boolean) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (value): value is netapp.Replication => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => {
        const mirror = (value.mirrorState ?? "").toUpperCase();
        return enabled
          ? mirror === "MIRRORED" || mirror === "TRANSFERRING"
          : mirror === STOPPED || mirror === "ABORTED";
      },
      (value) => new ResourceNotReady({ name, state: value.mirrorState ?? "" }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetApp.ResourceNotReady" ||
        error._tag === "GCP.NetApp.ResourceNotResolved",
      times: 120,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

export const VolumesReplicationProvider = () =>
  Provider.succeed(VolumesReplication, {
    stables: [
      "name",
      "replicationId",
      "volume",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousVolume = volumeOf(
        olds?.volume ?? output?.volume ?? "",
        env.project,
        previousLocation,
      );
      const nextVolume = volumeOf(
        news.volume ?? olds?.volume ?? output?.volume ?? "",
        env.project,
        nextLocation,
      );
      const destChanged =
        olds?.destinationVolumeParameters !== undefined &&
        destFingerprint(news.destinationVolumeParameters) !==
          destFingerprint(olds.destinationVolumeParameters);
      return replaceOnIdentity({
        previousId: olds?.replicationId ?? output?.replicationId,
        nextId:
          news.replicationId ?? olds?.replicationId ?? output?.replicationId,
        previousLocation,
        nextLocation,
        previousParent: previousVolume,
        nextParent: nextVolume,
        extra: destChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const volume = volumeOf(
        olds?.volume ?? output?.volume ?? "",
        env.project,
        location,
      );
      const replicationId = yield* toPhysicalId(
        id,
        olds?.replicationId,
        output?.replicationId,
        "replication",
      );
      const name = output?.name ?? resourceName(volume, replicationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const locationHint = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const volume = volumeOf(news.volume, env.project, locationHint);
      const location = parseName(volume, "volumes", locationHint).location;
      const replicationId = yield* toPhysicalId(
        id,
        news.replicationId,
        output?.replicationId,
        "replication",
      );
      const name = output?.name ?? resourceName(volume, replicationId);
      const schedule = desiredSchedule(news.replicationSchedule);
      const enabled = news.replicationEnabled ?? true;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsVolumesReplications({
            parent: volume,
            replicationId,
            body: {
              description: news.description,
              labels: desiredLabels,
              replicationSchedule: schedule,
              destinationVolumeParameters: destBody(
                news.destinationVolumeParameters,
                env.project,
                location,
              ),
              clusterLocation: news.clusterLocation,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
        (item) => item.stateDetails,
        { times: 120, interval: "5 seconds" },
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const scheduleChanged =
        desiredSchedule(current.replicationSchedule) !== schedule;
      const clusterChanged =
        (current.clusterLocation ?? "") !== (news.clusterLocation ?? "");
      const mask = fieldMask([
        labelsChanged && "labels",
        descriptionChanged && "description",
        scheduleChanged && "replicationSchedule",
        clusterChanged && "clusterLocation",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* netapp.patchProjectsLocationsVolumesReplications({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              replicationSchedule: schedule,
              clusterLocation: news.clusterLocation,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateDetails,
          { times: 120, interval: "5 seconds" },
        );
      }

      const running = isMirrorRunning(current.mirrorState);
      if (enabled && !running) {
        const resumed = yield* netapp
          .resumeProjectsLocationsVolumesReplications({
            name: current.name ?? name,
            body: {},
          })
          .pipe(
            Effect.catchTag(["Conflict", "BadRequest"], () =>
              Effect.succeed(undefined),
            ),
          );
        if (resumed !== undefined) {
          yield* waitForOperation(resumed);
        }
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateDetails,
          { times: 120, interval: "5 seconds" },
        );
      } else if (!enabled && running) {
        const stopped = yield* netapp
          .stopProjectsLocationsVolumesReplications({
            name: current.name ?? name,
            body: { force: news.forceStopping ?? true },
          })
          .pipe(
            Effect.catchTag(["Conflict", "BadRequest"], () =>
              Effect.succeed(undefined),
            ),
          );
        if (stopped !== undefined) {
          yield* waitForOperation(stopped);
        }
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateDetails,
          { times: 120, interval: "5 seconds" },
        );
      }

      if (news.waitForMirror === true) {
        current = yield* waitUntilMirror(current.name ?? name, enabled);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      if (!output.name || output.name.includes("//")) return;
      const current = yield* getByName(output.name);
      if (
        current !== undefined &&
        (current.mirrorState ?? "").toUpperCase() !== STOPPED
      ) {
        const stopped = yield* netapp
          .stopProjectsLocationsVolumesReplications({
            name: output.name,
            body: { force: olds?.forceStopping ?? true },
          })
          .pipe(
            Effect.catchTag(["NotFound", "Conflict", "BadRequest"], () =>
              Effect.succeed(undefined),
            ),
          );
        if (stopped !== undefined) {
          yield* waitForDeleteOperation(stopped);
        }
      }

      const operation = yield* netapp
        .deleteProjectsLocationsVolumesReplications({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);

      const destination =
        output.destinationVolume ?? current?.destinationVolume;
      if (olds?.deleteDestinationVolume === true && destination) {
        const deleted = yield* netapp
          .deleteProjectsLocationsVolumes({
            name: destination,
            force: true,
          })
          .pipe(
            Effect.catchTag(["NotFound", "Conflict", "BadRequest"], () =>
              Effect.succeed(undefined),
            ),
          );
        if (deleted !== undefined) {
          yield* waitForDeleteOperation(deleted);
        }
      }
    }),
  });
