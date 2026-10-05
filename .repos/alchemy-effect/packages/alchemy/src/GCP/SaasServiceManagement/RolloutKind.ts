import * as saasservicemgmt from "@distilled.cloud/gcp/saasservicemgmt_v1";
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
  ResourceNotResolved,
  collectPages,
  expandName,
  fieldMask,
  fingerprint,
  hasAlchemyLabelKeys,
  lastSegment,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameRef,
  toPhysicalId,
  userAnnotations,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "rolloutKinds";

export type RolloutKindUpdateUnitKindStrategy =
  | saasservicemgmt.RolloutKindUpdateUnitKindStrategyEnum
  | (string & {});

export type RolloutKindErrorBudget = {
  /** Max percent of units in a location allowed to fail without pausing. */
  allowedPercentage?: number;
  /** Max number of failed units in a location without pausing. */
  allowedCount?: number;
};

export type RolloutKindUnitUpdatePacing = {
  /** Max percent of units that may be in-flight in a region. */
  maxConcurrentOperationsPercent?: { value?: string };
  /** Absolute cap on concurrent unit operations. */
  maxConcurrentOperationsCount?: number;
};

export type RolloutKindProps = {
  /**
   * RolloutKind id (the `{rollout_kind_id}` segment of
   * `projects/{project}/locations/{location}/rolloutKinds/{rollout_kind_id}`).
   * If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the rollout kind.
   */
  rolloutKindId?: string;
  /**
   * Region of the rollout kind (`us-central1`, …). Immutable — changing
   * it replaces the rollout kind. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * UnitKind whose units this rollout kind targets. Accepts a unit kind
   * id or a full resource name. Immutable — changing it replaces the
   * rollout kind.
   */
  unitKind: string;
  /**
   * Orchestration strategy, e.g. `Google.Cloud.Simple.AllAtOnce` or
   * `Google.Cloud.Simple.OneLocationAtATime`.
   */
  rolloutOrchestrationStrategy?: string;
  /**
   * When to update the unit kind (`UPDATE_UNIT_KIND_STRATEGY_ON_START`
   * or `UPDATE_UNIT_KIND_STRATEGY_NEVER`).
   */
  updateUnitKindStrategy?: RolloutKindUpdateUnitKindStrategy;
  /**
   * Pause the rollout if failures exceed this budget.
   */
  errorBudget?: RolloutKindErrorBudget;
  /**
   * CEL filter reducing the eligible unit population.
   */
  unitFilter?: string;
  /**
   * Cap on concurrent unit operations per region.
   */
  unitUpdatePacing?: RolloutKindUnitUpdatePacing;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations preserved across updates.
   */
  annotations?: Record<string, string>;
};

export type RolloutKind = Resource<
  "GCP.SaasServiceManagement.RolloutKind",
  RolloutKindProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/rolloutKinds/{rollout_kind_id}`. */
    name: string;
    /** RolloutKind id (last path segment). */
    rolloutKindId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** UnitKind resource name. */
    unitKind: string | undefined;
    /** UnitKind id (last path segment). */
    unitKindId: string | undefined;
    /** Orchestration strategy. */
    rolloutOrchestrationStrategy: string | undefined;
    /** Unit-kind update strategy. */
    updateUnitKindStrategy: string | undefined;
    /** Error budget. */
    errorBudget: RolloutKindErrorBudget | undefined;
    /** CEL unit filter. */
    unitFilter: string | undefined;
    /** Concurrent-operation pacing. */
    unitUpdatePacing: RolloutKindUnitUpdatePacing | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Server UUID. */
    uid: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Lifecycle Manager rollout kind — the policy a Rollout follows
 * when upgrading units of a UnitKind.
 *
 * `rolloutKindId`, `location`, and `unitKind` replace the rollout kind.
 * Strategy, error budget, unit filter, pacing, labels, and annotations
 * update in place.
 *
 * ### Creating a RolloutKind
 * **Example:** All-at-once
 * ```typescript
 * const kind = yield* GCP.SaasServiceManagement.RolloutKind("Wave", {
 *   unitKind: storeKind.name,
 *   rolloutOrchestrationStrategy: "Google.Cloud.Simple.AllAtOnce",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a RolloutKind
 * **Example:** Tighten the error budget
 * ```typescript
 * const kind = yield* GCP.SaasServiceManagement.RolloutKind("Wave", {
 *   rolloutKindId: kind.rolloutKindId,
 *   unitKind: storeKind.name,
 *   errorBudget: { allowedCount: 1, allowedPercentage: 5 },
 * });
 * ```
 *
 * @resource
 * @category SaasServiceManagement
 */
export const RolloutKind = Resource<RolloutKind>(
  "GCP.SaasServiceManagement.RolloutKind",
);

const toAttrs = (item: saasservicemgmt.RolloutKind, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    rolloutKindId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    unitKind: item.unitKind,
    unitKindId: item.unitKind ? lastSegment(item.unitKind) : undefined,
    rolloutOrchestrationStrategy: item.rolloutOrchestrationStrategy,
    updateUnitKindStrategy: item.updateUnitKindStrategy,
    errorBudget: item.errorBudget
      ? {
          allowedPercentage: item.errorBudget.allowedPercentage,
          allowedCount: item.errorBudget.allowedCount,
        }
      : undefined,
    unitFilter: item.unitFilter,
    unitUpdatePacing: item.unitUpdatePacing
      ? {
          maxConcurrentOperationsPercent:
            item.unitUpdatePacing.maxConcurrentOperationsPercent,
          maxConcurrentOperationsCount:
            item.unitUpdatePacing.maxConcurrentOperationsCount,
        }
      : undefined,
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    uid: item.uid,
    etag: item.etag,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : saasservicemgmt
        .getProjectsLocationsRolloutKinds({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location: string) =>
  collectPages(
    saasservicemgmt.listProjectsLocationsRolloutKinds.pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    }),
    (page) => page.rolloutKinds,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelKeys(item.labels)),
    ),
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : collectPages(
            saasservicemgmt.listProjectsLocationsRolloutKinds.pages({
              parent: parentOf(project, location),
              pageSize: 1000,
            }),
            (page) => page.rolloutKinds,
          ).pipe(
            Effect.map((fallback) =>
              fallback.filter((item) => hasAlchemyLabelKeys(item.labels)),
            ),
          ),
    ),
  );

