import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_THROUGHPUT_CAPACITY,
  ResourceNotResolved,
  fieldMask,
  getReservation,
  hasOwnershipMarker,
  ignoreMissing,
  listOwnedReservations,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  retryInUse,
  sameText,
  toResourceId,
  waitUntilGone,
} from "./internal.ts";

export type AdminReservationProps = {
  /**
   * Reservation id (the `{reservation}` segment of
   * `projects/{project}/locations/{location}/reservations/{reservation}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Pub/Sub Lite has no labels field, so Alchemy stamps
   * ownership into a `+alc.{stack}.{stage}.{id}` suffix. Immutable —
   * changing it replaces the reservation.
   */
  reservationId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Reservations are regional.
   * Immutable — changing it replaces the reservation. `US-CENTRAL1` is
   * accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Reserved throughput capacity. Each unit is 1 MiB/s of published
   * messages or 2 MiB/s of subscribed messages.
   * @default "4"
   */
  throughputCapacity?: string | number;
};

export type AdminReservation = Resource<
  "GCP.PubSubLite.AdminReservation",
  AdminReservationProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/reservations/{reservation}`. */
    name: string;
    /** Reservation id (last path segment, including the Alchemy ownership suffix). */
    reservationId: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** Reserved throughput capacity. */
    throughputCapacity: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Pub/Sub Lite throughput reservation — a regional pool of publish
 * and subscribe capacity that topics can consume.
 *
 * Pub/Sub Lite reservations have no labels. Alchemy stamps
 * `alchemy-stack` / `alchemy-stage` / `alchemy-id` into the reservation
 * id so `list` / `pnpm nuke:gcp` can find them. `reservationId` and
 * `location` replace the reservation; `throughputCapacity` updates in
 * place.
 *
 * ### Creating a Reservation
 * **Example:** Generated name
 * ```typescript
 * const reservation = yield* GCP.PubSubLite.AdminReservation("Capacity", {
 *   throughputCapacity: "4",
 * });
 * ```
 *
 * **Example:** Explicit id and region
 * ```typescript
 * const reservation = yield* GCP.PubSubLite.AdminReservation("Capacity", {
 *   reservationId: "analytics",
 *   location: "us-central1",
 *   throughputCapacity: "8",
 * });
 * ```
 *
 * ### Updating a Reservation
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Scale throughput
 * ```typescript
 * const reservation = yield* GCP.PubSubLite.AdminReservation("Capacity", {
 *   location: "us-central1",
 *   throughputCapacity: "16",
 * });
 * ```
 *
 * @resource
 * @category PubSubLite
 */
export const AdminReservation = Resource<AdminReservation>(
  "GCP.PubSubLite.AdminReservation",
);

const COLLECTION = "reservations";

const capacityOf = (value: string | number | undefined) =>
  value === undefined || value === ""
    ? DEFAULT_THROUGHPUT_CAPACITY
    : String(value);

const toAttrs = (
  reservation: pubsublite.Reservation,
  project: string,
): AdminReservation["Attributes"] => {
  const name = reservation.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    reservationId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    throughputCapacity: reservation.throughputCapacity,
  };
};

export const AdminReservationProvider = () =>
  Provider.succeed(AdminReservation, {
    stables: ["name", "reservationId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.reservationId ?? output?.reservationId,
        nextId:
          news.reservationId ?? olds?.reservationId ?? output?.reservationId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const reservationId = yield* toResourceId(
        id,
        olds?.reservationId,
        output?.reservationId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, reservationId);
      const existing = yield* getReservation(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const owned = yield* ownedByAlchemy(id, attrs.reservationId);
      if (owned) return attrs;
      return hasOwnershipMarker(attrs.reservationId)
        ? undefined
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedReservations();
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const reservationId = yield* toResourceId(
        id,
        news.reservationId,
        output?.reservationId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        reservationId,
      );
      const throughputCapacity = capacityOf(news.throughputCapacity);

      let current = yield* getReservation(output?.name ?? name);

      if (current === undefined) {
        const created = yield* pubsublite
          .createAdminProjectsLocationsReservations({
            parent: parentOf(env.project, location),
            reservationId,
            body: { throughputCapacity },
          })
          .pipe(Effect.catchTag("Conflict", () => getReservation(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedName = current.name ?? name;
      const mask = fieldMask([
        !sameText(current.throughputCapacity, throughputCapacity) &&
          "throughputCapacity",
      ]);
      if (mask.length > 0) {
        current = yield* pubsublite.patchAdminProjectsLocationsReservations({
          name: observedName,
          updateMask: mask,
          body: {
            name: observedName,
            throughputCapacity,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryInUse(
        ignoreMissing(
          pubsublite.deleteAdminProjectsLocationsReservations({
            name: output.name,
          }),
        ),
      );
      yield* waitUntilGone(getReservation(output.name));
    }),
  });
