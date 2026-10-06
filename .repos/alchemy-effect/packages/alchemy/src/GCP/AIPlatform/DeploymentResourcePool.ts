import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
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
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import {
  lastSegment,
  normalizeLocation,
  parentOf,
  parseResourceName,
  rfc1035,
  resourceNameFromOperation,
  waitForOperation,
} from "./internal.ts";
import type { EncryptionSpec } from "./shared.ts";

export type MachineSpec = {
  /** Machine type, for example `n1-standard-4`. Immutable. */
  machineType?: string;
  /** Accelerator type. Immutable. */
  acceleratorType?: string;
  /** Accelerators per replica. Immutable. */
  acceleratorCount?: number;
};

export type AutoscalingMetricSpec = {
  /** Resource metric name. */
  metricName?: string;
  /** Target utilization percent (1–100). Defaults to 60. */
  target?: number;
};

export type DedicatedResources = {
  /**
   * Minimum always-on replicas. Must be >= 1.
   * @default 1
   */
  minReplicaCount?: number;
  /**
   * Maximum replicas under load. Defaults to `minReplicaCount`.
   */
  maxReplicaCount?: number;
  /**
   * Replicas required for the deploy to succeed.
   */
  requiredReplicaCount?: number;
  /**
   * Schedule the workload on spot VMs.
   */
  spot?: boolean;
  /**
   * Metric specs that override the default 60% CPU/accelerator targets.
   */
  autoscalingMetricSpecs?: AutoscalingMetricSpec[];
  /**
   * Single-machine spec. Immutable — changing it replaces the pool.
   * @default { machineType: "n1-standard-2" }
   */
  machineSpec?: MachineSpec;
};

export type DeploymentResourcePoolProps = {
  /**
   * Pool id (the `{deployment_resource_pool}` segment). If omitted, a
   * unique name is generated. Must match
   * `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`. Immutable — changing it replaces
   * the pool.
   */
  deploymentResourcePoolId?: string;
  /**
   * Region. Immutable — changing it replaces the pool.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Dedicated machine resources shared by deployed models.
   */
  dedicatedResources?: DedicatedResources;
  /**
   * Disable container stdout/stderr logging. Vertex AI accepts but does not
   * apply updates to it, so changing it replaces the pool.
   */
  disableContainerLogging?: boolean;
  /**
   * Runtime service account email.
   */
  serviceAccount?: string;
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * pool.
   */
  encryptionSpec?: EncryptionSpec;
};

