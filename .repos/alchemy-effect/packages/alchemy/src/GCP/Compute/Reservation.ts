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
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_ZONE = "us-central1-a";
const MAX_NAME_LENGTH = 63;

export type ReservationInstanceProperties =
  compute.AllocationSpecificSKUAllocationReservedInstanceProperties;
export type ReservationShareSettings = compute.ShareSettings;
export type ReservationSharingPolicy =
  compute.AllocationReservationSharingPolicy;
export type ReservationAggregate = compute.AllocationAggregateReservation;
export type ReservationDuration = compute.Duration;
export type ReservationDeploymentType =
  | compute.ReservationDeploymentTypeEnum
  | (string & {});
export type ReservationSchedulingType =
  | compute.ReservationSchedulingTypeEnum
  | (string & {});
export type ReservationProtectionTier =
  | compute.ReservationProtectionTierEnum
  | (string & {});
export type ReservationEarlyAccessMaintenance =
  | compute.ReservationEarlyAccessMaintenanceEnum
  | (string & {});
export type ReservationConfidentialComputeType =
  | compute.ReservationConfidentialComputeTypeEnum
  | (string & {});

export type ReservationSpecificSku = {
  /**
   * Number of reserved VM instances. Mutable in place via
   * `reservations.resize`.
   */
  count: number | string;
  /**
   * Machine shape of each reserved VM. Immutable — changing it replaces
   * the reservation. Mutually exclusive with `sourceInstanceTemplate`.
   */
  instanceProperties?: ReservationInstanceProperties;
  /**
   * Instance template URL used instead of `instanceProperties`. Immutable
   * — changing it replaces the reservation.
   */
  sourceInstanceTemplate?: string;
};

export type ReservationProps = {
  /**
   * Reservation name (RFC1035, 1-63 characters). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Changing the name
   * replaces the reservation.
   */
  reservationName?: string;
  /**
   * Zone the reservation lives in (e.g. `us-central1-a`). Immutable —
   * changing it replaces the reservation.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Optional description. Compute reservations have no labels field, so
   * Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * is stored in a `[alchemy …]` prefix for `list` / nuke. Changing it
   * replaces the reservation.
   */
  description?: string;
  /**
   * Specific-SKU reservation (count + machine shape or instance template).
   * Machine shape and template are immutable; `count` resizes in place.
   */
  specificReservation?: ReservationSpecificSku;
  /**
   * When true, only VMs that target this reservation by name can consume
   * it. Immutable — changing it replaces the reservation.
   * @default false
   */
  specificReservationRequired?: boolean;
  /**
   * Share settings for a shared reservation.
   */
  shareSettings?: ReservationShareSettings;
  /**
   * Resource policies attached to this reservation (placement).
   */
  resourcePolicies?: Record<string, string>;
  /**
   * RFC3339 time when Compute Engine auto-deletes the reservation.
   */
  deleteAtTime?: string;
  /**
   * Duration after create when Compute Engine auto-deletes the
   * reservation.
   */
  deleteAfterDuration?: ReservationDuration;
  /**
   * Allow unplanned (emergent) maintenance for reserved VMs.
   */
  enableEmergentMaintenance?: boolean;
  /**
   * Early-access maintenance enrollment (`NO_EARLY_ACCESS`, `WAVE1`,
   * `WAVE2`).
   */
  earlyAccessMaintenance?: ReservationEarlyAccessMaintenance;
  /**
   * Workload protection tier.
   */
  protectionTier?: ReservationProtectionTier;
  /**
   * Deployment strategy. Immutable — changing it replaces the reservation.
   */
  deploymentType?: ReservationDeploymentType;
  /**
   * Maintenance scheduling type.
   */
  schedulingType?: ReservationSchedulingType;
  /**
   * Confidential compute type.
   */
  confidentialComputeType?: ReservationConfidentialComputeType;
  /**
   * Aggregate (accelerator) reservation. Immutable — switching between
   * specific and aggregate replaces the reservation.
   */
  aggregateReservation?: ReservationAggregate;
  /**
   * Sharing policy with Google Cloud managed services.
   */
  reservationSharingPolicy?: ReservationSharingPolicy;
};

