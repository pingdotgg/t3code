import { Services } from "@distilled.cloud/hetzner";
import type { GetVolumeResponseVolume } from "@distilled.cloud/hetzner/volumes";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { waitForAction } from "./actions.ts";
import { alchemyStackSelector } from "./Labels.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Volume(...)` and `Volume(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Volume identity. A `Hetzner.Volume` resource satisfies this via `id`.
 */
export type VolumeAttachmentVolume = {
  readonly id: number;
};

/**
 * Server identity. A `Hetzner.Server` resource satisfies this via
 * `serverId`.
 */
export type VolumeAttachmentServer = {
  readonly serverId: number;
};

export interface VolumeAttachmentProps {
  /**
   * Volume to attach. Accepts a `Hetzner.Volume` or `{ id }`. Changing
   * the Volume replaces the attachment.
   */
  volume: Ref<VolumeAttachmentVolume>;
  /**
   * Server to attach the Volume to. Accepts a `Hetzner.Server` or
   * `{ serverId }`. Changing the Server replaces the attachment.
   */
  server: Ref<VolumeAttachmentServer>;
  /**
   * Auto-mount the Volume after attach. Updating this detaches and
   * re-attaches the Volume so the new value is applied.
   *
   * @default false
   */
  automount?: boolean;
}

export type VolumeAttachment = Resource<
  "Hetzner.VolumeAttachment",
  VolumeAttachmentProps,
  {
    /** Numeric Hetzner Volume ID. */
    volumeId: number;
    /** Numeric Hetzner Server ID the Volume is attached to. */
    serverId: number;
    /**
     * Last-applied automount flag. Hetzner does not expose the live
     * automount state, so this is the desired value from the last
     * successful reconcile.
     */
    automount: boolean;
    /** Device path on the file system (e.g. `/dev/disk/by-id/scsi-…`). */
    linuxDevice: string;
  },
  never,
  Providers
>;

/**
 * Attaches a Hetzner Cloud Volume to a Server in the same Location.
 * The Volume and Server must already exist. Deleting the attachment
 * detaches the Volume; it does not delete the Volume or the Server.
 *
 * This is an existence-style resource — its identity is the
 * `volume`/`server` pair. Changing either replaces the attachment.
 * `automount` updates in place (detach + re-attach).
 *
 * @see https://docs.hetzner.cloud/reference/cloud#volume-actions-attach-volume-to-a-server
 *
 * ### Attaching a Volume
 * **Example:** Attach a Volume to a Server
 * ```typescript
 * const server = yield* Hetzner.Server("web", {
 *   serverType: "cx23",
 *   image: "ubuntu-24.04",
 *   location: "nbg1",
 * });
 * const volume = yield* Hetzner.Volume("data", {
 *   size: 10,
 *   format: "ext4",
 *   location: "nbg1",
 * });
 * const attachment = yield* Hetzner.VolumeAttachment("data-attach", {
 *   volume,
 *   server,
 * });
 * ```
 *
 * **Example:** Attach with automount
 * ```typescript
 * const attachment = yield* Hetzner.VolumeAttachment("data-attach", {
 *   volume,
 *   server,
 *   automount: true,
 * });
 * ```
 *
 * @resource
 */
export const VolumeAttachment = Resource<VolumeAttachment>(
  "Hetzner.VolumeAttachment",
);

class VolumeAttachmentError extends Data.TaggedError(
  "Hetzner.VolumeAttachmentError",
)<{
  message: string;
}> {}

class VolumeNotFound extends Data.TaggedError("Hetzner.VolumeNotFound")<{
  volumeId: number;
}> {}

class AttachmentPending extends Data.TaggedError("AttachmentPending")<{
  volumeId: number;
  serverId: number | null;
}> {}

class AttachmentTimeout extends Data.TaggedError("AttachmentTimeout")<{
  volumeId: number;
  serverId: number | null;
}> {}

const retryable = (e: { readonly _tag: string }): boolean =>
  e._tag === "AttachmentPending" ||
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

const volumeIdOf = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { id?: unknown; volumeId?: unknown };
  if (typeof rec.id === "number") return rec.id;
  if (typeof rec.volumeId === "number") return rec.volumeId;
  return undefined;
};

const serverIdOf = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serverId?: unknown; id?: unknown };
  if (typeof rec.serverId === "number") return rec.serverId;
  if (typeof rec.id === "number") return rec.id;
  return undefined;
};

const getById = (id: number) =>
  Services.volumes.getVolume({ id }).pipe(
    Effect.map(({ volume }) => volume),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  volume: GetVolumeResponseVolume,
  automount: boolean,
): VolumeAttachment["Attributes"] | undefined => {
  if (volume.server === null) return undefined;
  return {
    volumeId: volume.id,
    serverId: volume.server,
    automount,
    linuxDevice: volume.linux_device,
  };
};

