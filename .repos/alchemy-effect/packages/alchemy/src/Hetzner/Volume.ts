import { Services } from "@distilled.cloud/hetzner";
import type {
  GetVolumeResponseVolume,
  ListVolumesResponseVolumesItem,
} from "@distilled.cloud/hetzner/volumes";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { waitForAction, waitForActions } from "./actions.ts";
import {
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  labelSelector,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

const DEFAULT_LOCATION = "nbg1";
const MIN_SIZE_GB = 10;
const MAX_NAME_LENGTH = 64;

export type VolumeFormat = "ext4" | "xfs";

export type VolumeStatus = "available" | "creating";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Server(...)` and `Server(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Server identity a Volume can attach to at create time. Accepts a
 * `Hetzner.Server` resource or a `{ serverId }` stub.
 */
export type VolumeServer = {
  readonly serverId: number;
};

export interface VolumeProps {
  /**
   * Size of the Volume in GB. Minimum 10, maximum 10240. Increasing size
   * updates in place (Hetzner cannot shrink a Volume — decreasing it
   * replaces).
   */
  size: number;
  /**
   * Filesystem to format on create. One of `ext4` or `xfs`. Cannot be
   * changed after creation — changing it replaces the Volume.
   */
  format?: VolumeFormat;
  /**
   * Location to create the Volume in (`nbg1`, `fsn1`, `hel1`, …). Required
   * unless `server` is set (the Volume is then created in the Server's
   * location). Cannot be changed after creation.
   *
   * @default "nbg1"
   */
  location?: string;
  /**
   * Volume name. Must be unique per project, 1–64 characters, alphanumeric
   * with dashes/underscores/dots, starting and ending alphanumeric. If
   * omitted, a unique name is generated from the stack, stage and logical
   * ID.
   */
  name?: string;
  /**
   * User-defined labels. Alchemy ownership labels (`alchemy.stack` /
   * `alchemy.stage` / `alchemy.id`) are always merged in.
   */
  labels?: Record<string, string>;
  /**
   * Server to attach the Volume to at create time. Accepts a
   * `Hetzner.Server` or `{ serverId }`. Location may be omitted when this
   * is set. Subsequent attach/detach is reconciled from the observed
   * server.
   */
  server?: Ref<VolumeServer>;
  /**
   * Auto-mount the Volume after attach. Only used when `server` is set.
   *
   * @default false
   */
  automount?: boolean;
}

export type Volume = Resource<
  "Hetzner.Volume",
  VolumeProps,
  {
    /** Numeric Hetzner Volume ID. */
    id: number;
    /** Volume name (unique per project). */
    name: string;
    /** Size in GB. */
    size: number;
    /** Filesystem if formatted on creation. */
    format: VolumeFormat | undefined;
    /** Location name (`nbg1`, `fsn1`, …). */
    location: string;
    /** Numeric location ID. */
    locationId: number;
    /** Device path on the file system (e.g. `/dev/disk/by-id/scsi-…`). */
    linuxDevice: string;
    /** Volume status. */
    status: VolumeStatus;
    /** Attached Server ID, or `null` if unattached. */
    serverId: number | null;
    /** RFC3339 creation timestamp. */
    created: string;
    /** User-defined labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Hetzner Cloud Volume — a network block device that can be attached to
 * a Server in the same Location. Unattached Volumes are valid; pass
 * `server` to attach at create time.
 *
 * Size can grow in place (min 10 GB). Format and location are immutable
 * (changing either replaces the Volume). Hetzner cannot shrink a Volume.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#volumes
 *
 * ### Creating a Volume
 * **Example:** Unattached Volume
 * ```typescript
 * const volume = yield* Hetzner.Volume("data", {
 *   size: 10,
 *   format: "ext4",
 *   location: "nbg1",
 * });
 * ```
 *
 * **Example:** Named Volume with labels
 * ```typescript
 * const volume = yield* Hetzner.Volume("data", {
 *   name: "app-data",
 *   size: 20,
 *   format: "xfs",
 *   location: "nbg1",
 *   labels: { role: "db" },
 * });
 * ```
 *
 * ### Attaching to a Server
 * **Example:** Create-time attach
 * ```typescript
 * const server = yield* Hetzner.Server("web", {
 *   serverType: "cx22",
 *   image: "ubuntu-24.04",
 *   location: "nbg1",
 * });
 * const volume = yield* Hetzner.Volume("data", {
 *   size: 10,
 *   format: "ext4",
 *   server,
 *   automount: true,
 * });
 * ```
 *
 * @resource
 */
export const Volume = Resource<Volume>("Hetzner.Volume");

type CloudVolume = GetVolumeResponseVolume | ListVolumesResponseVolumesItem;

class VolumePending extends Data.TaggedError("VolumePending")<{
  volumeId: number;
  status: string;
}> {}

class VolumeTimeout extends Data.TaggedError("VolumeTimeout")<{
  volumeId: number;
  status: string;
}> {}

class VolumeNotCreated extends Data.TaggedError("Hetzner.VolumeNotCreated")<{
  name: string;
}> {}

const asFormat = (
  format: string | null | undefined,
): VolumeFormat | undefined =>
  format === "ext4" || format === "xfs" ? format : undefined;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (volume: CloudVolume): Volume["Attributes"] => ({
  id: volume.id,
  name: volume.name,
  size: volume.size,
  format: asFormat(volume.format),
  location: volume.location.name,
  locationId: volume.location.id,
  linuxDevice: volume.linux_device,
  status: volume.status,
  serverId: volume.server,
  created: volume.created,
  labels: userLabels(volume.labels),
});

const retryable = (e: { readonly _tag: string }): boolean =>
  e._tag === "VolumePending" ||
  e._tag === "TooManyRequests" ||
  e._tag === "ServiceUnavailable" ||
  e._tag === "InternalServerError" ||
  e._tag === "BadGateway" ||
  e._tag === "GatewayTimeout" ||
  e._tag === "Locked";

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const createVolumeName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: MAX_NAME_LENGTH }))
    );
  });

