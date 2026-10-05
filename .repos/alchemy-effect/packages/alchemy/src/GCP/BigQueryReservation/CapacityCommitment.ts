import * as bigqueryreservation from "@distilled.cloud/gcp/bigqueryreservation_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  compact,
  listLocations,
  hasOwnershipMarker,
  lastSegment,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  parseResourceName,
  toResourceId,
} from "./internal.ts";

const DEFAULT_EDITION = "ENTERPRISE";

export type CapacityCommitmentPlan =
  | bigqueryreservation.CapacityCommitmentPlanEnum
  | (string & {});

export type CapacityCommitmentEdition =
  | bigqueryreservation.CapacityCommitmentEditionEnum
  | (string & {});

export type CapacityCommitmentRenewalPlan =
  | bigqueryreservation.CapacityCommitmentRenewalPlanEnum
  | (string & {});

export type CapacityCommitmentProps = {
  /**
   * Capacity commitment id (the `{capacityCommitment}` segment of
   * `projects/{project}/locations/{location}/capacityCommitments/{capacityCommitment}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must contain only lowercase letters, digits, or dashes;
   * start with a letter; not end with a dash; max 64 characters.
   * Commitments have no labels field, so Alchemy stamps ownership into
   * this id (`alch---…`) for `list` / nuke. Immutable — changing it
   * replaces the commitment. Split/merge drops a caller-assigned id.
   */
  capacityCommitmentId?: string;
  /**
   * BigQuery location (`us-central1`, `US`, `EU`, …). Immutable —
   * changing it replaces the commitment. Multi-regions `US` and `EU`
   * stay uppercase; regional ids are lowercased.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Number of slots in this commitment. Immutable — changing it
   * replaces the commitment. Edition commitments are typically sold in
   * 50-slot increments (legacy flat-rate in 100-slot increments).
   */
  slotCount: string;
  /**
   * Commitment plan (`FLEX`, `MONTHLY`, `ANNUAL`, `THREE_YEAR`, and
   * the `*_FLAT_RATE` variants). `FLEX` (or `FLEX_FLAT_RATE`) can be
   * deleted about 60 seconds after it becomes `ACTIVE`. Longer plans
   * cannot be deleted until they expire or are converted to a shorter
   * plan after expiry. Plan may be updated in place only to a longer
   * committed period.
   */
  plan: CapacityCommitmentPlan;
  /**
   * Plan this commitment converts to after `commitmentEndTime`. Only
   * applicable for `ANNUAL` and `TRIAL` commitments.
   */
  renewalPlan?: CapacityCommitmentRenewalPlan;
  /**
   * Reservation edition. Immutable — changing it replaces the
   * commitment. `STANDARD` cannot purchase commitments; use
   * `ENTERPRISE` or `ENTERPRISE_PLUS`.
   * @default "ENTERPRISE"
   */
  edition?: CapacityCommitmentEdition;
  /**
   * Place the commitment in the organization's DR secondary region
   * (multi-region `US` or `EU` only). Preview; the project must be
   * allow-listed. Immutable — changing it replaces the commitment.
   */
  multiRegionAuxiliary?: boolean;
  /**
   * When true, fail the create if another project in the organization
   * already has a capacity commitment.
   * @default false
   */
  enforceSingleAdminProjectPerOrg?: boolean;
};