const waitUntilServer = (volumeId: number, serverId: number | null) =>
  getById(volumeId).pipe(
    Effect.flatMap((volume) => {
      if (volume === undefined) {
        return serverId === null
          ? Effect.succeed(undefined)
          : Effect.fail(
              new AttachmentPending({
                volumeId,
                serverId: null,
              }),
            );
      }
      const attached = volume.server;
      if (attached === serverId) return Effect.succeed(volume);
      return Effect.fail(
        new AttachmentPending({
          volumeId,
          serverId: attached,
        }),
      );
    }),
    Effect.retry({
      while: retryable,
      times: 10,
      schedule: backoff,
    }),
    Effect.catchTag(
      "AttachmentPending",
      (e) =>
        new AttachmentTimeout({
          volumeId: e.volumeId,
          serverId: e.serverId,
        }),
    ),
  );

const detach = (volumeId: number) =>
  Services.volumeActions.detachVolume({ id: volumeId }).pipe(
    Effect.tap(({ action }) =>
      waitForAction(action).pipe(
        // Volume detach can outlive the action poll under load; observe
        // the Volume's `server` field instead of failing the reconcile.
        Effect.catchTag("ActionTimeout", () => Effect.void),
      ),
    ),
    Effect.catchTag(["NotFound", "UnprocessableEntity"], () => Effect.void),
  );

const attach = (volumeId: number, serverId: number, automount: boolean) =>
  Services.volumeActions
    .attachVolume({
      id: volumeId,
      server: serverId,
      automount,
    })
    .pipe(
      Effect.tap(({ action }) =>
        waitForAction(action).pipe(
          Effect.catchTag("ActionTimeout", () => Effect.void),
        ),
      ),
      Effect.catchTag("UnprocessableEntity", () => Effect.void),
      Effect.retry({
        while: retryable,
        times: 10,
        schedule: backoff,
      }),
    );

export const VolumeAttachmentProvider = () =>
  Provider.succeed(VolumeAttachment, {
    stables: ["volumeId", "serverId", "linuxDevice"],
    nuke: { dependsOn: ["Hetzner.Volume", "Hetzner.Server"] },
    list: Effect.fn(function* () {
      const items = yield* Services.volumes.listVolumes
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      return items.flatMap((volume) => {
        if (volume.server === null) return [];
        return [
          {
            volumeId: volume.id,
            serverId: volume.server,
            automount: false,
            linuxDevice: volume.linux_device,
          },
        ];
      });
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      const nextVolume = volumeIdOf(news.volume);
      const nextServer = serverIdOf(news.server);
      if (
        output !== undefined &&
        nextVolume !== undefined &&
        nextServer !== undefined &&
        (output.volumeId !== nextVolume || output.serverId !== nextServer)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const volumeId =
        output?.volumeId ??
        (olds !== undefined ? volumeIdOf(olds.volume) : undefined);
      const serverId =
        output?.serverId ??
        (olds !== undefined ? serverIdOf(olds.server) : undefined);
      if (volumeId === undefined || serverId === undefined) {
        return undefined;
      }
      const found = yield* getById(volumeId);
      if (found === undefined || found.server !== serverId) {
        return undefined;
      }
      return toAttrs(found, output?.automount ?? olds?.automount ?? false);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const volumeId = volumeIdOf(news.volume);
      const serverId = serverIdOf(news.server);
      if (volumeId === undefined || serverId === undefined) {
        return yield* new VolumeAttachmentError({
          message: "VolumeAttachment requires a resolved volume and server",
        });
      }
      const desiredAutomount = news.automount ?? false;

      // Observe — cached output.volumeId is a hint; the Volume is the
      // source of truth for whether this attachment exists.
      let current = yield* getById(volumeId);
      if (current === undefined) {
        return yield* new VolumeNotFound({ volumeId });
      }

      // Ensure — attach when missing or attached to a different Server.
      // Already-attached (UnprocessableEntity) is a race; re-observe.
      if (current.server !== serverId) {
        if (current.server !== null) {
          yield* detach(current.id);
          current = (yield* waitUntilServer(current.id, null)) ?? current;
        }
        yield* attach(current.id, serverId, desiredAutomount);
        current =
          (yield* waitUntilServer(current.id, serverId)) ??
          (yield* getById(volumeId));
        if (current === undefined) {
          return yield* new VolumeNotFound({ volumeId });
        }
      }

      // Automount is only accepted on attach. Hetzner has no update API,
      // and detach+reattach to flip it unmounts the disk — skip when the
      // Volume is already on the desired Server.
      const attrs = toAttrs(current, desiredAutomount);
      if (attrs === undefined) {
        return yield* new AttachmentTimeout({
          volumeId,
          serverId: current.server,
        });
      }
      return attrs;
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* getById(output.volumeId);
      if (current === undefined) return;
      if (current.server !== output.serverId) return;

      yield* detach(current.id);
      yield* waitUntilServer(current.id, null);
    }),
  });
