import * as bigqueryreservation from "@distilled.cloud/gcp/bigqueryreservation_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_EDITION = "ENTERPRISE";
const DEFAULT_SLOT_CAPACITY = "0";
const MAX_NAME_LENGTH = 64;

export type ReservationEdition =
  | bigqueryreservation.ReservationEditionEnum
  | (string & {});

export type ReservationScalingMode =
  | bigqueryreservation.ReservationScalingModeEnum
  | (string & {});

export type ReservationAutoscale = {
  /**
   * Maximum extra slots the reservation may add when demand exceeds
   * baseline `slotCapacity`.
   */
  maxSlots?: string;
};

export type ReservationSchedulingPolicy = {
  /**
   * Soft per-project slot cap for queries in this reservation. Preview.
   */
  maxSlots?: string;
  /**
   * Soft per-project job concurrency cap. Preview.
   */
  concurrency?: string;
};

export type ReservationProps = {
  /**
   * Reservation id (the `{reservation}` segment of
   * `projects/{project}/locations/{location}/reservations/{reservation}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must contain only lowercase letters, digits, or dashes;
   * start with a letter; not end with a dash; max 64 characters.
   * Immutable — changing it replaces the reservation.
   */
  reservationId?: string;
  /**
   * BigQuery location (`us-central1`, `US`, `EU`, …). Immutable —
   * changing it replaces the reservation. Multi-regions `US` and `EU`
   * stay uppercase; regional ids are lowercased (`US-CENTRAL1` becomes
   * `us-central1`).
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Baseline slots. `"0"` is valid for edition reservations that rely on
   * idle slots or autoscale. Immutable identity is unchanged; the value
   * itself is mutable.
   * @default "0"
   */
  slotCapacity?: string;
  /**
   * When true, jobs using this reservation cannot burst into idle slots
   * from sibling reservations. STANDARD edition requires this to be true.
   * @default true when edition is STANDARD, otherwise false
   */
  ignoreIdleSlots?: boolean;
  /**
   * Reservation edition. Immutable — changing it replaces the
   * reservation. `STANDARD` cannot set a non-zero baseline
   * `slotCapacity` (use `autoscale.maxSlots` instead).
   * @default "ENTERPRISE"
   */
  edition?: ReservationEdition;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Autoscale ceiling. Mutually exclusive with `maxSlots` plus
   * `scalingMode`. `STANDARD` reservations are autoscale-only.
   */
  autoscale?: ReservationAutoscale;
  /**
   * Soft target for concurrent jobs. `"0"` lets BigQuery pick.
   */
  concurrency?: string;
  /**
   * Overall slot cap covering baseline, idle, and scaled slots. Must be
   * set together with `scalingMode`.
   */
  maxSlots?: string;
  /**
   * How the reservation uses idle and autoscale slots when `maxSlots` is
   * set (`AUTOSCALE_ONLY`, `IDLE_SLOTS_ONLY`, `ALL_SLOTS`).
   */
  scalingMode?: ReservationScalingMode;
  /**
   * Reservation group this reservation belongs to, as
   * `projects/{project}/locations/{location}/reservationGroups/{group}`
   * or a bare group id.
   */
  reservationGroup?: string;
  /**
   * Secondary location for managed disaster recovery. Setting this on
   * create or update converts the reservation into a failover
   * reservation.
   */
  secondaryLocation?: string;
  /**
   * Place the reservation in the organization's DR secondary region
   * (multi-region `US` or `EU` only). Preview; the project must be
   * allow-listed. Immutable — changing it replaces the reservation.
   */
  multiRegionAuxiliary?: boolean;
  /**
   * Per-project scheduling caps. Preview.
   */
  schedulingPolicy?: ReservationSchedulingPolicy;
};