const getById = (id: number) =>
  Services.volumes.getVolume({ id }).pipe(
    Effect.map(({ volume }) => volume),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const getByName = (name: string) =>
  Services.volumes
    .listVolumes({ name, per_page: 50 })
    .pipe(
      Effect.map(({ volumes }) => volumes.find((item) => item.name === name)),
    );

const getByLabels = (labels: Record<string, string>) =>
  Services.volumes
    .listVolumes({
      label_selector: labelSelector(labels),
      per_page: 50,
    })
    .pipe(Effect.map(({ volumes }) => volumes[0]));

const observe = Effect.fn(function* ({
  id,
  name,
  outputId,
}: {
  id: string;
  name?: string;
  outputId?: number;
}) {
  if (outputId !== undefined) {
    const byId = yield* getById(outputId);
    if (byId !== undefined) return byId;
  }
  if (name !== undefined) {
    const byName = yield* getByName(name);
    if (byName !== undefined) return byName;
  }
  const internal = yield* createInternalLabels(id);
  return yield* getByLabels(internal);
});

const waitUntilAvailable = (volumeId: number) =>
  Services.volumes.getVolume({ id: volumeId }).pipe(
    Effect.flatMap(({ volume }) =>
      volume.status === "available"
        ? Effect.succeed(volume)
        : Effect.fail(
            new VolumePending({
              volumeId: volume.id,
              status: volume.status,
            }),
          ),
    ),
    Effect.retry({
      while: retryable,
      times: 10,
      schedule: backoff,
    }),
    Effect.catchTag(
      "VolumePending",
      (e) =>
        new VolumeTimeout({
          volumeId: e.volumeId,
          status: e.status,
        }),
    ),
  );

const settleAction = (action: Parameters<typeof waitForAction>[0]) =>
  waitForAction(action).pipe(
    Effect.catchTag("ActionTimeout", () => Effect.void),
  );

const settleActions = (actions: Parameters<typeof waitForActions>[0]) =>
  waitForActions(actions).pipe(
    Effect.catchTag("ActionTimeout", () => Effect.void),
  );

const waitUntilGone = (volumeId: number) =>
  Services.volumes.getVolume({ id: volumeId }).pipe(
    Effect.map(() => false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced(Duration.seconds(1)),
      until: (gone) => gone,
      times: 10,
    }),
  );

