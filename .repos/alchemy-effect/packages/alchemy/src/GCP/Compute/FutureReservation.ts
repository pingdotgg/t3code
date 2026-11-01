import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitZoneOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_ZONE = "us-central1-a";

export type FutureReservationTimeWindow = compute.FutureReservationTimeWindow;
export type FutureReservationSpecificSKUProperties =
  compute.FutureReservationSpecificSKUProperties;
export type FutureReservationCommitmentInfo =
  compute.FutureReservationCommitmentInfo;

export type FutureReservationProps = {
  /**
   * Future reservation name (RFC1035, 1-63 chars). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the reservation.
   */
  futureReservationName?: string;
  /**
   * Zone of the reservation (e.g. `us-central1-a`). Immutable — changing
   * it replaces the reservation.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Optional description. Future reservations have no labels field —
   * Alchemy ownership is stored in a `[alchemy …]` prefix for `list` /
   * nuke.
   */
  description?: string;
  /**
   * Delivery window (`startTime` RFC3339 plus `endTime` or `duration`).
   */
  timeWindow?: FutureReservationTimeWindow;
  /**
   * Specific SKU properties (machine type + total count). Mutually
   * exclusive with aggregate accelerator reservations.
   */
  specificSkuProperties?: FutureReservationSpecificSKUProperties;
  /**
   * Planning state. `DRAFT` keeps the reservation off the procurement
   * queue; `SUBMITTED` starts evaluation.
   * @default "DRAFT"
   */
  planningStatus?: compute.FutureReservationPlanningStatusEnum | (string & {});
  /**
   * Name prefix for auto-created reservations at delivery (max 20 chars).
   */
  namePrefix?: string;
  /**
   * Existing reservation name that receives capacity at delivery.
   */
  reservationName?: string;
  /**
   * Auto-delete auto-created reservations at end time. Compute requires this
   * field on insert.
   * @default false
   */
  autoDeleteAutoCreatedReservations?: boolean;
  /**
   * Only VMs that target the reservation by name can consume it.
   */
  specificReservationRequired?: boolean;
  /**
   * Reservation mode (`DEFAULT` or `CALENDAR`).
   */
  reservationMode?:
    | compute.FutureReservationReservationModeEnum
    | (string & {});
  /**
   * Deployment type (`DENSE` or unspecified).
   */
  deploymentType?: compute.FutureReservationDeploymentTypeEnum | (string & {});
  /**
   * Maintenance scheduling (`INDEPENDENT` or `GROUPED`).
   */
  schedulingType?: compute.FutureReservationSchedulingTypeEnum | (string & {});
  /**
   * Commitment attached at delivery, if any.
   */
  commitmentInfo?: FutureReservationCommitmentInfo;
};

