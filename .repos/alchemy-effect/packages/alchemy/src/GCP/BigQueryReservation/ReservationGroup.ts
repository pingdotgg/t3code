import * as bigqueryreservation from "@distilled.cloud/gcp/bigqueryreservation_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  listLocations,
  hasOwnershipMarker,
  lastSegment,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  parseResourceName,
  toResourceId,
} from "./internal.ts";

export type ReservationGroupProps = {
  /**
   * Reservation group id (the `{reservationGroup}` segment of
   * `projects/{project}/locations/{location}/reservationGroups/{reservationGroup}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must contain only lowercase letters, digits, or dashes;
   * start with a letter; not end with a dash; max 64 characters.
   * Groups have no labels field, so Alchemy stamps ownership into this
   * id (`alch---…`) for `list` / nuke. Immutable — changing it replaces
   * the group.
   */
  reservationGroupId?: string;
  /**
   * BigQuery location (`us-central1`, `US`, `EU`, …). Immutable —
   * changing it replaces the group. Multi-regions `US` and `EU` stay
   * uppercase; regional ids are lowercased.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
};

export type ReservationGroup = Resource<
  "GCP.BigQueryReservation.ReservationGroup",
  ReservationGroupProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/reservationGroups/{reservationGroup}`. */
    name: string;
    /** Reservation group id (last path segment), including the Alchemy prefix. */
    reservationGroupId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `US`, …). */
    location: string;
  },
  never,
  Providers
>;

/**
 * A BigQuery reservation group — a named container for reservations.
 *
 * Groups have no labels or description, so Alchemy stamps ownership into
 * the group id (`alch---…`) so `list` / `pnpm nuke:gcp` can find them.
 * There is no update API; `reservationGroupId` and `location` are
 * identity and changing them replaces the group.
 *
 * ### Creating a Reservation Group
 * **Example:** Generated id
 * ```typescript
 * const group = yield* GCP.BigQueryReservation.ReservationGroup("Team", {});
 * ```
 *
 * **Example:** Explicit id and multi-region location
 * ```typescript
 * const group = yield* GCP.BigQueryReservation.ReservationGroup("Team", {
 *   reservationGroupId: "analytics-prod",
 *   location: "US",
 * });
 * ```
 *
 * @resource
 * @category BigQueryReservation
 */
export const ReservationGroup = Resource<ReservationGroup>(
  "GCP.BigQueryReservation.ReservationGroup",
);

export class ReservationGroupNotResolved extends Data.TaggedError(
  "GCP.BigQueryReservation.ReservationGroupNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  reservationGroupId: string,
) =>
  `projects/${project}/locations/${location}/reservationGroups/${reservationGroupId}`;

const toAttrs = (
  current: bigqueryreservation.ReservationGroup,
  project: string,
) => {
  const name = current.name ?? "";
  const parsed = parseResourceName(name, "reservationGroups");
  return {
    name,
    reservationGroupId: parsed.resourceId,
    project: parsed.project || project,
    location: parsed.location,
  };
};

const getByName = (name: string) =>
  bigqueryreservation
    .getProjectsLocationsReservationGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwnedAt = (project: string, location: string) =>
  bigqueryreservation.listProjectsLocationsReservationGroups
    .pages({
      parent: parentOf(project, location),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.reservationGroups ?? []),
      ),
      Stream.filter((item) => hasOwnershipMarker(lastSegment(item.name ?? ""))),
      Stream.map((item) => toAttrs(item, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const ReservationGroupProvider = () =>
  Provider.succeed(ReservationGroup, {
    stables: ["name", "reservationGroupId", "project", "location"],

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.reservationGroupId ?? output?.reservationGroupId;
      const nextId = yield* toResourceId(
        id,
        news.reservationGroupId,
        previousId,
      );
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );

      const replace =
        (previousId !== undefined && nextId !== previousId) ||
        previousLocation !== nextLocation;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const reservationGroupId = yield* toResourceId(
        id,
        olds?.reservationGroupId,
        output?.reservationGroupId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, reservationGroupId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, lastSegment(existing.name ?? "")))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          listLocations(env.region),
          (location) => listOwnedAt(env.project, location),
          { concurrency: 4 },
        );
        const byName = new Map<string, ReturnType<typeof toAttrs>>();
        for (const item of pages.flat()) {
          byName.set(item.name, item);
        }
        return Array.from(byName.values());
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const reservationGroupId = yield* toResourceId(
        id,
        news.reservationGroupId,
        output?.reservationGroupId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, reservationGroupId);
      const parent = parentOf(env.project, location);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigqueryreservation
          .createProjectsLocationsReservationGroups({
            parent,
            reservationGroupId,
            body: {},
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ReservationGroupNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigqueryreservation
        .deleteProjectsLocationsReservationGroups({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
