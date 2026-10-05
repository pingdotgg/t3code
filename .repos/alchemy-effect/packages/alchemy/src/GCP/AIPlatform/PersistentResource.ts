import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  AiPlatformNotResolved,
  AiPlatformStillExists,
  collectPages,
  jsonEqual,
  locationParent,
  normalizeLocation,
  parseResourceName,
  toPhysicalId,
  userLabels,
  type DiskSpec,
  type EncryptionSpec,
  type MachineSpec,
} from "./shared.ts";

const COLLECTION = "persistentResources";
const DEFAULT_MACHINE_TYPE = "n1-standard-4";
const DEFAULT_REPLICA_COUNT = "1";

export type ResourcePoolAutoscalingSpec = {
  /** Minimum replicas (must be > 0 for Persistent Resource). */
  minReplicaCount?: string;
  /** Maximum replicas. */
  maxReplicaCount?: string;
};

export type ResourcePool = {
  /**
   * Unique id within the PersistentResource. Generated if omitted.
   */
  id?: string;
  /** Machine spec. Immutable. */
  machineSpec?: MachineSpec;
  /** Replica count (string). @default "1" */
  replicaCount?: string;
  /** Disk spec. */
  diskSpec?: DiskSpec;
  /** Autoscaling spec. */
  autoscalingSpec?: ResourcePoolAutoscalingSpec;
};

export type RaySpec = {
  /** Default Ray image URI. */
  imageUri?: string;
  /** Per-pool Ray images keyed by resource pool id. */
  resourcePoolImages?: Record<string, string>;
  /** Resource pool that serves as the Ray head node. */
  headNodeResourcePoolId?: string;
  /** Disable Ray OSS log export. */
  rayLogsDisabled?: boolean;
  /** Disable Ray metrics. */
  rayMetricsDisabled?: boolean;
};

export type ServiceAccountSpec = {
  /** Enforce a custom service account for workloads. */
  enableCustomServiceAccount?: boolean;
  /** Service account email. */
  serviceAccount?: string;
};

export type PersistentResourceProps = {
  /**
   * Persistent resource id. If omitted, a unique RFC1035 name is
   * generated. Must match `/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/`.
   * Immutable — changing it replaces the resource.
   */
  persistentResourceId?: string;
  /**
   * Vertex AI location. Immutable — changing it replaces the resource.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 128 UTF-8 characters). Defaults to the resource id.
   * Changing it replaces the resource.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Changing them replaces the resource.
   */
  labels?: Record<string, string>;
  /**
   * Resource pools. At least one pool is required. Pool machine specs
   * are immutable — changing them replaces the resource. Replica counts
   * update in place only for Ray clusters (`raySpec`); GCP rejects updates
   * to other persistent resources, so a replica change replaces them.
   */
  resourcePools?: ResourcePool[];
  /**
   * VPC network to peer (`projects/{project}/global/networks/{network}`).
   * Immutable.
   */
  network?: string;
  /**
   * Reserved IP ranges under the VPC.
   */
  reservedIpRanges?: string[];
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: EncryptionSpec;
  /**
   * Ray cluster configuration.
   */
  raySpec?: RaySpec;
  /**
   * Workload identity / custom service account.
   */
  serviceAccountSpec?: ServiceAccountSpec;
};

