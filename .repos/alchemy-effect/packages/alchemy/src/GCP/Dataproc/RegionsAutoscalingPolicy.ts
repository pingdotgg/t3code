import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
import type { AutoscalingPolicyProps } from "./AutoscalingPolicy.ts";
import {
  collectPages,
  LIST_LOCATIONS,
  MAX_POLICY_ID_LENGTH,
  defaultWorkerConfig,
  defaultYarnConfig,
  emptyOnMissing,
  fingerprint,
  hasAlchemyLabelMap,
  normalizeLocation,
  parseResourceName,
  regionParent,
  sameJson,
  toPhysicalId,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type RegionsAutoscalingPolicyProps = Omit<
  AutoscalingPolicyProps,
  "location"
> & {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * policy. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  region?: string;
};

export type RegionsAutoscalingPolicy = Resource<
  "GCP.Dataproc.RegionsAutoscalingPolicy",
  RegionsAutoscalingPolicyProps,
  {
    /** Full resource name `projects/{project}/regions/{region}/autoscalingPolicies/{policy}`. */
    name: string;
    /** Policy id (last path segment). */
    policyId: string;
    /** Project id. */
    project: string;
    /** Region id. */
    region: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Cluster topology this policy applies to. */
    clusterType: string | undefined;
    /** Primary worker min instances. */
    workerMinInstances: number | undefined;
    /** Primary worker max instances. */
    workerMaxInstances: number | undefined;
    /** Cooldown period. */
    cooldownPeriod: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataproc autoscaling policy (regions API).
 *
 * Same resource as {@link AutoscalingPolicy} addressed via
 * `projects/{project}/regions/{region}/autoscalingPolicies/{policy}`.
 *
 * ### Creating a Policy
 * **Example:** Generated name
 * ```typescript
 * const policy = yield* GCP.Dataproc.RegionsAutoscalingPolicy("SparkScale", {});
 * ```
 *
 * **Example:** Explicit bounds
 * ```typescript
 * const policy = yield* GCP.Dataproc.RegionsAutoscalingPolicy("SparkScale", {
 *   policyId: "spark-scale-reg",
 *   region: "us-central1",
 *   workerConfig: { minInstances: 2, maxInstances: 6 },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Dataproc
 */
export const RegionsAutoscalingPolicy = Resource<RegionsAutoscalingPolicy>(
  "GCP.Dataproc.RegionsAutoscalingPolicy",
);

export class RegionsAutoscalingPolicyNotResolved extends Data.TaggedError(
  "GCP.Dataproc.RegionsAutoscalingPolicyNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, region: string, policyId: string) =>
  `${regionParent(project, region)}/autoscalingPolicies/${policyId}`;

const toAttrs = (
  policy: dataproc.AutoscalingPolicy,
  project: string,
  region: string,
) => {
  const name = policy.name ?? "";
  const parsed = parseResourceName(name, "autoscalingPolicies", region);
  return {
    name,
    policyId: policy.id ?? parsed.id,
    project: parsed.project || project,
    region: parsed.location || region,
    labels: userLabels(policy.labels),
    clusterType: policy.clusterType,
    workerMinInstances: policy.workerConfig?.minInstances,
    workerMaxInstances: policy.workerConfig?.maxInstances,
    cooldownPeriod: policy.basicAlgorithm?.cooldownPeriod,
  };
};

const desiredBody = (
  news: RegionsAutoscalingPolicyProps,
  policyId: string,
  name: string,
  desiredLabels: Record<string, string>,
): dataproc.AutoscalingPolicy => ({
  id: policyId,
  name,
  labels: desiredLabels,
  clusterType: news.clusterType,
  workerConfig: news.workerConfig ?? defaultWorkerConfig(),
  secondaryWorkerConfig: news.secondaryWorkerConfig,
  basicAlgorithm: {
    cooldownPeriod: news.cooldownPeriod,
    yarnConfig: news.yarnConfig ?? defaultYarnConfig(),
    sparkStandaloneConfig: news.sparkStandaloneConfig,
  },
});

const getByName = (name: string) =>
  dataproc
    .getProjectsRegionsAutoscalingPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listRegion = (project: string, region: string) =>
  emptyOnMissing(
    collectPages(
      dataproc.listProjectsRegionsAutoscalingPolicies.pages({
        parent: regionParent(project, region),
        pageSize: 1000,
      }),
      (page) => page.policies,
    ).pipe(
      Effect.map((items) =>
        items
          .filter((policy) => hasAlchemyLabelMap(policy.labels))
          .map((policy) => toAttrs(policy, project, region)),
      ),
    ),
  );

const policyChanged = (
  current: dataproc.AutoscalingPolicy,
  desired: dataproc.AutoscalingPolicy,
) =>
  !sameJson(current.workerConfig, desired.workerConfig) ||
  !sameJson(current.secondaryWorkerConfig, desired.secondaryWorkerConfig) ||
  (current.clusterType ?? "") !== (desired.clusterType ?? "") ||
  fingerprint(current.basicAlgorithm) !== fingerprint(desired.basicAlgorithm);

export const RegionsAutoscalingPolicyProvider = () =>
  Provider.succeed(RegionsAutoscalingPolicy, {
    stables: ["name", "policyId", "project", "region"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.policyId ?? output?.policyId;
      const nextId = news.policyId ?? previousId;
      const previousRegion = normalizeLocation(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeLocation(
        news.region ?? olds?.region ?? output?.region,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (output !== undefined && previousRegion !== nextRegion)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousRegion === nextRegion &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeLocation(
        olds?.region ?? output?.region,
        env.region,
      );
      const policyId = yield* toPhysicalId(
        id,
        olds?.policyId,
        output?.policyId,
        MAX_POLICY_ID_LENGTH,
        "policy",
      );
      const name = output?.name ?? resourceName(env.project, region, policyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          [...new Set([env.region, ...LIST_LOCATIONS])],
          (region) => listRegion(env.project, region),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeLocation(
        news.region ?? output?.region,
        env.region,
      );
      const policyId = yield* toPhysicalId(
        id,
        news.policyId,
        output?.policyId,
        MAX_POLICY_ID_LENGTH,
        "policy",
      );
      const name = resourceName(env.project, region, policyId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desired = desiredBody(news, policyId, name, desiredLabels);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataproc
          .createProjectsRegionsAutoscalingPolicies({
            parent: regionParent(env.project, region),
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new RegionsAutoscalingPolicyNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      if (labelsChanged || policyChanged(current, desired)) {
        current = yield* dataproc.updateProjectsRegionsAutoscalingPolicies({
          name: current.name ?? name,
          body: {
            ...desired,
            name: current.name ?? name,
          },
        });
      }

      return toAttrs(current, env.project, region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* dataproc
        .deleteProjectsRegionsAutoscalingPolicies({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