export const RolloutKindProvider = () =>
  Provider.succeed(RolloutKind, {
    stables: [
      "name",
      "rolloutKindId",
      "project",
      "location",
      "unitKindId",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.rolloutKindId ?? output?.rolloutKindId,
        nextId:
          news.rolloutKindId ?? olds?.rolloutKindId ?? output?.rolloutKindId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra: !sameRef(olds?.unitKind ?? output?.unitKind, news.unitKind),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const rolloutKindId = yield* toPhysicalId(
        id,
        olds?.rolloutKindId,
        output?.rolloutKindId,
        "rk",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, rolloutKindId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const rolloutKindId = yield* toPhysicalId(
        id,
        news.rolloutKindId,
        output?.rolloutKindId,
        "rk",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        rolloutKindId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const unitKind = expandName(
        news.unitKind,
        env.project,
        location,
        "unitKinds",
      );
      const annotations = news.annotations;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* saasservicemgmt
          .createProjectsLocationsRolloutKinds({
            parent: parentOf(env.project, location),
            rolloutKindId,
            body: {
              unitKind,
              rolloutOrchestrationStrategy: news.rolloutOrchestrationStrategy,
              updateUnitKindStrategy: news.updateUnitKindStrategy,
              errorBudget: news.errorBudget,
              unitFilter: news.unitFilter,
              unitUpdatePacing: news.unitUpdatePacing,
              labels: desiredLabels,
              annotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const annotationsChanged =
        annotations !== undefined &&
        fingerprint(userAnnotations(current.annotations)) !==
          fingerprint(annotations);
      const strategyChanged =
        news.rolloutOrchestrationStrategy !== undefined &&
        (current.rolloutOrchestrationStrategy ?? "") !==
          news.rolloutOrchestrationStrategy;
      const updateStrategyChanged =
        news.updateUnitKindStrategy !== undefined &&
        (current.updateUnitKindStrategy ?? "") !== news.updateUnitKindStrategy;
      const budgetChanged =
        news.errorBudget !== undefined &&
        fingerprint(current.errorBudget) !== fingerprint(news.errorBudget);
      const filterChanged =
        news.unitFilter !== undefined &&
        (current.unitFilter ?? "") !== news.unitFilter;
      const pacingChanged =
        news.unitUpdatePacing !== undefined &&
        fingerprint(current.unitUpdatePacing) !==
          fingerprint(news.unitUpdatePacing);
      const mask = fieldMask([
        labelsChanged && "labels",
        annotationsChanged && "annotations",
        strategyChanged && "rolloutOrchestrationStrategy",
        updateStrategyChanged && "updateUnitKindStrategy",
        budgetChanged && "errorBudget",
        filterChanged && "unitFilter",
        pacingChanged && "unitUpdatePacing",
      ]);

      if (mask.length > 0) {
        current = yield* saasservicemgmt.patchProjectsLocationsRolloutKinds({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            etag: current.etag,
            rolloutOrchestrationStrategy: news.rolloutOrchestrationStrategy,
            updateUnitKindStrategy: news.updateUnitKindStrategy,
            errorBudget: news.errorBudget,
            unitFilter: news.unitFilter,
            unitUpdatePacing: news.unitUpdatePacing,
            labels: desiredLabels,
            annotations,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* saasservicemgmt
        .deleteProjectsLocationsRolloutKinds({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