export type Reservation = Resource<
  "GCP.BigQueryReservation.Reservation",
  ReservationProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/reservations/{reservation}`. */
    name: string;
    /** Reservation id (last path segment). */
    reservationId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `US`, …). */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Baseline slot capacity. */
    slotCapacity: string | undefined;
    /** Whether idle slots from siblings are ignored. */
    ignoreIdleSlots: boolean;
    /** Reservation edition (`STANDARD`, `ENTERPRISE`, …). */
    edition: string | undefined;
    /** Autoscale settings, including current extra slots. */
    autoscale: bigqueryreservation.Autoscale | undefined;
    /** Job concurrency target. */
    concurrency: string | undefined;
    /** Overall slot cap, if set. */
    maxSlots: string | undefined;
    /** Scaling mode used with `maxSlots`. */
    scalingMode: string | undefined;
    /** Reservation group, if any. */
    reservationGroup: string | undefined;
    /** Secondary DR location, if any. */
    secondaryLocation: string | undefined;
    /** Current primary replica location (failover reservations). */
    primaryLocation: string | undefined;
    /** Original primary location used for billing failover reservations. */
    originalPrimaryLocation: string | undefined;
    /** Whether this is a multi-region auxiliary reservation. */
    multiRegionAuxiliary: boolean;
    /** Per-project scheduling policy. */
    schedulingPolicy: bigqueryreservation.SchedulingPolicy | undefined;
    /** DR replication status of the primary replica. */
    replicationStatus: bigqueryreservation.ReplicationStatus | undefined;
    /** RFC3339 creation timestamp. */
    creationTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery slot reservation — a named pool of slots that assignments
 * can consume.
 *
 * Changing `reservationId`, `location`, `edition`, or
 * `multiRegionAuxiliary` replaces the reservation. Baseline capacity,
 * idle-slot behavior, labels, autoscale, and failover location are
 * updated in place.
 *
 * ### Creating a Reservation
 * **Example:** Generated name, zero-slot ENTERPRISE
 * ```typescript
 * const slots = yield* GCP.BigQueryReservation.Reservation("Slots", {});
 * ```
 *
 * **Example:** Explicit id, labels, and idle-slot isolation
 * ```typescript
 * const slots = yield* GCP.BigQueryReservation.Reservation("Slots", {
 *   reservationId: "analytics-prod",
 *   location: "us-central1",
 *   edition: "ENTERPRISE",
 *   slotCapacity: "0",
 *   ignoreIdleSlots: false,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** STANDARD with autoscale
 * ```typescript
 * const slots = yield* GCP.BigQueryReservation.Reservation("Slots", {
 *   location: "US",
 *   edition: "STANDARD",
 *   ignoreIdleSlots: true,
 *   autoscale: { maxSlots: "50" },
 * });
 * ```
 *
 * @resource
 * @category BigQueryReservation
 */
export const Reservation = Resource<Reservation>(
  "GCP.BigQueryReservation.Reservation",
);

export class ReservationNotResolved extends Data.TaggedError(
  "GCP.BigQueryReservation.ReservationNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string) => {
  const value = lastSegment(location);
  const upper = value.toUpperCase();
  if (upper === "US" || upper === "EU") return upper;
  return value.toLowerCase();
};

const normalizeEdition = (edition: string | undefined) => {
  const value = (edition ?? DEFAULT_EDITION).toUpperCase();
  return value === "EDITION_UNSPECIFIED" ? DEFAULT_EDITION : value;
};

const slotCapacityOf = (value: string | undefined) =>
  value === undefined || value === "" ? DEFAULT_SLOT_CAPACITY : value;

const ignoreIdleSlotsOf = (value: boolean | undefined, edition: string) =>
  value ?? edition === "STANDARD";

const resourceName = (
  project: string,
  location: string,
  reservationId: string,
) => `projects/${project}/locations/${location}/reservations/${reservationId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const reservationsAt = parts.lastIndexOf("reservations");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    reservationId:
      reservationsAt >= 0 && parts[reservationsAt + 1]
        ? parts[reservationsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  reservationId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (reservationId !== undefined) return reservationId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    const prefixed = /^[a-z]/.test(generated) ? generated : `r${generated}`;
    return prefixed.replace(/-+$/g, "").slice(0, MAX_NAME_LENGTH);
  });

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

const toAttrs = (current: bigqueryreservation.Reservation, project: string) => {
  const name = current.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    reservationId: parsed.reservationId,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(current.labels),
    slotCapacity: current.slotCapacity,
    ignoreIdleSlots: current.ignoreIdleSlots === true,
    edition: current.edition,
    autoscale: current.autoscale,
    concurrency: current.concurrency,
    maxSlots: current.maxSlots,
    scalingMode: current.scalingMode,
    reservationGroup: current.reservationGroup,
    secondaryLocation: current.secondaryLocation,
    primaryLocation: current.primaryLocation,
    originalPrimaryLocation: current.originalPrimaryLocation,
    multiRegionAuxiliary: current.multiRegionAuxiliary === true,
    schedulingPolicy: current.schedulingPolicy,
    replicationStatus: current.replicationStatus,
    creationTime: current.creationTime,
    updateTime: current.updateTime,
  };
};

const getByName = (name: string) =>
  bigqueryreservation
    .getProjectsLocationsReservations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwnedAt = (project: string, location: string) =>
  bigqueryreservation.listProjectsLocationsReservations
    .pages({
      parent: parentOf(project, location),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.reservations ?? [])),
      Stream.filter((item) =>
        Object.keys(item.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((item) => toAttrs(item, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const desiredAutoscale = (
  news: ReservationProps,
): bigqueryreservation.Autoscale | undefined =>
  news.autoscale === undefined
    ? undefined
    : compact({ maxSlots: news.autoscale.maxSlots });

const desiredSchedulingPolicy = (
  news: ReservationProps,
): bigqueryreservation.SchedulingPolicy | undefined =>
  news.schedulingPolicy === undefined
    ? undefined
    : compact({
        maxSlots: news.schedulingPolicy.maxSlots,
        concurrency: news.schedulingPolicy.concurrency,
      });

const toBody = (
  news: ReservationProps,
  labels: Record<string, string>,
  extras: {
    edition?: string;
    slotCapacity: string;
    ignoreIdleSlots: boolean;
  },
): bigqueryreservation.Reservation =>
  compact({
    slotCapacity: extras.slotCapacity,
    ignoreIdleSlots: extras.ignoreIdleSlots,
    edition: extras.edition,
    labels,
    autoscale: desiredAutoscale(news),
    concurrency: news.concurrency,
    maxSlots: news.maxSlots,
    scalingMode: news.scalingMode,
    reservationGroup: news.reservationGroup,
    secondaryLocation: news.secondaryLocation,
    multiRegionAuxiliary: news.multiRegionAuxiliary,
    schedulingPolicy: desiredSchedulingPolicy(news),
  });

export const ReservationProvider = () =>
  Provider.succeed(Reservation, {
    stables: [
      "name",
      "reservationId",
      "project",
      "location",
      "edition",
      "creationTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.reservationId ?? output?.reservationId;
      const nextId = news.reservationId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const previousEdition = normalizeEdition(
        olds?.edition ?? output?.edition,
      );
      const nextEdition = normalizeEdition(news.edition ?? previousEdition);
      const previousAuxiliary =
        olds?.multiRegionAuxiliary ?? output?.multiRegionAuxiliary;
      const nextAuxiliary =
        news.multiRegionAuxiliary ?? previousAuxiliary ?? false;

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousEdition !== nextEdition ||
        (previousAuxiliary === true) !== (nextAuxiliary === true);

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
      const reservationId = yield* toId(
        id,
        olds?.reservationId,
        output?.reservationId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, reservationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          Array.from(new Set([env.region, "US", "EU"])),
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
      const reservationId = yield* toId(
        id,
        news.reservationId,
        output?.reservationId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, reservationId);
      const parent = parentOf(env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const edition = normalizeEdition(news.edition ?? output?.edition);
      const slotCapacity = slotCapacityOf(news.slotCapacity);
      const ignoreIdleSlots = ignoreIdleSlotsOf(news.ignoreIdleSlots, edition);
      const createBody = toBody(news, desiredLabels, {
        edition,
        slotCapacity,
        ignoreIdleSlots,
      });

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigqueryreservation
          .createProjectsLocationsReservations({
            parent,
            reservationId,
            body: createBody,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ReservationNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const slotCapacityChanged =
        slotCapacityOf(current.slotCapacity) !== slotCapacity;
      const ignoreIdleSlotsChanged =
        (current.ignoreIdleSlots === true) !== ignoreIdleSlots;
      const autoscaleChanged =
        news.autoscale !== undefined &&
        (current.autoscale?.maxSlots ?? "") !== (news.autoscale.maxSlots ?? "");
      const concurrencyChanged =
        news.concurrency !== undefined &&
        (current.concurrency ?? "") !== news.concurrency;
      const maxSlotsChanged =
        news.maxSlots !== undefined &&
        (current.maxSlots ?? "") !== news.maxSlots;
      const scalingModeChanged =
        news.scalingMode !== undefined &&
        (current.scalingMode ?? "") !== news.scalingMode;
      const reservationGroupChanged =
        news.reservationGroup !== undefined &&
        (current.reservationGroup ?? "") !== news.reservationGroup;
      const secondaryLocationChanged =
        news.secondaryLocation !== undefined &&
        (current.secondaryLocation ?? "") !== news.secondaryLocation;
      const schedulingPolicyChanged =
        news.schedulingPolicy !== undefined &&
        jsonOf(current.schedulingPolicy) !==
          jsonOf(desiredSchedulingPolicy(news));

      const updateMask = [
        labelsChanged ? "labels" : undefined,
        slotCapacityChanged ? "slotCapacity" : undefined,
        ignoreIdleSlotsChanged ? "ignoreIdleSlots" : undefined,
        autoscaleChanged ? "autoscale" : undefined,
        concurrencyChanged ? "concurrency" : undefined,
        maxSlotsChanged ? "maxSlots" : undefined,
        scalingModeChanged ? "scalingMode" : undefined,
        reservationGroupChanged ? "reservationGroup" : undefined,
        secondaryLocationChanged ? "secondaryLocation" : undefined,
        schedulingPolicyChanged ? "schedulingPolicy" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* bigqueryreservation.patchProjectsLocationsReservations(
          {
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: toBody(news, desiredLabels, {
              slotCapacity,
              ignoreIdleSlots,
            }),
          },
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigqueryreservation
        .deleteProjectsLocationsReservations({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