export type FutureReservation = Resource<
  "GCP.Compute.FutureReservation",
  FutureReservationProps,
  {
    /** Future reservation name. */
    futureReservationName: string;
    /** Project id. */
    project: string;
    /** Zone short name. */
    zone: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Delivery window. */
    timeWindow: FutureReservationTimeWindow | undefined;
    /** Specific SKU properties. */
    specificSkuProperties: FutureReservationSpecificSKUProperties | undefined;
    /** Planning status. */
    planningStatus: string | undefined;
    /** Name prefix for auto-created reservations. */
    namePrefix: string | undefined;
    /** Target reservation name. */
    reservationName: string | undefined;
    /** Procurement / amendment status. */
    status: compute.FutureReservationStatus | undefined;
    /** Server-assigned numeric id. */
    futureReservationId: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine future reservation.
 *
 * Future reservations lock capacity for a later delivery window. Name and
 * zone replace the resource; description, planning status, and the time
 * window update in place via `futureReservations.patch`. Compute has no
 * labels field, so Alchemy stamps ownership into the description.
 *
 * Creating a reservation typically requires quota and, for `CALENDAR`
 * mode, GPU/TPU SKUs. Draft reservations (`planningStatus: "DRAFT"`) stay
 * off the procurement queue.
 *
 * ### Creating a Future Reservation
 * **Example:** Draft n2 capacity
 * ```typescript
 * const reservation = yield* GCP.Compute.FutureReservation("burst", {
 *   planningStatus: "DRAFT",
 *   timeWindow: {
 *     startTime: "2030-06-01T00:00:00Z",
 *     endTime: "2030-06-08T00:00:00Z",
 *   },
 *   specificSkuProperties: {
 *     totalCount: "1",
 *     instanceProperties: { machineType: "n2-standard-2" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const FutureReservation = Resource<FutureReservation>(
  "GCP.Compute.FutureReservation",
);

export class FutureReservationNotResolved extends Data.TaggedError(
  "GCP.Compute.FutureReservationNotResolved",
)<{
  futureReservationName: string;
  zone: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || value;
};

const zoneOf = (value: string | undefined): string =>
  lastSegment(value) || DEFAULT_ZONE;

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `f${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "futurereservation";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

const toBody = (
  name: string,
  props: FutureReservationProps,
  ownership: Record<string, string>,
): compute.FutureReservation => ({
  name,
  description: encodeDescription(ownership, props.description),
  timeWindow: props.timeWindow,
  specificSkuProperties: props.specificSkuProperties,
  planningStatus: props.planningStatus ?? "DRAFT",
  namePrefix: props.namePrefix,
  reservationName: props.reservationName,
  autoDeleteAutoCreatedReservations:
    props.autoDeleteAutoCreatedReservations ?? false,
  specificReservationRequired: props.specificReservationRequired,
  reservationMode: props.reservationMode,
  deploymentType: props.deploymentType,
  schedulingType: props.schedulingType,
  commitmentInfo: props.commitmentInfo,
});

const toAttrs = (
  reservation: compute.FutureReservation,
  project: string,
): FutureReservation["Attributes"] => {
  const parsed = parseDescription(reservation.description);
  return {
    futureReservationName: reservation.name ?? reservation.id ?? "",
    project,
    zone: zoneOf(reservation.zone),
    description: parsed.description,
    timeWindow: reservation.timeWindow,
    specificSkuProperties: reservation.specificSkuProperties,
    planningStatus: reservation.planningStatus,
    namePrefix: reservation.namePrefix,
    reservationName: reservation.reservationName,
    status: reservation.status,
    futureReservationId: reservation.id,
    selfLink: reservation.selfLink,
    creationTimestamp: reservation.creationTimestamp,
  };
};

const needsUpdate = (
  current: compute.FutureReservation,
  desired: compute.FutureReservation,
) => {
  if ((current.description ?? "") !== (desired.description ?? "")) return true;
  if (
    (current.planningStatus ?? "DRAFT") !== (desired.planningStatus ?? "DRAFT")
  ) {
    return true;
  }
  if (jsonOf(current.timeWindow) !== jsonOf(desired.timeWindow)) return true;
  if (
    jsonOf(current.specificSkuProperties) !==
    jsonOf(desired.specificSkuProperties)
  ) {
    return true;
  }
  if ((current.namePrefix ?? "") !== (desired.namePrefix ?? "")) return true;
  if ((current.reservationName ?? "") !== (desired.reservationName ?? "")) {
    return true;
  }
  if (
    (current.autoDeleteAutoCreatedReservations ?? false) !==
    (desired.autoDeleteAutoCreatedReservations ?? false)
  ) {
    return true;
  }
  if (
    (current.specificReservationRequired ?? false) !==
    (desired.specificReservationRequired ?? false)
  ) {
    return true;
  }
  return false;
};

const getByName = (project: string, zone: string, futureReservation: string) =>
  compute
    .getFutureReservations({ project, zone, futureReservation })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  zone: string,
  futureReservationName: string,
) =>
  getByName(project, zone, futureReservationName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (item) => item !== undefined,
      times: 8,
    }),
  );

export const FutureReservationProvider = () =>
  Provider.succeed(FutureReservation, {
    stables: [
      "futureReservationName",
      "project",
      "zone",
      "futureReservationId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.futureReservationName ?? output?.futureReservationName;
      const nextName = news.futureReservationName;
      const previousZone = zoneOf(olds?.zone ?? output?.zone);
      const nextZone = zoneOf(news.zone ?? output?.zone);
      if (
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        previousZone !== nextZone
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            nextName !== undefined &&
            previousName === nextName &&
            previousZone === nextZone,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const futureReservationName = yield* toName(
        id,
        olds?.futureReservationName,
        output?.futureReservationName,
      );
      const zone = zoneOf(olds?.zone ?? output?.zone);
      const existing = yield* getByName(
        env.project,
        zone,
        futureReservationName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListFutureReservations
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.futureReservations ?? [])
              .filter((item) => {
                const { labels } = parseDescription(item.description);
                return Object.keys(labels).some((key) =>
                  key.startsWith("alchemy-"),
                );
              })
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const futureReservationName = yield* toName(
        id,
        news.futureReservationName,
        output?.futureReservationName,
      );
      const zone = zoneOf(news.zone ?? output?.zone);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(futureReservationName, news, ownership);

      let current = yield* getByName(env.project, zone, futureReservationName);

      if (current === undefined) {
        yield* compute
          .insertFutureReservations({
            project: env.project,
            zone,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitZoneOperation(env.project, zone, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* awaitResource(
          env.project,
          zone,
          futureReservationName,
        );
      }

      if (current === undefined) {
        return yield* new FutureReservationNotResolved({
          futureReservationName,
          zone,
        });
      }

      if (needsUpdate(current, desired)) {
        yield* compute
          .updateFutureReservations({
            project: env.project,
            zone,
            futureReservation: futureReservationName,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitZoneOperation(env.project, zone, operation),
            ),
          );
        current = yield* getByName(env.project, zone, futureReservationName);
        if (current === undefined) {
          return yield* new FutureReservationNotResolved({
            futureReservationName,
            zone,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const zone = zoneOf(output.zone);
      const operation = yield* compute
        .deleteFutureReservations({
          project: env.project,
          zone,
          futureReservation: output.futureReservationName,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitZoneOperation(env.project, zone, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