const serverIdOf = (value: unknown): number | undefined => {
  if (value == null || typeof value !== "object") return undefined;
  const id = (value as { serverId?: unknown }).serverId;
  return typeof id === "number" ? id : undefined;
};

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    stables: ["id", "linuxDevice", "location", "locationId", "created"],
    list: Effect.fn(function* () {
      const items = yield* Services.volumes.listVolumes
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      return items.map(toAttrs);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined) {
        if (news.location !== undefined && news.location !== output.location) {
          return { action: "replace" } as const;
        }
        if (news.format !== undefined && news.format !== output.format) {
          return { action: "replace" } as const;
        }
        if (news.size < output.size) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const found = yield* observe({
        id,
        name: olds?.name ?? output?.name,
        outputId: output?.id,
      });
      if (found === undefined) return undefined;
      const attrs = toAttrs(found);
      const owned = yield* hasAlchemyLabels(id, tagRecord(found.labels));
      return owned ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* createVolumeName(id, news.name, output?.name);
      const internalLabels = yield* createInternalLabels(id);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...internalLabels,
      };
      const desiredServerId = serverIdOf(news.server);
      const location =
        news.location ??
        (desiredServerId === undefined ? DEFAULT_LOCATION : undefined);

      // Observe by id then desired name only. Do not fall back to
      // ownership labels — a create-first replacement still has the old
      // generation live under the same logical id.
      let current =
        output?.id !== undefined ? yield* getById(output.id) : undefined;
      if (current === undefined) {
        current = yield* getByName(name);
      }

      // Ensure — create only when missing. A Conflict is a race with a
      // peer reconciler or a name that just became visible; re-observe.
      if (current === undefined) {
        const created = yield* Services.volumes
          .createVolume({
            name,
            size: Math.max(news.size, MIN_SIZE_GB),
            format: news.format,
            location,
            labels: desiredLabels,
            server: desiredServerId,
            automount:
              desiredServerId !== undefined ? news.automount : undefined,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          if (created.action) {
            yield* settleActions([created.action, ...created.next_actions]);
          }
          current = yield* waitUntilAvailable(created.volume.id);
        } else {
          const hit = yield* getByName(name);
          if (hit === undefined) {
            return yield* new VolumeNotCreated({ name });
          }
          current = yield* waitUntilAvailable(hit.id);
        }
      }

      // Sync name + labels against observed cloud labels, not olds.
      // updateVolume overwrites the full label set.
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const needsMeta =
        current.name !== name || upsert.length > 0 || removed.length > 0;
      if (needsMeta) {
        const updated = yield* Services.volumes.updateVolume({
          id: current.id,
          name,
          labels: desiredLabels,
        });
        current = updated.volume;
      }

      // Sync size — grow only. Shrink is a replacement (handled in diff).
      if (news.size > current.size) {
        const { action } = yield* Services.volumeActions.resizeVolume({
          id: current.id,
          size: news.size,
        });
        yield* settleAction(action);
        current = yield* waitUntilAvailable(current.id);
      }

      // Sync attach — create-time sugar also applies on later updates.
      const observedServerId = current.server ?? undefined;
      if (desiredServerId !== observedServerId) {
        if (observedServerId !== undefined) {
          const { action } = yield* Services.volumeActions.detachVolume({
            id: current.id,
          });
          yield* settleAction(action);
          current = yield* waitUntilAvailable(current.id);
        }
        if (desiredServerId !== undefined) {
          const { action } = yield* Services.volumeActions.attachVolume({
            id: current.id,
            server: desiredServerId,
            automount: news.automount,
          });
          yield* settleAction(action);
          current = yield* waitUntilAvailable(current.id);
        }
      }

      return toAttrs(current);
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* getById(output.id);
      if (current === undefined) return;

      if (current.protection.delete) {
        const { action } = yield* Services.volumeActions.changeVolumeProtection(
          {
            id: current.id,
            delete: false,
          },
        );
        yield* settleAction(action);
      }

      const attached = current.server;
      if (attached !== null) {
        yield* Services.volumeActions.detachVolume({ id: current.id }).pipe(
          Effect.flatMap(({ action }) => settleAction(action)),
          // Server delete detaches the Volume first; treat that race as
          // already-detached.
          Effect.catchTag(
            ["NotFound", "UnprocessableEntity"],
            () => Effect.void,
          ),
        );
      }

      yield* Services.volumes.deleteVolume({ id: current.id }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: (e) => retryable(e) || e._tag === "UnprocessableEntity",
          times: 8,
          schedule: backoff,
        }),
      );
      yield* waitUntilGone(current.id);
    }),
  });
