import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  normalizeRegion,
  parseDescription,
  runRegionOp,
  toPhysicalName,
} from "./internal.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_POLICY_TYPE = "BACKEND_SERVICE_POLICY";
const DEFAULT_MIN_HEALTHY = 1;
const DEFAULT_HEALTHY_PERCENT = 60;

export type RegionHealthAggregationPolicyType =
  | compute.HealthAggregationPolicyPolicyTypeEnum
  | (string & {});

export type RegionHealthAggregationPolicyProps = {
  /**
   * Policy name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the policy.
   */
  policyName?: string;
  /**
   * Region the policy lives in. Immutable — changing it replaces the
   * policy. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Health aggregation policies have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix for
   * `list` / nuke.
   */
  description?: string;
  /**
   * Policy type. Regional policies must be `BACKEND_SERVICE_POLICY`.
   * Immutable — changing it replaces the policy.
   * @default "BACKEND_SERVICE_POLICY"
   */
  policyType?: RegionHealthAggregationPolicyType;
  /**
   * Minimum number of healthy endpoints required for the aggregate to be
   * HEALTHY. Must be positive.
   * @default 1
   */
  minHealthyThreshold?: number;
  /**
   * Percent of healthy endpoints required for the aggregate to be
   * HEALTHY. Range `[0, 100]`.
   * @default 60
   */
  healthyPercentThreshold?: number;
};