export type CapacityCommitment = Resource<
  "GCP.BigQueryReservation.CapacityCommitment",
  CapacityCommitmentProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/capacityCommitments/{capacityCommitment}`. */
    name: string;
    /** Capacity commitment id (last path segment), including the Alchemy prefix. */
    capacityCommitmentId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `US`, …). */
    location: string;
    /** Number of slots. */
    slotCount: string | undefined;
    /** Commitment plan. */
    plan: string | undefined;
    /** Renewal plan, if set. */
    renewalPlan: string | undefined;
    /** Reservation edition. */
    edition: string | undefined;
    /** Commitment state (`PENDING`, `ACTIVE`, `FAILED`). */
    state: string | undefined;
    /** Whether this is a legacy flat-rate commitment. */
    isFlatRate: boolean;
    /** Whether this is a multi-region auxiliary commitment. */
    multiRegionAuxiliary: boolean;
    /** RFC3339 start of the current commitment period. */
    commitmentStartTime: string | undefined;
    /** RFC3339 end of the current commitment period. */
    commitmentEndTime: string | undefined;
    /** Failure reason when `state` is `FAILED`. */
    failureStatus: bigqueryreservation.Status | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery capacity commitment — purchased slot capacity with a
 * committed period of usage.
 *
 * Commitments have no labels, so Alchemy stamps ownership into the
 * commitment id (`alch---…`) so `list` / `pnpm nuke:gcp` can find them.
 * Changing `capacityCommitmentId`, `location`, `slotCount`, `edition`,
 * or `multiRegionAuxiliary` replaces the commitment. `plan` and
 * `renewalPlan` update in place (plan can only lengthen).
 *
 * `FLEX` commitments can be deleted about 60 seconds after they become
 * `ACTIVE`. Annual and three-year commitments cannot be deleted until
 * they expire.
 *
 * ### Creating a Capacity Commitment
 * **Example:** Flex Enterprise slots
 * ```typescript
 * const commit = yield* GCP.BigQueryReservation.CapacityCommitment("Flex", {
 *   location: "US",
 *   slotCount: "50",
 *   plan: "FLEX_FLAT_RATE",
 *   edition: "ENTERPRISE",
 * });
 * ```
 *
 * **Example:** Annual commitment with flex renewal
 * ```typescript
 * const commit = yield* GCP.BigQueryReservation.CapacityCommitment("Year", {
 *   location: "US",
 *   slotCount: "100",
 *   plan: "ANNUAL",
 *   renewalPlan: "FLEX",
 *   edition: "ENTERPRISE",
 * });
 * ```
 *
 * @resource
 * @category BigQueryReservation
 */
export const CapacityCommitment = Resource<CapacityCommitment>(
  "GCP.BigQueryReservation.CapacityCommitment",
);

export class CapacityCommitmentNotResolved extends Data.TaggedError(
  "GCP.BigQueryReservation.CapacityCommitmentNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  capacityCommitmentId: string,
) =>
  `projects/${project}/locations/${location}/capacityCommitments/${capacityCommitmentId}`;

const normalizeEdition = (edition: string | undefined) => {
  const value = (edition ?? DEFAULT_EDITION).toUpperCase();
  return value === "EDITION_UNSPECIFIED" ? DEFAULT_EDITION : value;
};

const normalizePlan = (plan: string) => plan.toUpperCase();

const toAttrs = (
  current: bigqueryreservation.CapacityCommitment,
  project: string,
) => {
  const name = current.name ?? "";
  const parsed = parseResourceName(name, "capacityCommitments");
  return {
    name,
    capacityCommitmentId: parsed.resourceId,
    project: parsed.project || project,
    location: parsed.location,
    slotCount: current.slotCount,
    plan: current.plan,
    renewalPlan: current.renewalPlan,
    edition: current.edition,
    state: current.state,
    isFlatRate: current.isFlatRate === true,
    multiRegionAuxiliary: current.multiRegionAuxiliary === true,
    commitmentStartTime: current.commitmentStartTime,
    commitmentEndTime: current.commitmentEndTime,
    failureStatus: current.failureStatus,
  };
};

const getByName = (name: string) =>
  bigqueryreservation
    .getProjectsLocationsCapacityCommitments({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilSettled = (name: string) =>
  getByName(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (row) => row === undefined || row.state !== "PENDING",
      times: 10,
    }),
  );

const listOwnedAt = (project: string, location: string) =>
  bigqueryreservation.listProjectsLocationsCapacityCommitments
    .pages({
      parent: parentOf(project, location),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.capacityCommitments ?? []),
      ),
      Stream.filter((item) => hasOwnershipMarker(lastSegment(item.name ?? ""))),
      Stream.map((item) => toAttrs(item, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toBody = (
  news: CapacityCommitmentProps,
  edition: string,
): bigqueryreservation.CapacityCommitment =>
  compact({
    slotCount: news.slotCount,
    plan: news.plan,
    edition,
    renewalPlan: news.renewalPlan,
    multiRegionAuxiliary: news.multiRegionAuxiliary,
  });

const stillCommitted = (
  error: bigqueryreservation.DeleteProjectsLocationsCapacityCommitmentsError,
) => error._tag === "Conflict" || error._tag === "CapacityCommitmentNotExpired";

export const CapacityCommitmentProvider = () =>
  Provider.succeed(CapacityCommitment, {
    stables: [
      "name",
      "capacityCommitmentId",
      "project",
      "location",
      "edition",
      "slotCount",
      "commitmentStartTime",
    ],

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId =
        olds?.capacityCommitmentId ?? output?.capacityCommitmentId;
      const nextId = yield* toResourceId(
        id,
        news.capacityCommitmentId,
        previousId,
      );
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
        olds?.multiRegionAuxiliary ?? output?.multiRegionAuxiliary ?? false;
      const nextAuxiliary = news.multiRegionAuxiliary ?? previousAuxiliary;
      const previousSlots = olds?.slotCount ?? output?.slotCount;
      const nextSlots = news.slotCount ?? previousSlots;

      const replace =
        (previousId !== undefined && nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousEdition !== nextEdition ||
        previousAuxiliary !== nextAuxiliary ||
        (previousSlots !== undefined &&
          nextSlots !== undefined &&
          previousSlots !== nextSlots);

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
      const capacityCommitmentId = yield* toResourceId(
        id,
        olds?.capacityCommitmentId,
        output?.capacityCommitmentId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, capacityCommitmentId);
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
      const capacityCommitmentId = yield* toResourceId(
        id,
        news.capacityCommitmentId,
        output?.capacityCommitmentId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, capacityCommitmentId);
      const parent = parentOf(env.project, location);
      const edition = normalizeEdition(news.edition ?? output?.edition);
      const createBody = toBody(news, edition);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigqueryreservation
          .createProjectsLocationsCapacityCommitments({
            parent,
            capacityCommitmentId,
            enforceSingleAdminProjectPerOrg:
              news.enforceSingleAdminProjectPerOrg,
            body: createBody,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
        if (current?.state === "PENDING") {
          current = (yield* waitUntilSettled(current.name ?? name)) ?? current;
        }
      }

      if (current === undefined) {
        return yield* new CapacityCommitmentNotResolved({ name });
      }

      const desiredPlan = normalizePlan(news.plan);
      const observedPlan = normalizePlan(current.plan ?? desiredPlan);
      const planChanged = observedPlan !== desiredPlan;
      const renewalChanged =
        news.renewalPlan !== undefined &&
        (current.renewalPlan ?? "") !== news.renewalPlan;

      const updateMask = [
        planChanged ? "plan" : undefined,
        renewalChanged ? "renewalPlan" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current =
          yield* bigqueryreservation.patchProjectsLocationsCapacityCommitments({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: compact({
              plan: news.plan,
              renewalPlan: news.renewalPlan,
            }),
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigqueryreservation
        .deleteProjectsLocationsCapacityCommitments({
          name: output.name,
          force: true,
        })
        .pipe(
          Effect.retry({
            while: stillCommitted,
            times: 8,
            schedule: Schedule.spaced("8 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
