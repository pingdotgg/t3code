import * as container from "@distilled.cloud/gcp/container_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

// A zone, not a region: `GCP.Region` has no zone and a regional default would triple node count.
const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_MACHINE_TYPE = "e2-medium";
const DEFAULT_DISK_TYPE = "pd-standard";
const DEFAULT_DISK_SIZE_GB = 20;
const DEFAULT_NODE_COUNT = 1;
const MAX_NAME_LENGTH = 40;

export type ClustersNodePoolAutoscaling = {
  /** Enable the cluster autoscaler for this pool. */
  enabled?: boolean;
  /** Minimum nodes per zone. Mutually exclusive with `totalMinNodeCount`. */
  minNodeCount?: number;
  /** Maximum nodes per zone. Mutually exclusive with `totalMaxNodeCount`. */
  maxNodeCount?: number;
  /** Minimum nodes across all zones. */
  totalMinNodeCount?: number;
  /** Maximum nodes across all zones. */
  totalMaxNodeCount?: number;
  /** Scale-up location policy (`BALANCED`, `ANY`). */
  locationPolicy?:
    | container.NodePoolAutoscalingLocationPolicyEnum
    | (string & {});
  /** Allow NAP to delete this pool. */
  autoprovisioned?: boolean;
};

export type ClustersNodePoolManagement = {
  /** Automatically repair unhealthy nodes. */
  autoRepair?: boolean;
  /** Automatically upgrade nodes. */
  autoUpgrade?: boolean;
};

export type ClustersNodePoolUpgradeSettings = {
  /** Extra nodes created during an upgrade. */
  maxSurge?: number;
  /** Nodes allowed to be unavailable during an upgrade. */
  maxUnavailable?: number;
  /** Upgrade strategy (`SURGE`, `BLUE_GREEN`). */
  strategy?: container.UpgradeSettingsStrategyEnum | (string & {});
};

export type ClustersNodePoolTaint = {
  /** Taint key. */
  key?: string;
  /** Taint value. */
  value?: string;
  /** Taint effect (`NO_SCHEDULE`, `PREFER_NO_SCHEDULE`, `NO_EXECUTE`). */
  effect?: container.NodeTaintEffectEnum | (string & {});
};

export type ClustersNodePoolProps = {
  /**
   * Parent cluster id or full resource name
   * (`projects/{project}/zones/{zone}/clusters/{cluster}` or the
   * locations-form equivalent). Immutable — changing it replaces the
   * node pool.
   */
  cluster: string;
  /**
   * Compute Engine zone of the parent cluster (`us-central1-a`, …).
   * Ignored when `cluster` is a full resource name. Immutable —
   * changing it replaces the node pool. The legacy zonal API only
   * accepts zones, not regions.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Node pool id (the `{nodePool}` segment of
   * `.../clusters/{cluster}/nodePools/{nodePool}`). If omitted, a unique
   * RFC1035 name is generated. Must be 1-40 characters and match
   * `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces the
   * pool.
   */
  nodePoolId?: string;
  /**
   * Desired node count (per zone for zonal/multi-zonal pools). Create
   * uses `initialNodeCount`; later changes call `setSize`. Ignored while
   * autoscaling is enabled.
   * @default 1
   */
  nodeCount?: number;
  /**
   * User labels stored as GKE `config.resourceLabels` on the pool's GCE
   * VMs. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Machine type (`e2-medium`, `e2-small`, …).
   * @default "e2-medium"
   */
  machineType?: string;
  /**
   * Boot disk size in GB. Smallest allowed is 10.
   * @default 20
   */
  diskSizeGb?: number;
  /**
   * Boot disk type (`pd-standard`, `pd-balanced`, `pd-ssd`).
   * @default "pd-standard"
   */
  diskType?: string;
  /**
   * Node image type (`COS_CONTAINERD`, `UBUNTU_CONTAINERD`, …).
   */
  imageType?: string;
  /**
   * Kubernetes version for nodes (or alias such as `"-"` for the
   * control-plane version).
   */
  version?: string;
  /**
   * Use Spot VMs. Immutable — changing it replaces the pool.
   * @default false
   */
  spot?: boolean;
  /**
   * Use preemptible VMs. Immutable — changing it replaces the pool.
   * @default false
   */
  preemptible?: boolean;
  /**
   * Zones in which this pool's nodes should run.
   */
  nodeLocations?: string[];
  /**
   * Kubernetes labels applied to each node.
   */
  nodeLabels?: Record<string, string>;
  /**
   * Network tags applied to each node.
   */
  tags?: string[];
  /**
   * Kubernetes taints applied to each node.
   */
  taints?: ClustersNodePoolTaint[];
  /**
   * OAuth scopes for the node service account. Immutable — changing them
   * replaces the pool.
   */
  oauthScopes?: string[];
  /**
   * Service account email for node VMs. Immutable — changing it replaces
   * the pool.
   */
  serviceAccount?: string;
  /**
   * Local SSD count. Immutable — changing it replaces the pool.
   */
  localSsdCount?: number;
  /**
   * Customer-managed KMS key for boot disks. Immutable — changing it
   * replaces the pool.
   */
  bootDiskKmsKey?: string;
  /**
   * Max pods per node. Immutable — changing it replaces the pool.
   */
  maxPodsPerNode?: number;
  /**
   * Cluster autoscaler settings for this pool.
   */
  autoscaling?: ClustersNodePoolAutoscaling;
  /**
   * Auto-repair / auto-upgrade settings.
   */
  management?: ClustersNodePoolManagement;
  /**
   * Upgrade surge settings.
   */
  upgradeSettings?: ClustersNodePoolUpgradeSettings;
};

