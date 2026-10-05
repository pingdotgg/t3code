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
import {
  collectPages,
  LIST_LOCATIONS,
  MAX_POLICY_ID_LENGTH,
  defaultWorkerConfig,
  defaultYarnConfig,
  emptyOnMissing,
  fingerprint,
  hasAlchemyLabelMap,
  locationParent,
  normalizeLocation,
  parseResourceName,
  sameJson,
  toPhysicalId,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type AutoscalingPolicyProps = {
  /**
   * Policy id (the `{policy}` segment of
   * `projects/{project}/locations/{location}/autoscalingPolicies/{policy}`).
   * If omitted, a unique RFC1035 name is generated. 3-50 characters;
   * letters, numbers, hyphens, underscores. Immutable — changing it
   * replaces the policy.
   */
  policyId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * policy. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Cluster topology this policy applies to (`STANDARD`, `ZERO_SCALE`).
   */
  clusterType?: dataproc.AutoscalingPolicyClusterTypeEnum | (string & {});
  /**
   * Primary worker bounds. Defaults to min 2, max 3, weight 1.
   */
  workerConfig?: dataproc.InstanceGroupAutoscalingPolicyConfig;
  /**
   * Secondary worker bounds. Optional; omitted means no secondary workers.
   */
  secondaryWorkerConfig?: dataproc.InstanceGroupAutoscalingPolicyConfig;
  /**
   * Duration between scaling events (JSON Duration). Bounds: 2m-1d.
   * @default "2m"
   */
  cooldownPeriod?: string;
  /**
   * YARN autoscaling configuration. Defaults to scale-up 0.5, no
   * scale-down, 3600s graceful decommission.
   */
  yarnConfig?: dataproc.BasicYarnAutoscalingConfig;
  /**
   * Spark Standalone autoscaling configuration (Spark Standalone clusters).
   */
  sparkStandaloneConfig?: dataproc.SparkStandaloneAutoscalingConfig;
};

export type AutoscalingPolicy = Resource<
  "GCP.Dataproc.AutoscalingPolicy",
  AutoscalingPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/autoscalingPolicies/{policy}`. */
    name: string;
    /** Policy id (last path segment). */
    policyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
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
 * A Dataproc autoscaling policy (locations API).
 *
 * Changing `policyId` or `location` replaces the policy. Worker bounds,
 * algorithm, and labels update in place via a full-resource replace.
 *
 * ### Creating a Policy
 * **Example:** Generated name
 * ```typescript
 * const policy = yield* GCP.Dataproc.AutoscalingPolicy("SparkScale", {});
 * ```
 *
 * **Example:** Explicit bounds
 * ```typescript
 * const policy = yield* GCP.Dataproc.AutoscalingPolicy("SparkScale", {
 *   policyId: "spark-scale",
 *   location: "us-central1",
 *   workerConfig: { minInstances: 2, maxInstances: 6 },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Dataproc
 */
export const AutoscalingPolicy = Resource<AutoscalingPolicy>(
  "GCP.Dataproc.AutoscalingPolicy",
);

export class AutoscalingPolicyNotResolved extends Data.TaggedError(
  "GCP.Dataproc.AutoscalingPolicyNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, policyId: string) =>
  `${locationParent(project, location)}/autoscalingPolicies/${policyId}`;

const toAttrs = (
  policy: dataproc.AutoscalingPolicy,
  project: string,
  location: string,
) => {
  const name = policy.name ?? "";
  const parsed = parseResourceName(name, "autoscalingPolicies", location);
  return {
    name,
    policyId: policy.id ?? parsed.id,
    project: parsed.project || project,
    location: parsed.location || location,
    labels: userLabels(policy.labels),
    clusterType: policy.clusterType,
    workerMinInstances: policy.workerConfig?.minInstances,
    workerMaxInstances: policy.workerConfig?.maxInstances,
    cooldownPeriod: policy.basicAlgorithm?.cooldownPeriod,
  };
};

const desiredBody = (
  news: AutoscalingPolicyProps,
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
    .getProjectsLocationsAutoscalingPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listLocation = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataproc.listProjectsLocationsAutoscalingPolicies.pages({
        parent: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) => page.policies,
    ).pipe(
      Effect.map((items) =>
        items
          .filter((policy) => hasAlchemyLabelMap(policy.labels))
          .map((policy) => toAttrs(policy, project, location)),
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

export const AutoscalingPolicyProvider = () =>
  Provider.succeed(AutoscalingPolicy, {
    stables: ["name", "policyId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.policyId ?? output?.policyId;
      const nextId = news.policyId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (output !== undefined && previousLocation !== nextLocation)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const policyId = yield* toPhysicalId(
        id,
        olds?.policyId,
        output?.policyId,
        MAX_POLICY_ID_LENGTH,
        "policy",
      );
      const name =
        output?.name ?? resourceName(env.project, location, policyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          [...new Set([env.region, ...LIST_LOCATIONS])],
          (location) => listLocation(env.project, location),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const policyId = yield* toPhysicalId(
        id,
        news.policyId,
        output?.policyId,
        MAX_POLICY_ID_LENGTH,
        "policy",
      );
      const name = resourceName(env.project, location, policyId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desired = desiredBody(news, policyId, name, desiredLabels);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataproc
          .createProjectsLocationsAutoscalingPolicies({
            parent: locationParent(env.project, location),
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AutoscalingPolicyNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      if (labelsChanged || policyChanged(current, desired)) {
        current = yield* dataproc.updateProjectsLocationsAutoscalingPolicies({
          name: current.name ?? name,
          body: {
            ...desired,
            name: current.name ?? name,
          },
        });
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* dataproc
        .deleteProjectsLocationsAutoscalingPolicies({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
