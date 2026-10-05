import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  DEFAULT_GLOBAL,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "serviceLbPolicies";

export type ServiceLbPolicyLoadBalancingAlgorithm =
  | networkservices.ServiceLbPolicyLoadBalancingAlgorithmEnum
  | (string & {});

export type ServiceLbPolicyIsolationGranularity =
  | networkservices.ServiceLbPolicyIsolationConfigIsolationGranularityEnum
  | (string & {});

export type ServiceLbPolicyIsolationMode =
  | networkservices.ServiceLbPolicyIsolationConfigIsolationModeEnum
  | (string & {});

export type ServiceLbPolicyAutoCapacityDrain = {
  /**
   * When true, an unhealthy IG/NEG is drained. An IG/NEG is unhealthy
   * if fewer than 25% of its endpoints are healthy. Never drains more
   * than 50% of configured backends.
   */
  enable?: boolean;
};

export type ServiceLbPolicyFailoverConfig = {
  /**
   * Percentage of healthy endpoints below which traffic is sent to
   * failover backends. Range 1-99. Defaults to 50 for classic global
   * external HTTP(S) and proxyless mesh, 70 otherwise.
   */
  failoverHealthThreshold?: number;
};

export type ServiceLbPolicyIsolationConfig = {
  /** Isolation granularity (`REGION`). */
  isolationGranularity?: ServiceLbPolicyIsolationGranularity;
  /** Isolation mode (`NEAREST` or `STRICT`). */
  isolationMode?: ServiceLbPolicyIsolationMode;
};