export type ClustersNodePool = Resource<
  "GCP.Container.ClustersNodePool",
  ClustersNodePoolProps,
  {
    /** Full resource name `projects/{project}/zones/{zone}/clusters/{cluster}/nodePools/{nodePool}`. */
    name: string;
    /** Node pool id (last path segment). */
    nodePoolId: string;
    /** Parent cluster id. */
    clusterId: string;
    /** Parent cluster resource name (zonal form). */
    clusterName: string;
    /** Project id. */
    project: string;
    /** Compute Engine zone. */
    zone: string;
    /** Server-reported status (`RUNNING`, `PROVISIONING`, …). */
    status: string | undefined;
    /** Kubernetes version currently on the nodes. */
    version: string | undefined;
    /** Desired / initial node count. */
    nodeCount: number;
    /** Machine type. */
    machineType: string | undefined;
    /** Boot disk size in GB. */
    diskSizeGb: number | undefined;
    /** Boot disk type. */
    diskType: string | undefined;
    /** Node image type. */
    imageType: string | undefined;
    /** Whether nodes are Spot VMs. */
    spot: boolean;
    /** Whether nodes are preemptible VMs. */
    preemptible: boolean;
    /** User GCP labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Kubernetes node labels. */
    nodeLabels: Record<string, string>;
    /** Network tags. */
    tags: string[];
    /** Node locations. */
    nodeLocations: string[];
    /** Autoscaler settings currently applied. */
    autoscaling: ClustersNodePoolAutoscaling | undefined;
    /** Management settings currently applied. */
    management: ClustersNodePoolManagement | undefined;
    /** Managed instance group URLs. */
    instanceGroupUrls: string[];
    /** Server-defined URL. */
    selfLink: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Kubernetes Engine node pool managed through the legacy zonal
 * Container API (`projects.zones.clusters.nodePools`).
 *
 * Prefer `GCP.Container.NodePool` (the `projects.locations` API) unless
 * you specifically need the zonal endpoints. Changing `cluster`, `zone`,
 * `nodePoolId`, `spot`, `preemptible`, `serviceAccount`, `oauthScopes`,
 * `localSsdCount`, `bootDiskKmsKey`, or `maxPodsPerNode` replaces the
 * pool. Size, labels, machine type, disk, image, version, management,
 * autoscaling, and upgrade settings update in place.
 *
 * Provisioning typically takes several minutes.
 *
 * ### Creating a Zonal Node Pool
 * **Example:** Generated name on an existing cluster
 * ```typescript
 * const cluster = yield* GCP.Container.Cluster("App", {
 *   location: "us-central1-a",
 * });
 * const pool = yield* GCP.Container.ClustersNodePool("Workers", {
 *   cluster: cluster.clusterId,
 *   zone: cluster.location,
 * });
 * ```
 *
 * **Example:** Explicit id, Spot nodes, and labels
 * ```typescript
 * const pool = yield* GCP.Container.ClustersNodePool("Workers", {
 *   cluster: cluster.name,
 *   nodePoolId: "app-workers",
 *   nodeCount: 1,
 *   machineType: "e2-small",
 *   diskSizeGb: 20,
 *   spot: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Autoscaling
 * **Example:** Per-zone autoscaling
 * ```typescript
 * const pool = yield* GCP.Container.ClustersNodePool("Workers", {
 *   cluster: cluster.clusterId,
 *   zone: "us-central1-a",
 *   autoscaling: { enabled: true, minNodeCount: 1, maxNodeCount: 3 },
 * });
 * ```
 *
 * ### Reading a Node Pool
 * **Example:** Get the bound node pool
 * ```typescript
 * const getPool = yield* GCP.Container.GetClustersNodePool(pool);
 * const live = yield* getPool();
 * ```
 *
 * @resource
 * @category Container
 */
export const ClustersNodePool = Resource<ClustersNodePool>(
  "GCP.Container.ClustersNodePool",
);

export class ClustersNodePoolNotResolved extends Data.TaggedError(
  "GCP.Container.ClustersNodePoolNotResolved",
)<{
  name: string;
}> {}

export class ClustersNodePoolClusterMissing extends Data.TaggedError(
  "GCP.Container.ClustersNodePoolClusterMissing",
)<{
  message: string;
}> {}

export class ClustersNodePoolNotReady extends Data.TaggedError(
  "GCP.Container.ClustersNodePoolNotReady",
)<{
  name: string;
  status: string;
}> {}

export class ClustersNodePoolOperationFailed extends Data.TaggedError(
  "GCP.Container.ClustersNodePoolOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class ClustersNodePoolStillExists extends Data.TaggedError(
  "GCP.Container.ClustersNodePoolStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeZone = (zone: string | undefined) =>
  lastSegment(zone ?? DEFAULT_ZONE).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `n${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "nodepool";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const clusterNameOf = (project: string, zone: string, clusterId: string) =>
  `projects/${project}/zones/${zone}/clusters/${clusterId}`;

const resourceName = (
  project: string,
  zone: string,
  clusterId: string,
  nodePoolId: string,
) => `${clusterNameOf(project, zone, clusterId)}/nodePools/${nodePoolId}`;

const parseName = (name: string) => {
  const idx = name.indexOf("projects/");
  const path = idx >= 0 ? name.slice(idx) : name;
  const parts = path.split("/").filter((part) => part.length > 0);
  const poolsAt = parts.lastIndexOf("nodePools");
  const clustersAt = parts.lastIndexOf("clusters");
  const zonesAt = parts.lastIndexOf("zones");
  const locationsAt = parts.lastIndexOf("locations");
  const locAt = zonesAt >= 0 ? zonesAt : locationsAt;
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    zone: locAt >= 0 && parts[locAt + 1] ? parts[locAt + 1]! : DEFAULT_ZONE,
    clusterId:
      clustersAt >= 0 && parts[clustersAt + 1] ? parts[clustersAt + 1]! : "",
    nodePoolId:
      poolsAt >= 0 && parts[poolsAt + 1]
        ? parts[poolsAt + 1]!
        : lastSegment(name),
  };
};

const parseClusterRef = (
  cluster: string,
  fallbackProject: string,
  fallbackZone: string | undefined,
) => {
  const trimmed = cluster.trim();
  if (trimmed.includes("/clusters/") || trimmed.includes("projects/")) {
    const parsed = parseName(
      trimmed.includes("/nodePools/") ? trimmed : `${trimmed}/nodePools/_`,
    );
    return {
      project: parsed.project || fallbackProject,
      zone: normalizeZone(parsed.zone || fallbackZone),
      clusterId: parsed.clusterId,
    };
  }
  return {
    project: fallbackProject,
    zone: normalizeZone(fallbackZone),
    clusterId: lastSegment(trimmed),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const stringMap = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(labels);

const sameStrings = (left: readonly string[], right: readonly string[]) => {
  if (left.length !== right.length) return false;
  const a = [...left].map((item) => item.toLowerCase()).sort();
  const b = [...right].map((item) => item.toLowerCase()).sort();
  return a.every((value, index) => value === b[index]);
};

const sameStringMap = (
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) => {
  const a = stringMap(left);
  const b = stringMap(right);
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
};

const taintKey = (taint: ClustersNodePoolTaint) =>
  `${taint.key ?? ""}\0${taint.value ?? ""}\0${(taint.effect ?? "").toUpperCase()}`;

const sameTaints = (
  left: readonly ClustersNodePoolTaint[] | undefined,
  right: readonly ClustersNodePoolTaint[] | undefined,
) => {
  const a = [...(left ?? [])].map(taintKey).sort();
  const b = [...(right ?? [])].map(taintKey).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const autoscalingKey = (value: ClustersNodePoolAutoscaling | undefined) =>
  JSON.stringify({
    enabled: value?.enabled === true,
    minNodeCount: value?.minNodeCount ?? 0,
    maxNodeCount: value?.maxNodeCount ?? 0,
    totalMinNodeCount: value?.totalMinNodeCount ?? 0,
    totalMaxNodeCount: value?.totalMaxNodeCount ?? 0,
    locationPolicy: (value?.locationPolicy ?? "").toUpperCase(),
    autoprovisioned: value?.autoprovisioned === true,
  });

const managementKey = (value: ClustersNodePoolManagement | undefined) =>
  JSON.stringify({
    autoRepair: value?.autoRepair === true,
    autoUpgrade: value?.autoUpgrade === true,
  });

const upgradeKey = (value: ClustersNodePoolUpgradeSettings | undefined) =>
  JSON.stringify({
    maxSurge: value?.maxSurge ?? 0,
    maxUnavailable: value?.maxUnavailable ?? 0,
    strategy: (value?.strategy ?? "").toUpperCase(),
  });

const toId = (id: string, nodePoolId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      nodePoolId ??
      existing ??
      rfc1035(
        yield* createPhysicalName({
          id,
          maxLength: MAX_NAME_LENGTH,
          lowercase: true,
        }),
      )
    );
  });

const toAttrs = (
  pool: container.NodePool,
  project: string,
  zone: string,
  clusterId: string,
) => {
  const selfLink = pool.selfLink ?? "";
  const parsed = parseName(
    selfLink.length > 0
      ? selfLink
      : resourceName(project, zone, clusterId, pool.name ?? ""),
  );
  const nodePoolId = pool.name || parsed.nodePoolId;
  const resolvedProject = parsed.project || project;
  const resolvedZone = normalizeZone(parsed.zone || zone);
  const resolvedCluster = parsed.clusterId || clusterId;
  const config = pool.config;
  return {
    name: resourceName(
      resolvedProject,
      resolvedZone,
      resolvedCluster,
      nodePoolId,
    ),
    nodePoolId,
    clusterId: resolvedCluster,
    clusterName: clusterNameOf(resolvedProject, resolvedZone, resolvedCluster),
    project: resolvedProject,
    zone: resolvedZone,
    status: pool.status,
    version: pool.version,
    // The API omits a zero count.
    nodeCount: pool.initialNodeCount ?? 0,
    machineType: config?.machineType,
    diskSizeGb: config?.diskSizeGb,
    diskType: config?.diskType,
    imageType: config?.imageType,
    spot: config?.spot === true,
    preemptible: config?.preemptible === true,
    labels: userLabels(config?.resourceLabels),
    nodeLabels: stringMap(config?.labels),
    tags: [...(config?.tags ?? [])],
    nodeLocations: [...(pool.locations ?? [])],
    autoscaling: pool.autoscaling,
    management: pool.management
      ? {
          autoRepair: pool.management.autoRepair,
          autoUpgrade: pool.management.autoUpgrade,
        }
      : undefined,
    instanceGroupUrls: [...(pool.instanceGroupUrls ?? [])],
    selfLink: pool.selfLink,
  };
};

const getByRef = (
  project: string,
  zone: string,
  clusterId: string,
  nodePoolId: string,
) =>
  container
    .getProjectsZonesClustersNodePools({
      projectId: project,
      zone,
      clusterId,
      nodePoolId,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getByName = (name: string) => {
  const parsed = parseName(name);
  return getByRef(
    parsed.project,
    normalizeZone(parsed.zone),
    parsed.clusterId,
    parsed.nodePoolId,
  );
};

const operationIdOf = (operation: container.Operation) => {
  const raw = operation.name ?? "";
  if (raw.includes("/operations/")) {
    return lastSegment(raw);
  }
  const fromLink = operation.selfLink ?? "";
  if (fromLink.includes("/operations/")) {
    return lastSegment(fromLink);
  }
  return lastSegment(raw);
};

/**
 * Wait for a zonal GKE node-pool operation (create/delete takes several
 * minutes). ALREADY_EXISTS (code 6) counts as success (create race); with
 * `notFoundOk`, so does NOT_FOUND (code 5, delete race) and an operation
 * that is already gone.
 */
const waitForOperation = (
  project: string,
  zone: string,
  operation: container.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    { ...operation, name: operationIdOf(operation) },
    (operationId) =>
      container.getProjectsZonesOperations({
        projectId: project,
        zone,
        operationId,
      }),
    { budget: "20 minutes", interval: "10 seconds" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          (error.code === 6 ||
            (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );

const waitUntilExists = (
  project: string,
  zone: string,
  clusterId: string,
  nodePoolId: string,
) => {
  const name = resourceName(project, zone, clusterId, nodePoolId);
  return getByRef(project, zone, clusterId, nodePoolId).pipe(
    Effect.filterOrFail(
      (pool): pool is container.NodePool => pool !== undefined,
      () => new ClustersNodePoolNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Container.ClustersNodePoolNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );
};

const waitUntilReady = (
  project: string,
  zone: string,
  clusterId: string,
  nodePoolId: string,
) => {
  const name = resourceName(project, zone, clusterId, nodePoolId);
  return getByRef(project, zone, clusterId, nodePoolId).pipe(
    Effect.filterOrFail(
      (pool): pool is container.NodePool => pool !== undefined,
      () => new ClustersNodePoolNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (pool) => {
        const status = pool.status ?? "STATUS_UNSPECIFIED";
        return status !== "ERROR" && status !== "STOPPING";
      },
      (pool) =>
        new ClustersNodePoolOperationFailed({
          operation: name,
          message:
            pool.statusMessage ??
            `node pool is in ${pool.status ?? "STATUS_UNSPECIFIED"}`,
        }),
    ),
    Effect.filterOrFail(
      (pool) => {
        const status = pool.status ?? "STATUS_UNSPECIFIED";
        return status === "RUNNING" || status === "RUNNING_WITH_ERROR";
      },
      (pool) =>
        new ClustersNodePoolNotReady({
          name,
          status: pool.status ?? "STATUS_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Container.ClustersNodePoolNotReady" ||
        error._tag === "GCP.Container.ClustersNodePoolNotResolved",
      // Node pool create/delete takes several minutes.
      times: 60,
      schedule: Schedule.spaced("10 seconds"),
    }),
  );
};

const waitUntilGone = (
  project: string,
  zone: string,
  clusterId: string,
  nodePoolId: string,
) => {
  const name = resourceName(project, zone, clusterId, nodePoolId);
  return getByRef(project, zone, clusterId, nodePoolId).pipe(
    Effect.flatMap((pool) =>
      pool === undefined
        ? Effect.void
        : Effect.fail(new ClustersNodePoolStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Container.ClustersNodePoolStillExists",
      // Node pool create/delete takes several minutes.
      times: 60,
      schedule: Schedule.spaced("10 seconds"),
    }),
  );
};

const retryConflict = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const toCreatePool = (
  news: ClustersNodePoolProps,
  nodePoolId: string,
  desiredLabels: Record<string, string>,
  workloadIdentity: boolean,
): container.NodePool => ({
  name: nodePoolId,
  initialNodeCount: news.nodeCount ?? DEFAULT_NODE_COUNT,
  config: {
    machineType: news.machineType ?? DEFAULT_MACHINE_TYPE,
    diskSizeGb: news.diskSizeGb ?? DEFAULT_DISK_SIZE_GB,
    diskType: news.diskType ?? DEFAULT_DISK_TYPE,
    imageType: news.imageType,
    spot: news.spot === true,
    preemptible: news.preemptible === true,
    resourceLabels: desiredLabels,
    labels: news.nodeLabels,
    tags: news.tags,
    taints: news.taints,
    oauthScopes: news.oauthScopes,
    serviceAccount: news.serviceAccount,
    localSsdCount: news.localSsdCount,
    bootDiskKmsKey: news.bootDiskKmsKey,
    // GKE rejects GKE_METADATA on clusters without Workload Identity.
    workloadMetadataConfig: workloadIdentity
      ? { mode: "GKE_METADATA" }
      : undefined,
  },
  autoscaling: news.autoscaling,
  management: news.management,
  version: news.version,
  locations: news.nodeLocations,
  maxPodsConstraint:
    news.maxPodsPerNode !== undefined
      ? { maxPodsPerNode: String(news.maxPodsPerNode) }
      : undefined,
  upgradeSettings: news.upgradeSettings,
});

const poolLabels = (pool: container.NodePool) =>
  tagRecord(pool.config?.resourceLabels);

const systemLabels = (labels: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(labels).filter(([key]) => key.startsWith("goog-")),
  );

const shortName = (value: string | undefined, fallback: string) =>
  lastSegment(value ?? fallback);

const desiredManagement = (
  news: ClustersNodePoolManagement,
  observed: ClustersNodePoolManagement | undefined,
): ClustersNodePoolManagement => ({
  autoRepair: news.autoRepair ?? observed?.autoRepair,
  autoUpgrade: news.autoUpgrade ?? observed?.autoUpgrade,
});

const identityOf = (
  name: string,
  fallback: {
    project: string;
    zone: string;
    clusterId: string;
    nodePoolId: string;
  },
) => {
  const parsed = parseName(name);
  return {
    project: parsed.project || fallback.project,
    zone: normalizeZone(parsed.zone || fallback.zone),
    clusterId: parsed.clusterId || fallback.clusterId,
    nodePoolId: parsed.nodePoolId || fallback.nodePoolId,
  };
};

export const ClustersNodePoolProvider = () =>
  Provider.succeed(ClustersNodePool, {
    stables: [
      "name",
      "nodePoolId",
      "clusterId",
      "clusterName",
      "project",
      "zone",
      "selfLink",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (news.cluster === undefined || news.cluster.length === 0) {
        return undefined;
      }

      const previousId = olds?.nodePoolId ?? output?.nodePoolId;
      const nextId = news.nodePoolId ?? previousId;
      const previousCluster = lastSegment(
        olds?.cluster ?? output?.clusterId ?? "",
      );
      const nextCluster = lastSegment(
        parseClusterRef(news.cluster, "", news.zone ?? output?.zone).clusterId,
      );
      const previousZone = normalizeZone(olds?.zone ?? output?.zone);
      const nextZone = normalizeZone(
        parseClusterRef(news.cluster, "", news.zone ?? output?.zone).zone,
      );
      const previousSpot = olds?.spot === true || output?.spot === true;
      const nextSpot = news.spot === true;
      const previousPreemptible =
        olds?.preemptible === true || output?.preemptible === true;
      const nextPreemptible = news.preemptible === true;
      const previousSa = olds?.serviceAccount ?? "";
      const nextSa = news.serviceAccount ?? previousSa;
      const previousKms = olds?.bootDiskKmsKey ?? "";
      const nextKms = news.bootDiskKmsKey ?? previousKms;
      const previousSsds = olds?.localSsdCount ?? 0;
      const nextSsds = news.localSsdCount ?? previousSsds;
      const previousPods = olds?.maxPodsPerNode;
      const nextPods = news.maxPodsPerNode ?? previousPods;
      const previousScopes = olds?.oauthScopes ?? [];
      const nextScopes = news.oauthScopes ?? previousScopes;

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousCluster.length > 0 &&
          nextCluster.length > 0 &&
          previousCluster !== nextCluster) ||
        previousZone !== nextZone ||
        previousSpot !== nextSpot ||
        previousPreemptible !== nextPreemptible ||
        previousSa !== nextSa ||
        previousKms !== nextKms ||
        previousSsds !== nextSsds ||
        (previousPods !== undefined &&
          nextPods !== undefined &&
          previousPods !== nextPods) ||
        (news.oauthScopes !== undefined &&
          !sameStrings(previousScopes, nextScopes));

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousZone === nextZone &&
          previousCluster === nextCluster &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const nodePoolId = yield* toId(id, olds?.nodePoolId, output?.nodePoolId);
      const clusterRef =
        (typeof olds?.cluster === "string" ? olds.cluster : undefined) ??
        output?.clusterName ??
        output?.clusterId ??
        "";
      // A pool whose cluster never resolved (e.g. the cluster create failed)
      // was never created and cannot be looked up.
      if (output?.name === undefined && clusterRef.trim().length === 0) {
        return undefined;
      }
      const ref = parseClusterRef(
        clusterRef,
        env.project,
        olds?.zone ?? output?.zone,
      );
      const name =
        output?.name ??
        resourceName(ref.project, ref.zone, ref.clusterId, nodePoolId);
      const identity = identityOf(name, { ...ref, nodePoolId });
      const existing = yield* getByRef(
        identity.project,
        identity.zone,
        identity.clusterId,
        identity.nodePoolId,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        identity.project,
        identity.zone,
        identity.clusterId,
      );
      return (yield* hasAlchemyLabels(id, poolLabels(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const page = yield* container
          .listProjectsZonesClusters({
            projectId: env.project,
            zone: "-",
          })
          .pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                clusters: [],
              } satisfies container.ListClustersResponse),
            ),
          );

        const found: ReturnType<typeof toAttrs>[] = [];
        for (const cluster of page.clusters ?? []) {
          const parsed = parseName(
            cluster.selfLink ??
              resourceName(
                env.project,
                cluster.zone ?? cluster.location ?? DEFAULT_ZONE,
                cluster.name ?? "",
                "_",
              ),
          );
          const project = parsed.project || env.project;
          const zone = normalizeZone(
            cluster.zone ?? cluster.location ?? parsed.zone,
          );
          const clusterId = cluster.name || parsed.clusterId;
          const nested = cluster.nodePools;
          const pools =
            nested !== undefined
              ? nested
              : yield* container
                  .listProjectsZonesClustersNodePools({
                    projectId: project,
                    zone,
                    clusterId,
                  })
                  .pipe(
                    Effect.map((response) => response.nodePools ?? []),
                    Effect.catchTag("NotFound", () =>
                      Effect.succeed([] as container.NodePool[]),
                    ),
                  );
          for (const pool of pools) {
            if (
              Object.keys(pool.config?.resourceLabels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              )
            ) {
              found.push(toAttrs(pool, project, zone, clusterId));
            }
          }
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      if (news.cluster === undefined || news.cluster.length === 0) {
        return yield* new ClustersNodePoolClusterMissing({
          message:
            "GCP.Container.ClustersNodePool requires `cluster` (cluster id or full resource name).",
        });
      }
      const ref = parseClusterRef(
        news.cluster,
        env.project,
        news.zone ?? output?.zone,
      );
      const nodePoolId = yield* toId(id, news.nodePoolId, output?.nodePoolId);
      const name = resourceName(
        ref.project,
        ref.zone,
        ref.clusterId,
        nodePoolId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const nodeCount = news.nodeCount ?? DEFAULT_NODE_COUNT;
      const machineType = news.machineType ?? DEFAULT_MACHINE_TYPE;
      const diskSizeGb = news.diskSizeGb ?? DEFAULT_DISK_SIZE_GB;
      const diskType = news.diskType ?? DEFAULT_DISK_TYPE;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const cluster = yield* container
          .getProjectsZonesClusters({
            projectId: ref.project,
            zone: ref.zone,
            clusterId: ref.clusterId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        const workloadIdentity =
          (cluster?.workloadIdentityConfig?.workloadPool ?? "").length > 0;
        const created = yield* retryConflict(
          container
            .createProjectsZonesClustersNodePools({
              projectId: ref.project,
              zone: ref.zone,
              clusterId: ref.clusterId,
              body: {
                nodePool: toCreatePool(
                  news,
                  nodePoolId,
                  desiredLabels,
                  workloadIdentity,
                ),
              },
            })
            .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined))),
        );
        if (created !== undefined) {
          yield* waitForOperation(ref.project, ref.zone, created);
        }
        current = yield* waitUntilExists(
          ref.project,
          ref.zone,
          ref.clusterId,
          nodePoolId,
        );
      }

      if (current === undefined) {
        return yield* new ClustersNodePoolNotResolved({ name });
      }

      let live = current;
      const status = live.status ?? "STATUS_UNSPECIFIED";
      if (status !== "RUNNING" && status !== "RUNNING_WITH_ERROR") {
        live = yield* waitUntilReady(
          ref.project,
          ref.zone,
          ref.clusterId,
          nodePoolId,
        );
      }

      const apply = (operation: container.Operation) =>
        Effect.gen(function* () {
          yield* waitForOperation(ref.project, ref.zone, operation);
          return yield* waitUntilReady(
            ref.project,
            ref.zone,
            ref.clusterId,
            nodePoolId,
          );
        });

      const observedLabels = poolLabels(live);
      const nextLabels = { ...systemLabels(observedLabels), ...desiredLabels };
      const { upsert, removed } = diffLabels(observedLabels, nextLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const observedMachine = shortName(
        live.config?.machineType,
        DEFAULT_MACHINE_TYPE,
      );
      const machineChanged =
        observedMachine.toLowerCase() !== machineType.toLowerCase();
      const observedDiskSize = live.config?.diskSizeGb ?? DEFAULT_DISK_SIZE_GB;
      const diskSizeChanged = observedDiskSize !== diskSizeGb;
      const observedDiskType = shortName(
        live.config?.diskType,
        DEFAULT_DISK_TYPE,
      ).toLowerCase();
      const diskTypeChanged = observedDiskType !== diskType.toLowerCase();
      const imageChanged =
        news.imageType !== undefined &&
        (live.config?.imageType ?? "") !== news.imageType;
      const versionChanged =
        news.version !== undefined && (live.version ?? "") !== news.version;
      const nodeLabelsChanged =
        news.nodeLabels !== undefined &&
        !sameStringMap(stringMap(live.config?.labels), news.nodeLabels);
      const tagsChanged =
        news.tags !== undefined &&
        !sameStrings(live.config?.tags ?? [], news.tags);
      const taintsChanged =
        news.taints !== undefined &&
        !sameTaints(live.config?.taints, news.taints);
      const upgradeChanged =
        news.upgradeSettings !== undefined &&
        upgradeKey(live.upgradeSettings) !== upgradeKey(news.upgradeSettings);
      const locationsChanged =
        news.nodeLocations !== undefined &&
        !sameStrings(live.locations ?? [], news.nodeLocations);

      const configChanged =
        labelsChanged ||
        machineChanged ||
        diskSizeChanged ||
        diskTypeChanged ||
        imageChanged ||
        versionChanged ||
        nodeLabelsChanged ||
        tagsChanged ||
        taintsChanged ||
        upgradeChanged;

      if (configChanged) {
        const imageType = news.imageType ?? live.config?.imageType;
        const nodeVersion = news.version ?? live.version;
        const body: container.UpdateNodePoolRequest = {};
        if (imageType !== undefined) body.imageType = imageType;
        if (nodeVersion !== undefined) body.nodeVersion = nodeVersion;
        if (labelsChanged) {
          body.resourceLabels = { labels: nextLabels };
        }
        if (machineChanged) body.machineType = machineType;
        if (diskSizeChanged) body.diskSizeGb = String(diskSizeGb);
        if (diskTypeChanged) body.diskType = diskType;
        if (nodeLabelsChanged) {
          body.labels = { labels: news.nodeLabels };
        }
        if (tagsChanged) body.tags = { tags: news.tags };
        if (taintsChanged) body.taints = { taints: news.taints };
        if (upgradeChanged) body.upgradeSettings = news.upgradeSettings;
        const updated = yield* retryConflict(
          container.updateProjectsZonesClustersNodePools({
            projectId: ref.project,
            zone: ref.zone,
            clusterId: ref.clusterId,
            nodePoolId,
            body,
          }),
        );
        live = yield* apply(updated);
      }

      if (locationsChanged) {
        const imageType = news.imageType ?? live.config?.imageType;
        const nodeVersion = news.version ?? live.version;
        const relocated = yield* retryConflict(
          container.updateProjectsZonesClustersNodePools({
            projectId: ref.project,
            zone: ref.zone,
            clusterId: ref.clusterId,
            nodePoolId,
            body: {
              locations: news.nodeLocations,
              ...(imageType !== undefined ? { imageType } : {}),
              ...(nodeVersion !== undefined ? { nodeVersion } : {}),
            },
          }),
        );
        live = yield* apply(relocated);
      }

      if (
        news.autoscaling !== undefined &&
        autoscalingKey(live.autoscaling) !== autoscalingKey(news.autoscaling)
      ) {
        const scaled = yield* retryConflict(
          container.autoscalingProjectsZonesClustersNodePools({
            projectId: ref.project,
            zone: ref.zone,
            clusterId: ref.clusterId,
            nodePoolId,
            body: { autoscaling: news.autoscaling },
          }),
        );
        live = yield* apply(scaled);
      }

      if (news.management !== undefined) {
        const nextManagement = desiredManagement(
          news.management,
          live.management,
        );
        if (managementKey(live.management) !== managementKey(nextManagement)) {
          const managed = yield* retryConflict(
            container.setManagementProjectsZonesClustersNodePools({
              projectId: ref.project,
              zone: ref.zone,
              clusterId: ref.clusterId,
              nodePoolId,
              body: { management: nextManagement },
            }),
          );
          live = yield* apply(managed);
        }
      }

      const autoscalingOn =
        news.autoscaling?.enabled === true ||
        live.autoscaling?.enabled === true;
      if (!autoscalingOn && (live.initialNodeCount ?? 0) !== nodeCount) {
        const resized = yield* retryConflict(
          container.setSizeProjectsZonesClustersNodePools({
            projectId: ref.project,
            zone: ref.zone,
            clusterId: ref.clusterId,
            nodePoolId,
            body: { nodeCount },
          }),
        );
        live = yield* apply(resized);
      }

      return toAttrs(live, ref.project, ref.zone, ref.clusterId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const zone = normalizeZone(output.zone);
      const clusterId = output.clusterId;
      const nodePoolId = output.nodePoolId;
      const project = output.project || env.project;
      const operation = yield* container
        .deleteProjectsZonesClustersNodePools({
          projectId: project,
          zone,
          clusterId,
          nodePoolId,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(project, zone, operation, {
          notFoundOk: true,
        });
      }
      yield* waitUntilGone(project, zone, clusterId, nodePoolId);
    }),
  });