export type Reservation = Resource<
  "GCP.Compute.Reservation",
  ReservationProps,
  {
    /** Reservation name. */
    reservationName: string;
    /** Server-assigned numeric id. */
    reservationId: string | undefined;
    /** Project id. */
    project: string;
    /** Zone short name (`us-central1-a`). */
    zone: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported status (`READY`, `CREATING`, `DELETING`, …). */
    status: string | undefined;
    /** Specific-SKU reservation, if any. */
    specificReservation: compute.AllocationSpecificSKUReservation | undefined;
    /** Whether consumption requires targeting this reservation by name. */
    specificReservationRequired: boolean;
    /** Share settings, if any. */
    shareSettings: ReservationShareSettings | undefined;
    /** Attached resource policies. */
    resourcePolicies: Record<string, string>;
    /** Parent commitment URL, if any. */
    commitment: string | undefined;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine capacity reservation.
 *
 * Reservations hold VM capacity in a zone even when the reserved VMs are
 * not running. Compute Engine has no labels on this resource, so Alchemy
 * stamps ownership into the description (`[alchemy alchemy-stack=…
 * alchemy-stage=… alchemy-id=…]`) so `list` / `pnpm nuke:gcp` can find
 * them.
 *
 * Name, zone, machine shape, `specificReservationRequired`, and
 * `deploymentType` are immutable — changing them replaces the reservation.
 * `specificReservation.count` resizes in place. Description and share
 * settings update in place via `reservations.patch`.
 *
 * ### Creating a Reservation
 * **Example:** One `n1-standard-1` in the default zone
 * ```typescript
 * const reserved = yield* GCP.Compute.Reservation("Burst", {
 *   specificReservation: {
 *     count: 1,
 *     instanceProperties: { machineType: "n1-standard-1" },
 *   },
 *   specificReservationRequired: true,
 * });
 * ```
 *
 * **Example:** Named reservation with a description
 * ```typescript
 * const reserved = yield* GCP.Compute.Reservation("Burst", {
 *   reservationName: "app-burst",
 *   zone: "us-central1-a",
 *   description: "on-demand burst capacity",
 *   specificReservation: {
 *     count: 2,
 *     instanceProperties: { machineType: "n1-standard-1" },
 *   },
 * });
 * ```
 *
 * ### Resizing a Reservation
 * **Example:** Grow count in place
 * ```typescript
 * const reserved = yield* GCP.Compute.Reservation("Burst", {
 *   reservationName: "app-burst",
 *   specificReservation: {
 *     count: 4,
 *     instanceProperties: { machineType: "n1-standard-1" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Reservation = Resource<Reservation>("GCP.Compute.Reservation");

export class ReservationNotResolved extends Data.TaggedError(
  "GCP.Compute.ReservationNotResolved",
)<{
  reservationName: string;
  zone: string;
}> {}

export class ReservationNotReady extends Data.TaggedError(
  "GCP.Compute.ReservationNotReady",
)<{
  reservationName: string;
  status: string;
}> {}

export class ReservationFailed extends Data.TaggedError(
  "GCP.Compute.ReservationFailed",
)<{
  reservationName: string;
  status: string;
}> {}

export class ReservationStillExists extends Data.TaggedError(
  "GCP.Compute.ReservationStillExists",
)<{
  reservationName: string;
  status: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeZone = (zone: string | undefined) =>
  lastSegment(zone ?? DEFAULT_ZONE).toLowerCase();

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `r${generated}`.slice(0, MAX_NAME_LENGTH);
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

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const countOf = (value: number | string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  return String(value);
};

const toBody = (
  reservationName: string,
  props: ReservationProps,
  ownership: Record<string, string>,
): compute.Reservation => ({
  name: reservationName,
  description: encodeDescription(ownership, props.description),
  specificReservation:
    props.specificReservation !== undefined
      ? {
          count: countOf(props.specificReservation.count),
          instanceProperties: props.specificReservation.instanceProperties,
          sourceInstanceTemplate:
            props.specificReservation.sourceInstanceTemplate,
        }
      : undefined,
  specificReservationRequired: props.specificReservationRequired === true,
  shareSettings: props.shareSettings,
  resourcePolicies: props.resourcePolicies,
  deleteAtTime: props.deleteAtTime,
  deleteAfterDuration: props.deleteAfterDuration,
  enableEmergentMaintenance: props.enableEmergentMaintenance,
  earlyAccessMaintenance: props.earlyAccessMaintenance,
  protectionTier: props.protectionTier,
  deploymentType: props.deploymentType,
  schedulingType: props.schedulingType,
  confidentialComputeType: props.confidentialComputeType,
  aggregateReservation: props.aggregateReservation,
  reservationSharingPolicy: props.reservationSharingPolicy,
});

const toAttrs = (
  reservation: compute.Reservation,
  project: string,
): Reservation["Attributes"] => {
  const parsed = parseDescription(reservation.description);
  return {
    reservationName: reservation.name ?? reservation.id ?? "",
    reservationId: reservation.id,
    project,
    zone: normalizeZone(reservation.zone),
    description: parsed.description,
    status: reservation.status,
    specificReservation: reservation.specificReservation,
    specificReservationRequired:
      reservation.specificReservationRequired === true,
    shareSettings: reservation.shareSettings,
    resourcePolicies: tagRecord(reservation.resourcePolicies),
    commitment: reservation.commitment,
    selfLink: reservation.selfLink,
    creationTimestamp: reservation.creationTimestamp,
  };
};

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const getByName = (project: string, zone: string, reservation: string) =>
  compute
    .getReservations({ project, zone, reservation })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitReservationReady = (
  project: string,
  zone: string,
  reservationName: string,
) =>
  getByName(project, zone, reservationName).pipe(
    Effect.flatMap((reservation) =>
      reservation?.status === "INVALID"
        ? Effect.fail(
            new ReservationFailed({
              reservationName,
              status: "INVALID",
            }),
          )
        : Effect.succeed(reservation),
    ),
    Effect.filterOrFail(
      (reservation): reservation is compute.Reservation =>
        reservation !== undefined && reservation.status === "READY",
      (reservation) =>
        new ReservationNotReady({
          reservationName,
          status: reservation?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.ReservationNotReady",
      times: 150,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitReservationGone = (
  project: string,
  zone: string,
  reservationName: string,
) =>
  getByName(project, zone, reservationName).pipe(
    Effect.flatMap((reservation) =>
      reservation === undefined
        ? Effect.void
        : Effect.fail(
            new ReservationStillExists({
              reservationName,
              status: reservation.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof ReservationStillExists,
      times: 150,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const ReservationProvider = () =>
  Provider.succeed(Reservation, {
    stables: [
      "reservationName",
      "reservationId",
      "project",
      "zone",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousName = olds?.reservationName ?? output?.reservationName;
      const nextName = news.reservationName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousZone = normalizeZone(olds?.zone ?? output?.zone);
      const nextZone = normalizeZone(news.zone ?? output?.zone);
      const zoneChanged = previousZone !== nextZone;

      const previousRequired =
        olds?.specificReservationRequired ??
        output?.specificReservationRequired ??
        false;
      const nextRequired = news.specificReservationRequired === true;

      const previousMachine =
        olds?.specificReservation?.instanceProperties?.machineType ??
        output?.specificReservation?.instanceProperties?.machineType;
      const nextMachine =
        news.specificReservation?.instanceProperties?.machineType;
      const machineChanged =
        nextMachine !== undefined &&
        previousMachine !== undefined &&
        previousMachine !== nextMachine;

      const previousTemplate =
        olds?.specificReservation?.sourceInstanceTemplate ??
        output?.specificReservation?.sourceInstanceTemplate;
      const nextTemplate = news.specificReservation?.sourceInstanceTemplate;
      const templateChanged =
        (previousTemplate ?? "") !== (nextTemplate ?? "") &&
        (previousTemplate !== undefined || nextTemplate !== undefined);

      const previousIsAggregate = olds?.aggregateReservation !== undefined;
      const nextIsAggregate = news.aggregateReservation !== undefined;
      const previousIsSpecific =
        (olds?.specificReservation ?? output?.specificReservation) !==
        undefined;
      const nextIsSpecific = news.specificReservation !== undefined;
      const kindChanged =
        (previousIsAggregate && nextIsSpecific) ||
        (previousIsSpecific && nextIsAggregate);

      const deploymentChanged =
        olds?.deploymentType !== undefined &&
        news.deploymentType !== undefined &&
        olds.deploymentType !== news.deploymentType;

      // `reservations.update` accepts a description mask but leaves the
      // stored description unchanged, so a new description replaces.
      const descriptionChanged =
        olds !== undefined &&
        (olds.description ?? "") !== (news.description ?? "");

      if (
        nameChanged ||
        zoneChanged ||
        previousRequired !== nextRequired ||
        machineChanged ||
        templateChanged ||
        kindChanged ||
        deploymentChanged ||
        descriptionChanged
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            nextName === previousName &&
            previousZone === nextZone,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const reservationName = yield* toName(
        id,
        olds?.reservationName,
        output?.reservationName,
      );
      const zone = normalizeZone(olds?.zone ?? output?.zone);
      const existing = yield* getByName(env.project, zone, reservationName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListReservations
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.reservations ?? [])
              .filter((reservation) =>
                hasOwnershipMarker(reservation.description),
              )
              .map((reservation) => toAttrs(reservation, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const reservationName = yield* toName(
        id,
        news.reservationName,
        output?.reservationName,
      );
      const zone = normalizeZone(news.zone ?? output?.zone);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(reservationName, news, ownership);

      let current = yield* getByName(env.project, zone, reservationName);
      if (current?.status === "DELETING") {
        yield* waitReservationGone(env.project, zone, reservationName);
        current = undefined;
      }

      if (current === undefined) {
        const inserted = yield* compute
          .insertReservations({
            project: env.project,
            zone,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitZoneOperation(env.project, zone, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitReservationReady(
          env.project,
          zone,
          reservationName,
        );
      }

      if (current === undefined) {
        return yield* new ReservationNotResolved({
          reservationName,
          zone,
        });
      }

      if (current.status === "CREATING" || current.status === "UPDATING") {
        current = yield* waitReservationReady(
          env.project,
          zone,
          reservationName,
        );
      }

      if (current === undefined) {
        return yield* new ReservationNotResolved({
          reservationName,
          zone,
        });
      }

      const descriptionChanged =
        (current.description ?? "") !== (desired.description ?? "");
      // Compute echoes a default `{ shareType: "LOCAL" }` when unset.
      const shareChanged =
        desired.shareSettings !== undefined &&
        !sameJson(current.shareSettings, desired.shareSettings);
      const emergentChanged =
        (current.enableEmergentMaintenance ?? false) !==
        (desired.enableEmergentMaintenance ?? false);

      if (descriptionChanged || shareChanged || emergentChanged) {
        const patched = yield* compute.updateReservations({
          project: env.project,
          zone,
          reservation: reservationName,
          updateMask: [
            descriptionChanged ? "description" : undefined,
            shareChanged ? "shareSettings" : undefined,
            emergentChanged ? "enableEmergentMaintenance" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          // `reservations.update` rejects a body without `name`.
          body: {
            name: reservationName,
            description: desired.description,
            shareSettings: desired.shareSettings,
            enableEmergentMaintenance: desired.enableEmergentMaintenance,
          },
        });
        yield* waitZoneOperation(env.project, zone, patched);
        current =
          (yield* getByName(env.project, zone, reservationName)) ??
          (yield* waitReservationReady(env.project, zone, reservationName));
      }

      if (current === undefined) {
        return yield* new ReservationNotResolved({
          reservationName,
          zone,
        });
      }

      const desiredCount = desired.specificReservation?.count;
      const observedCount = current.specificReservation?.count;
      if (
        desiredCount !== undefined &&
        observedCount !== undefined &&
        desiredCount !== observedCount
      ) {
        const resized = yield* compute.resizeReservations({
          project: env.project,
          zone,
          reservation: reservationName,
          body: { specificSkuCount: desiredCount },
        });
        yield* waitZoneOperation(env.project, zone, resized);
        current = yield* waitReservationReady(
          env.project,
          zone,
          reservationName,
        );
      }

      if (current === undefined) {
        return yield* new ReservationNotResolved({
          reservationName,
          zone,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const zone = normalizeZone(output.zone);
      const deleted = yield* compute
        .deleteReservations({
          project,
          zone,
          reservation: output.reservationName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (deleted !== undefined) {
        yield* waitZoneOperation(project, zone, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitReservationGone(project, zone, output.reservationName);
    }),
  });