export type RegionHealthAggregationPolicy = Resource<
  "GCP.Compute.RegionHealthAggregationPolicy",
  RegionHealthAggregationPolicyProps,
  {
    /** Policy name. */
    policyName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Policy type. */
    policyType: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Minimum healthy endpoint count. */
    minHealthyThreshold: number;
    /** Healthy percent threshold. */
    healthyPercentThreshold: number;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-defined URL including the numeric id. */
    selfLinkWithId: string | undefined;
    /** Server-assigned numeric id. */
    policyId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine health aggregation policy.
 *
 * Health aggregation policies define how endpoint health is rolled up for
 * backend services used by composite health checks. Type is immutable —
 * changing it replaces the policy. Thresholds and description update in
 * place via `regionHealthAggregationPolicies.patch`.
 *
 * ### Creating a Health Aggregation Policy
 * **Example:** Generated name with defaults
 * ```typescript
 * const policy = yield* GCP.Compute.RegionHealthAggregationPolicy(
 *   "Agg",
 *   {},
 * );
 * ```
 *
 * **Example:** Custom thresholds
 * ```typescript
 * const policy = yield* GCP.Compute.RegionHealthAggregationPolicy(
 *   "Agg",
 *   {
 *     description: "backend rollup",
 *     minHealthyThreshold: 2,
 *     healthyPercentThreshold: 80,
 *   },
 * );
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionHealthAggregationPolicy =
  Resource<RegionHealthAggregationPolicy>(
    "GCP.Compute.RegionHealthAggregationPolicy",
  );

export class RegionHealthAggregationPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionHealthAggregationPolicyNotResolved",
)<{
  policyName: string;
  region: string;
}> {}

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_POLICY_TYPE).toUpperCase();

const toAttrs = (
  policy: compute.HealthAggregationPolicy,
  project: string,
): RegionHealthAggregationPolicy["Attributes"] => {
  const parsed = parseDescription(policy.description);
  return {
    policyName: policy.name ?? lastSegment(policy.selfLink),
    project,
    region: lastSegment(policy.region).toLowerCase(),
    policyType: typeOf(policy.policyType),
    description: parsed.description,
    minHealthyThreshold: policy.minHealthyThreshold ?? DEFAULT_MIN_HEALTHY,
    healthyPercentThreshold:
      policy.healthyPercentThreshold ?? DEFAULT_HEALTHY_PERCENT,
    fingerprint: policy.fingerprint,
    selfLink: policy.selfLink,
    selfLinkWithId: policy.selfLinkWithId,
    policyId: policy.id,
    creationTimestamp: policy.creationTimestamp,
    kind: policy.kind,
  };
};

const getByName = (project: string, region: string, name: string) =>
  compute
    .getRegionHealthAggregationPolicies({
      project,
      region,
      healthAggregationPolicy: name,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, region: string, policyName: string) =>
  getByName(project, region, policyName).pipe(
    Effect.flatMap((policy) =>
      policy !== undefined
        ? Effect.succeed(policy)
        : Effect.fail(
            new RegionHealthAggregationPolicyNotResolved({
              policyName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionHealthAggregationPolicyNotResolved",
      times: 20,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const RegionHealthAggregationPolicyProvider = () =>
  Provider.succeed(RegionHealthAggregationPolicy, {
    stables: [
      "policyName",
      "project",
      "region",
      "policyType",
      "policyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.policyName ?? output?.policyName;
      const nextName = news.policyName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? (previousRegion || env.region),
        env.region,
      );
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const regionChanged =
        previousRegion.length > 0 && previousRegion !== nextRegion;
      const previousType = typeOf(olds?.policyType ?? output?.policyType);
      const nextType = typeOf(news.policyType ?? output?.policyType);
      if (nameChanged || regionChanged || previousType !== nextType) {
        return {
          action: "replace" as const,
          deleteFirst:
            !nameChanged || nextName === undefined || nextName === previousName,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const policyName = yield* toPhysicalName(
        id,
        olds?.policyName,
        output?.policyName,
        "policy",
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, policyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages =
          yield* compute.aggregatedListRegionHealthAggregationPolicies
            .pages({
              project: env.project,
              maxResults: 500,
              returnPartialSuccess: true,
            })
            .pipe(
              Stream.runCollect,
              Effect.catchTag("NotFound", () => Effect.succeed([] as never[])),
            );
        return Array.from(
          pages as readonly compute.HealthAggregationPolicyAggregatedList[],
        ).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.healthAggregationPolicies ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const policyName = yield* toPhysicalName(
        id,
        news.policyName,
        output?.policyName,
        "policy",
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const policyType = typeOf(news.policyType);
      const minHealthyThreshold =
        news.minHealthyThreshold ?? DEFAULT_MIN_HEALTHY;
      const healthyPercentThreshold =
        news.healthyPercentThreshold ?? DEFAULT_HEALTHY_PERCENT;

      let current = yield* getByName(env.project, region, policyName);

      if (current === undefined) {
        yield* runRegionOp(
          env.project,
          region,
          compute.insertRegionHealthAggregationPolicies({
            project: env.project,
            region,
            body: {
              name: policyName,
              description: desiredDescription,
              policyType,
              minHealthyThreshold,
              healthyPercentThreshold,
            },
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(env.project, region, policyName);
      }

      if (current === undefined) {
        return yield* new RegionHealthAggregationPolicyNotResolved({
          policyName,
          region,
        });
      }

      const patch: compute.HealthAggregationPolicy = {
        fingerprint: current.fingerprint,
      };
      let dirty = false;
      if ((current.description ?? "") !== desiredDescription) {
        patch.description = desiredDescription;
        dirty = true;
      }
      if (
        (current.minHealthyThreshold ?? DEFAULT_MIN_HEALTHY) !==
        minHealthyThreshold
      ) {
        patch.minHealthyThreshold = minHealthyThreshold;
        dirty = true;
      }
      if (
        (current.healthyPercentThreshold ?? DEFAULT_HEALTHY_PERCENT) !==
        healthyPercentThreshold
      ) {
        patch.healthyPercentThreshold = healthyPercentThreshold;
        dirty = true;
      }
      if (dirty) {
        yield* runRegionOp(
          env.project,
          region,
          compute.patchRegionHealthAggregationPolicies({
            project: env.project,
            region,
            healthAggregationPolicy: policyName,
            body: patch,
          }),
        );
        current =
          (yield* getByName(env.project, region, policyName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      yield* runRegionOp(
        env.project,
        region,
        compute.deleteRegionHealthAggregationPolicies({
          project: env.project,
          region,
          healthAggregationPolicy: output.policyName,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }),
  });