export type PersistentResource = Resource<
  "GCP.AIPlatform.PersistentResource",
  PersistentResourceProps,
  {
    /** Full resource name. */
    name: string;
    /** Persistent resource id (last path segment). */
    persistentResourceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`PROVISIONING`, `RUNNING`, …). */
    state: string | undefined;
    /** VPC network. */
    network: string | undefined;
    /** Resource pool ids. */
    resourcePoolIds: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Time the resource first entered `RUNNING`. */
    startTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Persistent Resource — dedicated node pools for custom
 * training and Ray-on-Vertex workloads.
 *
 * Changing `persistentResourceId`, `location`, `network`,
 * `encryptionSpec`, or pool machine specs replaces the resource. Replica
 * counts, labels, and display name update in place.
 *
 * Provisioning typically takes several minutes.
 *
 * ### Creating a Persistent Resource
 * **Example:** Single n1-standard-4 pool
 * ```typescript
 * const pool = yield* GCP.AIPlatform.PersistentResource("Train", {
 *   resourcePools: [
 *     {
 *       id: "worker",
 *       replicaCount: "1",
 *       machineSpec: { machineType: "n1-standard-4" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const PersistentResource = Resource<PersistentResource>(
  "GCP.AIPlatform.PersistentResource",
);

export class PersistentResourceNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.PersistentResourceNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, id: string) =>
  `${locationParent(project, location)}/${COLLECTION}/${id}`;

const toPools = (
  pools: ResourcePool[] | undefined,
): aiplatform.GoogleCloudAiplatformV1ResourcePool[] =>
  (pools ?? [{}]).map((pool, index) => ({
    id: pool.id ?? `pool-${index}`,
    replicaCount: pool.replicaCount ?? DEFAULT_REPLICA_COUNT,
    machineSpec: {
      machineType: pool.machineSpec?.machineType ?? DEFAULT_MACHINE_TYPE,
      acceleratorType: pool.machineSpec?.acceleratorType,
      acceleratorCount: pool.machineSpec?.acceleratorCount,
      gpuPartitionSize: pool.machineSpec?.gpuPartitionSize,
      tpuTopology: pool.machineSpec?.tpuTopology,
    },
    diskSpec: pool.diskSpec,
    autoscalingSpec: pool.autoscalingSpec,
  }));

const machineKey = (pools: ResourcePool[] | undefined) =>
  JSON.stringify(
    toPools(pools).map((pool) => ({
      id: pool.id,
      machineSpec: pool.machineSpec,
    })),
  );

const toAttrs = (
  resource: aiplatform.GoogleCloudAiplatformV1PersistentResource,
  project: string,
) => {
  const name = resource.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    persistentResourceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: resource.displayName,
    labels: userLabels(resource.labels),
    state: resource.state,
    network: resource.network,
    resourcePoolIds: (resource.resourcePools ?? []).map(
      (pool) => pool.id ?? "",
    ),
    createTime: resource.createTime,
    updateTime: resource.updateTime,
    startTime: resource.startTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsPersistentResources({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (
        resource,
      ): resource is aiplatform.GoogleCloudAiplatformV1PersistentResource =>
        resource !== undefined,
      () => new AiPlatformNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.NotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (resource) => resource === undefined,
      () => new AiPlatformStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.StillExists",
      // Tearing down the cluster takes several minutes.
      times: 75,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const PersistentResourceProvider = () =>
  Provider.succeed(PersistentResource, {
    stables: [
      "name",
      "persistentResourceId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.persistentResourceId ?? output?.persistentResourceId;
      const nextId = news.persistentResourceId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const networkChanged =
        (news.network ?? olds?.network ?? "") !== (olds?.network ?? "");
      const machineChanged =
        olds !== undefined &&
        machineKey(news.resourcePools) !== machineKey(olds.resourcePools);
      // PATCH only accepts `resource_pools.replica_count`; `display_name` and
      // `labels` are rejected ("Unrecognized path"), so changing them
      // replaces the resource.
      const displayNameChanged =
        olds !== undefined &&
        (news.displayName ?? "") !== (olds.displayName ?? "");
      const labelsChanged =
        olds !== undefined &&
        JSON.stringify(Object.entries(news.labels ?? {}).sort()) !==
          JSON.stringify(Object.entries(olds.labels ?? {}).sort());
      // GCP only updates Ray-cluster persistent resources ("Currently we only
      // support the update function on Ray cluster"); any other resource is
      // replaced when its replica counts change.
      const replicasChanged =
        olds !== undefined &&
        news.raySpec === undefined &&
        JSON.stringify(
          (news.resourcePools ?? []).map((p) => p.replicaCount),
        ) !==
          JSON.stringify((olds.resourcePools ?? []).map((p) => p.replicaCount));
      const replace =
        replicasChanged ||
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (olds !== undefined && networkChanged) ||
        machineChanged ||
        displayNameChanged ||
        labelsChanged;
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
      const resourceId = yield* toPhysicalId(
        id,
        olds?.persistentResourceId,
        output?.persistentResourceId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, resourceId);
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
        const pages = (yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            collectPages(
              aiplatform.listProjectsLocationsPersistentResources.pages({
                parent: locationParent(env.project, location),
                pageSize: 100,
              }),
            ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([]))),
        )).flat();
        return pages.flatMap((page) =>
          (page.persistentResources ?? [])
            .filter((resource) =>
              Object.keys(resource.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            )
            .map((resource) => toAttrs(resource, env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const resourceId = yield* toPhysicalId(
        id,
        news.persistentResourceId,
        output?.persistentResourceId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, resourceId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? resourceId;
      const resourcePools = toPools(news.resourcePools);
      const resourceRuntimeSpec =
        news.raySpec || news.serviceAccountSpec
          ? {
              raySpec: news.raySpec
                ? {
                    imageUri: news.raySpec.imageUri,
                    resourcePoolImages: news.raySpec.resourcePoolImages,
                    headNodeResourcePoolId: news.raySpec.headNodeResourcePoolId,
                    rayLogsSpec: news.raySpec.rayLogsDisabled
                      ? { disabled: true }
                      : undefined,
                    rayMetricSpec: news.raySpec.rayMetricsDisabled
                      ? { disabled: true }
                      : undefined,
                  }
                : undefined,
              serviceAccountSpec: news.serviceAccountSpec,
            }
          : undefined;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsPersistentResources({
            parent: locationParent(env.project, location),
            persistentResourceId: resourceId,
            body: {
              displayName,
              labels: desiredLabels,
              resourcePools,
              network: news.network,
              reservedIpRanges: news.reservedIpRanges,
              encryptionSpec: news.encryptionSpec,
              resourceRuntimeSpec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        const createdName =
          resourceNameFromOperation(created ?? {}) ?? output?.name ?? name;
        current = yield* waitUntilExists(createdName);
      }

      if (current === undefined) {
        return yield* new PersistentResourceNotResolved({ name });
      }

      const observedName = current.name ?? name;
      // Reads fill in server defaults (disk spec, used replicas), and a pool's
      // machine spec is immutable (a change replaces), so only replica counts
      // are compared and patched.
      const replicaCounts = (
        pools:
          | ReadonlyArray<{ id?: string; replicaCount?: string }>
          | undefined,
      ) =>
        Object.fromEntries(
          (pools ?? []).map((pool, index) => [
            pool.id ?? String(index),
            String(pool.replicaCount ?? ""),
          ]),
        );
      const poolsChanged = !jsonEqual(
        replicaCounts(current.resourcePools),
        replicaCounts(resourcePools),
      );

      // Display name and labels are create-only; `diff` replaces the resource
      // when they change.
      // Only Ray clusters accept updates; `diff` replaces other resources.
      if (poolsChanged && news.raySpec !== undefined) {
        const patched =
          yield* aiplatform.patchProjectsLocationsPersistentResources({
            name: observedName,
            updateMask: "resource_pools.replica_count",
            body: { name: observedName, resourcePools },
          });
        yield* waitForOperation(patched);
        current = yield* getByName(observedName);
      }

      if (current === undefined) {
        return yield* new PersistentResourceNotResolved({ name: observedName });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      // A PROVISIONING resource rejects deletes ("is being created thus can
      // not be deleted now"), so wait for provisioning to settle first.
      yield* getByName(output.name).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (resource) => resource?.state !== "PROVISIONING",
          times: 60,
        }),
      );
      const operation = yield* aiplatform
        .deleteProjectsLocationsPersistentResources({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