export type ServiceLbPolicyProps = {
  /**
   * Policy id (the `{serviceLbPolicy}` segment of
   * `projects/{project}/locations/{location}/serviceLbPolicies/{serviceLbPolicy}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the policy.
   */
  serviceLbPolicyId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description. Max 1024 characters.
   */
  description?: string;
  /**
   * Load balancing algorithm. Defaults to `WATERFALL_BY_REGION`.
   */
  loadBalancingAlgorithm?: ServiceLbPolicyLoadBalancingAlgorithm;
  /**
   * Automatically drain traffic from unhealthy instance groups or NEGs.
   */
  autoCapacityDrain?: ServiceLbPolicyAutoCapacityDrain;
  /**
   * Health-based failover threshold.
   */
  failoverConfig?: ServiceLbPolicyFailoverConfig;
  /**
   * Backend isolation for the associated backend service.
   */
  isolationConfig?: ServiceLbPolicyIsolationConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ServiceLbPolicy = Resource<
  "GCP.NetworkServices.ServiceLbPolicy",
  ServiceLbPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/serviceLbPolicies/{serviceLbPolicy}`. */
    name: string;
    /** Policy id (last path segment). */
    serviceLbPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Configured load balancing algorithm. */
    loadBalancingAlgorithm: string | undefined;
    /** Auto capacity drain settings. */
    autoCapacityDrain: ServiceLbPolicyAutoCapacityDrain | undefined;
    /** Failover configuration. */
    failoverConfig: ServiceLbPolicyFailoverConfig | undefined;
    /** Isolation configuration. */
    isolationConfig: ServiceLbPolicyIsolationConfig | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A ServiceLbPolicy holds global load-balancing and traffic-distribution
 * settings that can be attached to a BackendService.
 *
 * Changing `serviceLbPolicyId` or `location` replaces the policy.
 * Description, labels, algorithm, drain, failover, and isolation update
 * in place.
 *
 * ### Creating a ServiceLbPolicy
 * **Example:** Generated name
 * ```typescript
 * const policy = yield* GCP.NetworkServices.ServiceLbPolicy("Spread", {});
 * ```
 *
 * **Example:** Spray-to-region with failover
 * ```typescript
 * const policy = yield* GCP.NetworkServices.ServiceLbPolicy("Spread", {
 *   serviceLbPolicyId: "app-lb-policy",
 *   loadBalancingAlgorithm: "SPRAY_TO_REGION",
 *   autoCapacityDrain: { enable: true },
 *   failoverConfig: { failoverHealthThreshold: 70 },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const ServiceLbPolicy = Resource<ServiceLbPolicy>(
  "GCP.NetworkServices.ServiceLbPolicy",
);

const toDrain = (
  drain:
    | ServiceLbPolicyAutoCapacityDrain
    | networkservices.ServiceLbPolicyAutoCapacityDrain
    | undefined,
): ServiceLbPolicyAutoCapacityDrain | undefined => {
  if (drain === undefined) return undefined;
  return { enable: drain.enable };
};

const toFailover = (
  failover:
    | ServiceLbPolicyFailoverConfig
    | networkservices.ServiceLbPolicyFailoverConfig
    | undefined,
): ServiceLbPolicyFailoverConfig | undefined => {
  if (failover === undefined) return undefined;
  return { failoverHealthThreshold: failover.failoverHealthThreshold };
};

const toIsolation = (
  isolation:
    | ServiceLbPolicyIsolationConfig
    | networkservices.ServiceLbPolicyIsolationConfig
    | undefined,
): ServiceLbPolicyIsolationConfig | undefined => {
  if (isolation === undefined) return undefined;
  return {
    isolationGranularity: isolation.isolationGranularity,
    isolationMode: isolation.isolationMode,
  };
};

const toAttrs = (policy: networkservices.ServiceLbPolicy, project: string) => {
  const name = policy.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    serviceLbPolicyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    description: policy.description,
    loadBalancingAlgorithm: policy.loadBalancingAlgorithm,
    autoCapacityDrain: toDrain(policy.autoCapacityDrain),
    failoverConfig: toFailover(policy.failoverConfig),
    isolationConfig: toIsolation(policy.isolationConfig),
    labels: userLabels(policy.labels),
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsServiceLbPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ServiceLbPolicyProvider = () =>
  Provider.succeed(ServiceLbPolicy, {
    stables: ["name", "serviceLbPolicyId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.serviceLbPolicyId ?? output?.serviceLbPolicyId;
      const nextId = news.serviceLbPolicyId
        ? rfc1035(news.serviceLbPolicyId, "service-lb-policy")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceLbPolicyId = yield* toPhysicalId(
        id,
        olds?.serviceLbPolicyId,
        output?.serviceLbPolicyId,
        "service-lb-policy",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, serviceLbPolicyId);
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
        const items = yield* collectPages(
          networkservices.listProjectsLocationsServiceLbPolicies.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.serviceLbPolicies,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceLbPolicyId = yield* toPhysicalId(
        id,
        news.serviceLbPolicyId,
        output?.serviceLbPolicyId,
        "service-lb-policy",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        serviceLbPolicyId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredDrain = toDrain(news.autoCapacityDrain);
      const desiredFailover = toFailover(news.failoverConfig);
      const desiredIsolation = toIsolation(news.isolationConfig);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsServiceLbPolicies({
            parent: parentOf(env.project, location),
            serviceLbPolicyId,
            body: {
              description: news.description,
              labels: desiredLabels,
              loadBalancingAlgorithm: news.loadBalancingAlgorithm,
              autoCapacityDrain: desiredDrain,
              failoverConfig: desiredFailover,
              isolationConfig: desiredIsolation,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const updateMask = changedFields([
        ["labels", labelsChanged],
        [
          "description",
          (current.description ?? "") !== (news.description ?? ""),
        ],
        [
          "loadBalancingAlgorithm",
          (current.loadBalancingAlgorithm ?? "") !==
            (news.loadBalancingAlgorithm ?? ""),
        ],
        [
          "autoCapacityDrain",
          !sameJson(toDrain(current.autoCapacityDrain), desiredDrain),
        ],
        [
          "failoverConfig",
          !sameJson(toFailover(current.failoverConfig), desiredFailover),
        ],
        [
          "isolationConfig",
          !sameJson(toIsolation(current.isolationConfig), desiredIsolation),
        ],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsServiceLbPolicies({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              loadBalancingAlgorithm: news.loadBalancingAlgorithm,
              autoCapacityDrain: desiredDrain,
              failoverConfig: desiredFailover,
              isolationConfig: desiredIsolation,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsServiceLbPolicies({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