export type DeploymentResourcePool = Resource<
  "GCP.AIPlatform.DeploymentResourcePool",
  DeploymentResourcePoolProps,
  {
    /** Full resource name `.../deploymentResourcePools/{pool}`. */
    name: string;
    /** Pool id (last path segment). */
    deploymentResourcePoolId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Dedicated resources. */
    dedicatedResources: DedicatedResources | undefined;
    /** Whether container logging is disabled. */
    disableContainerLogging: boolean;
    /** Runtime service account. */
    serviceAccount: string | undefined;
    /** Customer-managed KMS key, if any. */
    kmsKeyName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI DeploymentResourcePool — dedicated machines shared by
 * multiple DeployedModels.
 *
 * Deployment resource pools have no labels field. Generated ids are
 * prefixed with `alch-` so `list` / nuke can find them. Location, pool
 * id, machine spec, and CMEK are immutable. Replica counts, logging, and
 * service account update in place.
 *
 * ### Creating a Pool
 * **Example:** Single n1-standard-2 replica
 * ```typescript
 * const pool = yield* GCP.AIPlatform.DeploymentResourcePool("Shared", {
 *   dedicatedResources: {
 *     minReplicaCount: 1,
 *     maxReplicaCount: 1,
 *     machineSpec: { machineType: "n1-standard-2" },
 *   },
 * });
 * ```
 *
 * ### Scaling a Pool
 * **Example:** Raise max replicas
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const pool = yield* GCP.AIPlatform.DeploymentResourcePool("Shared", {
 *   dedicatedResources: {
 *     minReplicaCount: 1,
 *     maxReplicaCount: 2,
 *     machineSpec: { machineType: "n1-standard-2" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const DeploymentResourcePool = Resource<DeploymentResourcePool>(
  "GCP.AIPlatform.DeploymentResourcePool",
);

export class DeploymentResourcePoolNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.DeploymentResourcePoolNotResolved",
)<{
  name: string;
}> {}

export class DeploymentResourcePoolStillExists extends Data.TaggedError(
  "GCP.AIPlatform.DeploymentResourcePoolStillExists",
)<{
  name: string;
}> {}

const DEFAULT_MACHINE_TYPE = "n1-standard-2";
const OWNED_ID_PREFIX = "alch-";

const resourceName = (project: string, location: string, poolId: string) =>
  `projects/${project}/locations/${location}/deploymentResourcePools/${poolId}`;

const ownedId = (value: string) => {
  const base = rfc1035(value);
  if (base.startsWith(OWNED_ID_PREFIX)) return base.slice(0, 63);
  return `${OWNED_ID_PREFIX}${base}`.slice(0, 63).replace(/-+$/g, "");
};

const isOwnedId = (poolId: string) => poolId.startsWith(OWNED_ID_PREFIX);

const toId = (id: string, poolId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (poolId !== undefined) return rfc1035(poolId);
    if (existing !== undefined) return existing;
    return ownedId(
      yield* createPhysicalName({
        id,
        maxLength: 58,
        lowercase: true,
      }),
    );
  });

const dedicatedOf = (
  resources:
    | DedicatedResources
    | aiplatform.GoogleCloudAiplatformV1DedicatedResources
    | undefined,
): DedicatedResources | undefined => {
  if (resources === undefined) return undefined;
  return {
    minReplicaCount: resources.minReplicaCount,
    maxReplicaCount: resources.maxReplicaCount,
    requiredReplicaCount: resources.requiredReplicaCount,
    spot: resources.spot,
    autoscalingMetricSpecs: resources.autoscalingMetricSpecs?.map((spec) => ({
      metricName: spec.metricName,
      target: spec.target,
    })),
    machineSpec: resources.machineSpec
      ? {
          machineType: resources.machineSpec.machineType,
          acceleratorType: resources.machineSpec.acceleratorType,
          acceleratorCount: resources.machineSpec.acceleratorCount,
        }
      : undefined,
  };
};

const desiredDedicated = (
  resources: DedicatedResources | undefined,
): aiplatform.GoogleCloudAiplatformV1DedicatedResources => ({
  minReplicaCount: resources?.minReplicaCount ?? 1,
  maxReplicaCount:
    resources?.maxReplicaCount ?? resources?.minReplicaCount ?? 1,
  requiredReplicaCount: resources?.requiredReplicaCount,
  spot: resources?.spot,
  autoscalingMetricSpecs: resources?.autoscalingMetricSpecs,
  machineSpec: {
    machineType: resources?.machineSpec?.machineType ?? DEFAULT_MACHINE_TYPE,
    acceleratorType: resources?.machineSpec?.acceleratorType,
    acceleratorCount: resources?.machineSpec?.acceleratorCount,
  },
});

const toAttrs = (
  pool: aiplatform.GoogleCloudAiplatformV1DeploymentResourcePool,
  project: string,
) => {
  const name = pool.name ?? "";
  const parsed = parseResourceName(name, "deploymentResourcePools");
  return {
    name,
    deploymentResourcePoolId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    dedicatedResources: dedicatedOf(pool.dedicatedResources),
    disableContainerLogging: pool.disableContainerLogging === true,
    serviceAccount: pool.serviceAccount,
    kmsKeyName: pool.encryptionSpec?.kmsKeyName,
    createTime: pool.createTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsDeploymentResourcePools({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPools = (project: string, region: string) => {
  const collect = (parent: string) =>
    aiplatform.listProjectsLocationsDeploymentResourcePools
      .pages({ parent, pageSize: 100 })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.deploymentResourcePools ?? []),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
  const fallback = Effect.forEach(listLocations(region), (location) =>
    collect(`projects/${project}/locations/${location}`),
  ).pipe(Effect.map((pages) => pages.flat()));
  // Vertex AI has no `locations/-` wildcard; scan known locations.
  return fallback.pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
};

const findOwned = (hinted: string | undefined) =>
  Effect.gen(function* () {
    if (hinted === undefined || hinted.length === 0) return undefined;
    return yield* getByName(hinted);
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((pool) =>
      pool
        ? Effect.succeed(pool)
        : Effect.fail(new DeploymentResourcePoolNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.DeploymentResourcePoolNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((pool) =>
      pool === undefined
        ? Effect.void
        : Effect.fail(new DeploymentResourcePoolStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.DeploymentResourcePoolStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const machineKey = (spec: MachineSpec | undefined) =>
  `${spec?.machineType ?? DEFAULT_MACHINE_TYPE}|${spec?.acceleratorType ?? ""}|${spec?.acceleratorCount ?? 0}`;

export const DeploymentResourcePoolProvider = () =>
  Provider.succeed(DeploymentResourcePool, {
    stables: [
      "name",
      "deploymentResourcePoolId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.deploymentResourcePoolId ?? output?.deploymentResourcePoolId;
      const nextId = news.deploymentResourcePoolId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousMachine = machineKey(
        olds?.dedicatedResources?.machineSpec ??
          output?.dedicatedResources?.machineSpec,
      );
      const nextMachine = machineKey(
        news.dedicatedResources?.machineSpec ??
          olds?.dedicatedResources?.machineSpec ??
          output?.dedicatedResources?.machineSpec,
      );
      const previousKey =
        olds?.encryptionSpec?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKey = news.encryptionSpec?.kmsKeyName ?? previousKey;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          rfc1035(nextId) !== previousId) ||
        previousLocation !== nextLocation ||
        previousMachine !== nextMachine ||
        previousKey !== nextKey ||
        (olds !== undefined &&
          (news.disableContainerLogging === true) !==
            (olds.disableContainerLogging === true));
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          rfc1035(nextId ?? previousId) === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const poolId = yield* toId(
        id,
        olds?.deploymentResourcePoolId,
        output?.deploymentResourcePoolId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name = output?.name ?? resourceName(env.project, location, poolId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return isOwnedId(attrs.deploymentResourcePoolId) ||
        output?.name === existing.name
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pools = yield* listPools(env.project, env.region);
        return pools
          .filter((pool) => isOwnedId(lastSegment(pool.name ?? "")))
          .map((pool) => toAttrs(pool, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const poolId = yield* toId(
        id,
        news.deploymentResourcePoolId,
        output?.deploymentResourcePoolId,
      );
      const name = resourceName(env.project, location, poolId);
      const dedicated = desiredDedicated(news.dedicatedResources);
      const serviceAccount = news.serviceAccount;
      const disableContainerLogging = news.disableContainerLogging === true;

      let current = yield* findOwned(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsDeploymentResourcePools({
            parent: parentOf(env.project, location),
            body: {
              deploymentResourcePoolId: poolId,
              deploymentResourcePool: {
                dedicatedResources: dedicated,
                disableContainerLogging,
                serviceAccount,
                encryptionSpec: news.encryptionSpec,
              },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = resourceNameFromOperation(done) ?? name;
          current = yield* waitUntilExists(createdName);
        }
        if (current === undefined) {
          current = yield* findOwned(name);
        }
      }

      if (current === undefined) {
        return yield* new DeploymentResourcePoolNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observed = dedicatedOf(current.dedicatedResources);
      const minChanged =
        (observed?.minReplicaCount ?? 1) !== (dedicated.minReplicaCount ?? 1);
      const maxChanged =
        (observed?.maxReplicaCount ?? observed?.minReplicaCount ?? 1) !==
        (dedicated.maxReplicaCount ?? dedicated.minReplicaCount ?? 1);
      const saChanged =
        serviceAccount !== undefined &&
        (current.serviceAccount ?? "") !== serviceAccount;

      if (minChanged || maxChanged || saChanged) {
        const patched =
          yield* aiplatform.patchProjectsLocationsDeploymentResourcePools({
            name: currentName,
            updateMask: [
              minChanged ? "dedicated_resources.min_replica_count" : undefined,
              maxChanged ? "dedicated_resources.max_replica_count" : undefined,
              saChanged ? "service_account" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: currentName,
              dedicatedResources: dedicated,
              serviceAccount,
            },
          });
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(currentName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteProjectsLocationsDeploymentResourcePools({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
