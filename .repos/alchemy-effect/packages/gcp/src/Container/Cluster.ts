import { deleteObjects, reconcileObjects } from "@alchemy.run/kubernetes/Client";
import type { Connection } from "@alchemy.run/kubernetes/Connection";
import {
  type KubernetesObjectBinding,
  type KubernetesObjectDefinition,
  type KubernetesObjectRef,
} from "@alchemy.run/kubernetes/Objects";
import * as container from "@distilled.cloud/gcp/container_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import { matchesDesired } from "../Proto.ts";
import type { Providers } from "../Providers.ts";
import {
  apiServerEndpoint,
  gkeConnectionOf,
  makeGkeTransport,
  workloadPoolOf,
} from "./KubernetesAdapter.ts";

// A zone, not a region: `GCP.Region` has no zone and a regional default would triple node count.
const DEFAULT_LOCATION = "us-central1-a";
const DEFAULT_MACHINE_TYPE = "e2-medium";
const DEFAULT_DISK_TYPE = "pd-standard";
const DEFAULT_DISK_SIZE_GB = 20;
const DEFAULT_NODE_COUNT = 1;
const DEFAULT_POOL_NAME = "default-pool";
const MAX_NAME_LENGTH = 40;

export type ClusterProps = {
  /**
   * Cluster id (the `{cluster}` segment of
   * `projects/{project}/locations/{location}/clusters/{cluster}`). If
   * omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-40 characters, start with a letter, and
   * match `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces
   * the cluster.
   */
  clusterId?: string;
  /**
   * Zone or region (`us-central1-a`, `us-central1`, …). Immutable —
   * changing it replaces the cluster. Autopilot clusters must be
   * regional. `US-CENTRAL1-A` is accepted and normalized to
   * `us-central1-a`.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Optional description. Immutable — changing it replaces the cluster.
   */
  description?: string;
  /**
   * User labels stored as GKE `resourceLabels`. Alchemy ownership labels
   * are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * VPC network name or URL. Immutable — changing it replaces the cluster.
   * Defaults to the project `default` network.
   */
  network?: string;
  /**
   * Subnetwork name or URL. Immutable — changing it replaces the cluster.
   */
  subnetwork?: string;
  /**
   * Alias-IP allocation for Pods and Services. Secondary range names and
   * CIDRs are create-time topology, so changing this replaces the cluster.
   * @default `{ useIpAliases: true }` (VPC-native)
   */
  ipAllocationPolicy?: container.IPAllocationPolicy;
  /**
   * Private control-plane and node networking. Changing private-node mode,
   * the control-plane CIDR, or the private endpoint subnetwork replaces the
   * cluster; `enablePrivateEndpoint` and `masterGlobalAccessConfig` update
   * in place.
   */
  privateClusterConfig?: container.PrivateClusterConfig;
  /**
   * Networks allowed to reach the public control-plane endpoint.
   */
  masterAuthorizedNetworksConfig?: container.MasterAuthorizedNetworksConfig;
  /**
   * Cluster datapath implementation (`LEGACY_DATAPATH` or
   * `ADVANCED_DATAPATH` for Dataplane V2).
   */
  datapathProvider?: container.NetworkConfigDatapathProviderEnum;
  /**
   * Enable Shielded GKE Nodes.
   */
  enableShieldedNodes?: boolean;
  /**
   * GKE addon configuration (HTTP load balancing, network policy, …).
   */
  addonsConfig?: container.AddonsConfig;
  /**
   * Fine-grained cost allocation configuration.
   */
  costManagementConfig?: container.CostManagementConfig;
  /**
   * Create an Autopilot cluster. Immutable — changing it replaces the
   * cluster. Node pool props (`initialNodeCount`, `machineType`, …) are
   * ignored when Autopilot is enabled.
   * @default false
   */
  autopilot?: boolean;
  /**
   * Initial Kubernetes version (or alias such as `"1.31"` / `"latest"`).
   * Applied at create time only.
   */
  initialClusterVersion?: string;
  /**
   * Logging service (`logging.googleapis.com/kubernetes` or `none`).
   */
  loggingService?: string;
  /**
   * Components exported through Cloud Logging.
   */
  loggingConfig?: container.LoggingConfig;
  /**
   * Monitoring service (`monitoring.googleapis.com/kubernetes` or `none`).
   */
  monitoringService?: string;
  /**
   * Components exported through Cloud Monitoring.
   */
  monitoringConfig?: container.MonitoringConfig;
  /**
   * Enable Kubernetes alpha APIs. The cluster is deleted after 30 days
   * and has no SLA. Immutable — changing it replaces the cluster.
   * @default false
   */
  enableKubernetesAlpha?: boolean;
  /**
   * Release channel (`RAPID`, `REGULAR`, `STABLE`, `EXTENDED`).
   */
  releaseChannel?: container.ReleaseChannelChannelEnum | (string & {});
  /**
   * Zones in which nodes should run. Must include the cluster's primary
   * zone for zonal clusters.
   */
  nodeLocations?: string[];
  /**
   * Initial node count for the default pool. Ignored on Autopilot, and on
   * update when `removeDefaultNodePool` is set. Otherwise immutable —
   * changing it replaces the cluster.
   * @default 1
   */
  initialNodeCount?: number;
  /**
   * Machine type for the default pool. Ignored on Autopilot, and on update
   * when `removeDefaultNodePool` is set. Otherwise immutable — changing it
   * replaces the cluster.
   * @default "e2-medium"
   */
  machineType?: string;
  /**
   * Boot disk size in GB for the default pool. Ignored on Autopilot, and on
   * update when `removeDefaultNodePool` is set. Otherwise immutable —
   * changing it replaces the cluster.
   * @default 20
   */
  diskSizeGb?: number;
  /**
   * Boot disk type for the default pool (`pd-standard`, `pd-balanced`,
   * `pd-ssd`). Ignored on Autopilot, and on update when
   * `removeDefaultNodePool` is set. Otherwise immutable — changing it
   * replaces the cluster.
   * @default "pd-standard"
   */
  diskType?: string;
  /**
   * Use Spot VMs for the default pool. Ignored on Autopilot, and on update
   * when `removeDefaultNodePool` is set. Otherwise immutable — changing it
   * replaces the cluster.
   * @default false
   */
  spot?: boolean;
  /**
   * Use preemptible VMs for the default pool. Ignored on Autopilot, and on
   * update when `removeDefaultNodePool` is set. Otherwise immutable —
   * changing it replaces the cluster.
   * @default false
   */
  preemptible?: boolean;
  /**
   * Service account email for the default pool's nodes, or for every node
   * Autopilot provisions. Changing it replaces the cluster unless
   * `removeDefaultNodePool` is set.
   * @default the Compute Engine default service account
   */
  serviceAccount?: string;
  /**
   * OAuth scopes for the default pool's nodes, or for every node Autopilot
   * provisions. Changing them replaces the cluster unless
   * `removeDefaultNodePool` is set.
   */
  oauthScopes?: string[];
  /**
   * Delete GKE's bootstrap `default-pool` once the cluster is ready, so
   * separately declared `NodePool` resources own every node. While set,
   * the default-pool props above never replace the cluster. Turning it back
   * off replaces the cluster, since GKE only creates `default-pool` at
   * cluster creation.
   * @default false
   */
  removeDefaultNodePool?: boolean;
  /**
   * Refuse replacement and destruction while set. A change that would
   * replace a protected cluster fails at plan time, so disable protection
   * in its own deploy first. Account-wide `nuke` bypasses this guard.
   * @default false
   */
  deletionProtection?: boolean;
};

export type Cluster = Resource<
  "GCP.Container.Cluster",
  ClusterProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/clusters/{cluster}`. */
    name: string;
    /** Cluster id (last path segment). */
    clusterId: string;
    /** Project id. */
    project: string;
    /** Zone or region id. */
    location: string;
    /** Server-assigned unique cluster id. */
    clusterUid: string | undefined;
    /** Current status (`RUNNING`, `PROVISIONING`, …). */
    status: string | undefined;
    /** Kubernetes API server endpoint URL. */
    endpoint: string | undefined;
    /**
     * Base64-encoded cluster CA from
     * `masterAuth.clusterCaCertificate`.
     */
    certificateAuthorityData: string | undefined;
    /**
     * The cluster-agnostic `Kubernetes.Connection` for this cluster.
     * Passing the whole cluster resource as a `Kubernetes.*` workload's
     * `cluster` prop resolves through this — auth uses Google OAuth
     * bearer tokens minted from the ambient GCP credentials.
     */
    connection: Connection;
    /** References to Kubernetes objects applied via the binding contract. */
    kubernetesObjects: KubernetesObjectRef[];
    /**
     * Workload Identity pool (`{project}.svc.id.goog`) when enabled.
     * Distilled has no IAM v1, so GSA CRUD is out of band; Alchemy still
     * enables WI on the cluster and annotates KSAs when
     * `identity.gcpServiceAccount` is set.
     */
    workloadPool: string | undefined;
    /** Current control-plane version. */
    currentMasterVersion: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** VPC network. */
    network: string | undefined;
    /** Subnetwork. */
    subnetwork: string | undefined;
    /** Alias-IP allocation. */
    ipAllocationPolicy: container.IPAllocationPolicy | undefined;
    /** Private-cluster configuration. */
    privateClusterConfig: container.PrivateClusterConfig | undefined;
    /** Control-plane authorized networks. */
    masterAuthorizedNetworksConfig: container.MasterAuthorizedNetworksConfig | undefined;
    /** Datapath provider (omitted by GKE for `LEGACY_DATAPATH`). */
    datapathProvider: string | undefined;
    /** Whether Shielded GKE Nodes are enabled. */
    enableShieldedNodes: boolean;
    /** GKE addon configuration. */
    addonsConfig: container.AddonsConfig | undefined;
    /** Fine-grained cost allocation configuration. */
    costManagementConfig: container.CostManagementConfig | undefined;
    /** Logging service. */
    loggingService: string | undefined;
    /** Cloud Logging component configuration. */
    loggingConfig: container.LoggingConfig | undefined;
    /** Monitoring service. */
    monitoringService: string | undefined;
    /** Cloud Monitoring component configuration. */
    monitoringConfig: container.MonitoringConfig | undefined;
    /** Whether Autopilot is enabled. */
    autopilot: boolean;
    /** Whether Kubernetes alpha APIs are enabled. */
    enableKubernetesAlpha: boolean;
    /** Release channel (`RAPID`, `REGULAR`, …). */
    releaseChannel: string | undefined;
    /** Node locations currently configured. */
    nodeLocations: string[];
    /** Services IPv4 CIDR. */
    servicesIpv4Cidr: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  KubernetesObjectBinding,
  Providers
>;

/**
 * A Google Kubernetes Engine cluster.
 *
 * Changing `clusterId`, `location`, `description`, `network`,
 * `subnetwork`, `ipAllocationPolicy`, private-node topology, `autopilot`,
 * `enableKubernetesAlpha`, the node identity (`serviceAccount`,
 * `oauthScopes`), or default-pool node shape (`initialNodeCount`,
 * `machineType`, `diskSizeGb`, `diskType`, `spot`, `preemptible`) replaces
 * the cluster — except that default-pool props are ignored on update while
 * `removeDefaultNodePool` is set. Labels, endpoint access, Shielded Nodes,
 * addons, datapath, logging/monitoring, cost management, release channel,
 * and node locations update in place.
 *
 * Provisioning typically takes several minutes.
 *
 * ### Creating a Cluster
 * **Example:** Generated name, zonal default pool
 * ```typescript
 * const cluster = yield* GCP.Container.Cluster("App", {});
 * ```
 *
 * **Example:** Explicit id, labels, and Spot nodes
 * ```typescript
 * const cluster = yield* GCP.Container.Cluster("App", {
 *   clusterId: "app-cluster",
 *   location: "us-central1-a",
 *   machineType: "e2-medium",
 *   initialNodeCount: 1,
 *   spot: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Private Clusters
 * **Example:** Private nodes, Dataplane V2, and separately managed pools
 * ```typescript
 * const nodes = yield* GCP.IAM.ServiceAccount("GkeNodes", {});
 * const cluster = yield* GCP.Container.Cluster("App", {
 *   network: network.networkName,
 *   subnetwork: subnet.subnetworkName,
 *   ipAllocationPolicy: {
 *     useIpAliases: true,
 *     clusterSecondaryRangeName: "pods",
 *     servicesSecondaryRangeName: "services",
 *   },
 *   privateClusterConfig: {
 *     enablePrivateNodes: true,
 *     masterIpv4CidrBlock: "172.16.0.0/28",
 *   },
 *   masterAuthorizedNetworksConfig: {
 *     enabled: true,
 *     cidrBlocks: [{ cidrBlock: "203.0.113.0/24", displayName: "office" }],
 *   },
 *   datapathProvider: "ADVANCED_DATAPATH",
 *   enableShieldedNodes: true,
 *   serviceAccount: nodes.email,
 *   removeDefaultNodePool: true,
 *   deletionProtection: true,
 * });
 * yield* GCP.Container.NodePool("Workers", {
 *   cluster: cluster.name,
 *   serviceAccount: nodes.email,
 *   shieldedInstanceConfig: { enableSecureBoot: true },
 * });
 * ```
 *
 * ### Autopilot
 * **Example:** Regional Autopilot cluster
 * ```typescript
 * const cluster = yield* GCP.Container.Cluster("App", {
 *   location: "us-central1",
 *   autopilot: true,
 *   releaseChannel: "REGULAR",
 * });
 * ```
 *
 * **Example:** Autopilot nodes with a dedicated service account
 * ```typescript
 * const nodes = yield* GCP.IAM.ServiceAccount("GkeNodes", {});
 * yield* GCP.IAM.Member("GkeNodesRole", {
 *   kind: "project",
 *   name: "my-project",
 *   role: "roles/container.defaultNodeServiceAccount",
 *   member: Output.interpolate`serviceAccount:${nodes.email}`,
 * });
 * const cluster = yield* GCP.Container.Cluster("App", {
 *   location: "us-central1",
 *   autopilot: true,
 *   serviceAccount: nodes.email,
 * });
 * ```
 *
 * ### Reading a Cluster
 * **Example:** Get the bound cluster
 * ```typescript
 * const getCluster = yield* GCP.Container.GetCluster(cluster);
 * const live = yield* getCluster();
 * ```
 *
 * ### Kubernetes Workloads
 * **Example:** Deploy an Effect-native workload onto the cluster
 * ```typescript
 * const cluster = yield* GCP.Container.Cluster("App", {});
 * const api = yield* Kubernetes.Deployment("Api", {
 *   cluster,
 *   main: import.meta.url,
 *   port: 8080,
 * });
 * ```
 *
 * @resource
 * @category Container
 */
export const Cluster = Resource<Cluster>("GCP.Container.Cluster");

export class ClusterNotResolved extends Data.TaggedError("GCP.Container.ClusterNotResolved")<{
  resourceName: string;
}> {}

export class ClusterNotReady extends Data.TaggedError("GCP.Container.ClusterNotReady")<{
  resourceName: string;
  status: string;
}> {}

export class ClusterOperationFailed extends Data.TaggedError(
  "GCP.Container.ClusterOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class ClusterStillExists extends Data.TaggedError("GCP.Container.ClusterStillExists")<{
  resourceName: string;
}> {}

export class ClusterDeletionProtected extends Data.TaggedError(
  "GCP.Container.ClusterDeletionProtected",
)<{
  resourceName: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const normalizeChannel = (channel: string | undefined) => {
  const value = (channel ?? "").toUpperCase();
  return value === "UNSPECIFIED" || value.length === 0 ? "" : value;
};

/** Order- and case-insensitive set comparison for string lists. */
const sameStrings = (left: string[], right: string[]) => {
  if (left.length !== right.length) return false;
  const a = [...left].map((item) => item.toLowerCase()).sort();
  const b = [...right].map((item) => item.toLowerCase()).sort();
  return a.every((value, index) => value === b[index]);
};

const desiredIpAllocationPolicy = (
  policy: container.IPAllocationPolicy | undefined,
): container.IPAllocationPolicy => ({ useIpAliases: true, ...policy });

/** The create-time part of `privateClusterConfig`. */
const privateTopology = (config: container.PrivateClusterConfig | undefined) => ({
  enablePrivateNodes: config?.enablePrivateNodes === true,
  masterIpv4CidrBlock: config?.masterIpv4CidrBlock ?? "",
  privateEndpointSubnetwork: config?.privateEndpointSubnetwork ?? "",
});

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "cluster";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (project: string, location: string, clusterId: string) =>
  `projects/${project}/locations/${location}/clusters/${clusterId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const clustersAt = parts.lastIndexOf("clusters");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project: projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : DEFAULT_LOCATION,
    clusterId:
      clustersAt >= 0 && parts[clustersAt + 1] ? parts[clustersAt + 1]! : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, clusterId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      clusterId ??
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
  cluster: container.Cluster,
  project: string,
  kubernetesObjects: KubernetesObjectRef[] = [],
) => {
  const selfLink = cluster.selfLink ?? "";
  const parsed = parseName(selfLink.length > 0 ? selfLink : (cluster.name ?? ""));
  const clusterId = cluster.name || parsed.clusterId;
  const location = lastSegment(cluster.location ?? parsed.location);
  const resolvedProject = parsed.project || project;
  const endpoint = apiServerEndpoint(cluster.endpoint) ?? cluster.endpoint;
  const certificateAuthorityData = cluster.masterAuth?.clusterCaCertificate;
  return {
    name: resourceName(resolvedProject, location, clusterId),
    clusterId,
    project: resolvedProject,
    location,
    clusterUid: cluster.id,
    status: cluster.status,
    endpoint,
    certificateAuthorityData,
    connection: gkeConnectionOf({
      clusterId,
      location,
      project: resolvedProject,
      endpoint,
      certificateAuthorityData,
    }),
    kubernetesObjects,
    workloadPool: cluster.workloadIdentityConfig?.workloadPool,
    currentMasterVersion: cluster.currentMasterVersion,
    description: cluster.description,
    labels: userLabels(cluster.resourceLabels),
    network: cluster.network,
    subnetwork: cluster.subnetwork,
    ipAllocationPolicy: cluster.ipAllocationPolicy,
    privateClusterConfig: cluster.privateClusterConfig,
    masterAuthorizedNetworksConfig: cluster.masterAuthorizedNetworksConfig,
    datapathProvider: cluster.networkConfig?.datapathProvider,
    enableShieldedNodes: cluster.shieldedNodes?.enabled === true,
    addonsConfig: cluster.addonsConfig,
    costManagementConfig: cluster.costManagementConfig,
    loggingService: cluster.loggingService,
    loggingConfig: cluster.loggingConfig,
    monitoringService: cluster.monitoringService,
    monitoringConfig: cluster.monitoringConfig,
    autopilot: cluster.autopilot?.enabled === true,
    enableKubernetesAlpha: cluster.enableKubernetesAlpha === true,
    releaseChannel: cluster.releaseChannel?.channel,
    nodeLocations: [...(cluster.locations ?? [])],
    servicesIpv4Cidr: cluster.servicesIpv4Cidr,
    selfLink: cluster.selfLink,
    createTime: cluster.createTime,
  };
};

const getDesiredKubernetesObjects = (
  bindings: ReadonlyArray<ResourceBinding<KubernetesObjectBinding>>,
): KubernetesObjectDefinition[] =>
  bindings
    .filter(
      (binding): binding is ResourceBinding<KubernetesObjectBinding> =>
        binding.data.type === "kubernetes-object",
    )
    .map((binding) => binding.data.object);

const getKubernetesTransport = (
  state: Pick<Cluster["Attributes"], "clusterId" | "endpoint" | "certificateAuthorityData">,
) =>
  Effect.suspend(() => {
    if (!state.endpoint || !state.certificateAuthorityData) {
      throw new Error(
        `GKE cluster '${state.clusterId}' is missing endpoint or certificate authority data`,
      );
    }
    return makeGkeTransport({
      endpoint: state.endpoint,
      certificateAuthorityData: state.certificateAuthorityData,
    });
  });

const getByName = (name: string) =>
  container
    .getProjectsLocationsClusters({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const operationResourceName = (
  project: string,
  location: string,
  operation: container.Operation,
) => {
  const raw = operation.name ?? "";
  if (raw.includes("/operations/")) {
    const idx = raw.indexOf("projects/");
    return idx >= 0 ? raw.slice(idx) : raw;
  }
  const fromLink = operation.selfLink ?? "";
  if (fromLink.includes("/operations/")) {
    const idx = fromLink.indexOf("projects/");
    return idx >= 0 ? fromLink.slice(idx) : fromLink;
  }
  const loc = lastSegment(operation.location ?? operation.zone ?? location);
  return `projects/${project}/locations/${loc}/operations/${lastSegment(raw)}`;
};

// Cluster create / delete runs 5–10 min (Autopilot included) and most
// updates several minutes; bounded at 15 min.
const clusterOperationSchedule = Schedule.max([Schedule.spaced("10 seconds"), Schedule.recurs(90)]);

/**
 * Wait for a GKE operation (create/delete runs 5–10 min, Autopilot and
 * large updates longer). ALREADY_EXISTS (code 6) counts as success
 * (create race); with `notFoundOk`, so does NOT_FOUND (code 5, delete
 * race) and an operation that is already gone.
 */
const waitForOperation = (
  project: string,
  location: string,
  operation: container.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    {
      ...operation,
      name: operationResourceName(project, location, operation),
    },
    (name) => container.getProjectsLocationsOperations({ name }),
    { budget: "30 minutes", interval: "10 seconds" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          (error.code === 6 || (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (cluster): cluster is container.Cluster => cluster !== undefined,
      () => new ClusterNotResolved({ resourceName: name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Container.ClusterNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (cluster): cluster is container.Cluster => cluster !== undefined,
      () => new ClusterNotResolved({ resourceName: name }),
    ),
    Effect.filterOrFail(
      (cluster) => (cluster.status ?? "STATUS_UNSPECIFIED") !== "ERROR",
      (cluster) =>
        new ClusterOperationFailed({
          operation: name,
          message: cluster.statusMessage ?? "cluster is in ERROR",
        }),
    ),
    Effect.filterOrFail(
      (cluster) => {
        const status = cluster.status ?? "STATUS_UNSPECIFIED";
        return status === "RUNNING" || status === "DEGRADED";
      },
      (cluster) =>
        new ClusterNotReady({
          resourceName: name,
          status: cluster.status ?? "STATUS_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Container.ClusterNotReady" ||
        error._tag === "GCP.Container.ClusterNotResolved",
      schedule: clusterOperationSchedule,
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((cluster) =>
      cluster === undefined
        ? Effect.void
        : Effect.fail(new ClusterStillExists({ resourceName: name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Container.ClusterStillExists",
      schedule: clusterOperationSchedule,
    }),
  );

/**
 * GKE rejects a delete (400 "Cluster is running incompatible operation")
 * while a create/update is still in flight — e.g. a recovery delete after an
 * interrupted create. Wait for the cluster to leave its transitional states
 * first; a cluster that vanishes meanwhile is fine.
 */
const waitUntilSettled = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (cluster) => {
        const status = cluster?.status ?? "STATUS_UNSPECIFIED";
        return status !== "PROVISIONING" && status !== "RECONCILING" && status !== "STOPPING";
      },
      (cluster) =>
        new ClusterNotReady({
          resourceName: name,
          status: cluster?.status ?? "STATUS_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Container.ClusterNotReady",
      schedule: clusterOperationSchedule,
    }),
  );

/** Delete GKE's bootstrap `default-pool`; returns whether it existed. */
const ensureDefaultPoolRemoved = (project: string, location: string, clusterName: string) =>
  Effect.gen(function* () {
    const operation = yield* container
      .deleteProjectsLocationsClustersNodePools({
        name: `${clusterName}/nodePools/${DEFAULT_POOL_NAME}`,
      })
      .pipe(
        Effect.catchTag("NotFound", () => Effect.undefined),
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("5 seconds"),
        }),
      );
    if (operation === undefined) return false;
    yield* waitForOperation(project, location, operation, { notFoundOk: true });
    return true;
  });

const defaultPool = (news: ClusterProps): container.NodePool => ({
  name: DEFAULT_POOL_NAME,
  initialNodeCount: news.initialNodeCount ?? DEFAULT_NODE_COUNT,
  config: {
    machineType: news.machineType ?? DEFAULT_MACHINE_TYPE,
    diskSizeGb: news.diskSizeGb ?? DEFAULT_DISK_SIZE_GB,
    diskType: news.diskType ?? DEFAULT_DISK_TYPE,
    spot: news.spot === true,
    preemptible: news.preemptible === true,
    serviceAccount: news.serviceAccount,
    oauthScopes: news.oauthScopes,
    workloadMetadataConfig: { mode: "GKE_METADATA" },
  },
});

const toCreateBody = (
  news: ClusterProps,
  clusterId: string,
  desiredLabels: Record<string, string>,
  autopilot: boolean,
  project: string,
): container.Cluster => {
  const channel = normalizeChannel(news.releaseChannel);
  return {
    name: clusterId,
    description: news.description,
    resourceLabels: desiredLabels,
    network: news.network,
    subnetwork: news.subnetwork,
    ipAllocationPolicy: desiredIpAllocationPolicy(news.ipAllocationPolicy),
    privateClusterConfig: news.privateClusterConfig,
    masterAuthorizedNetworksConfig: news.masterAuthorizedNetworksConfig,
    networkConfig:
      news.datapathProvider !== undefined ? { datapathProvider: news.datapathProvider } : undefined,
    shieldedNodes:
      news.enableShieldedNodes !== undefined ? { enabled: news.enableShieldedNodes } : undefined,
    addonsConfig: news.addonsConfig,
    costManagementConfig: news.costManagementConfig,
    initialClusterVersion: news.initialClusterVersion,
    loggingService: news.loggingService,
    loggingConfig: news.loggingConfig,
    monitoringService: news.monitoringService,
    monitoringConfig: news.monitoringConfig,
    enableKubernetesAlpha: news.enableKubernetesAlpha === true,
    locations: news.nodeLocations,
    autopilot: autopilot ? { enabled: true } : undefined,
    // Autopilot has no default pool: its nodes take their identity from the
    // node auto-provisioning defaults instead.
    autoscaling:
      autopilot && (news.serviceAccount !== undefined || news.oauthScopes !== undefined)
        ? {
            autoprovisioningNodePoolDefaults: {
              serviceAccount: news.serviceAccount,
              oauthScopes: news.oauthScopes,
            },
          }
        : undefined,
    workloadIdentityConfig: { workloadPool: workloadPoolOf(project) },
    releaseChannel:
      channel.length > 0 ? { channel: channel as container.ReleaseChannelChannelEnum } : undefined,
    nodePools: autopilot ? undefined : [defaultPool(news)],
  };
};

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: [
      "name",
      "clusterId",
      "project",
      "location",
      "clusterUid",
      "selfLink",
      "createTime",
      "connection",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.clusterId ?? output?.clusterId;
      const nextId = news.clusterId ?? previousId;
      const previousLocation = normalizeLocation(olds?.location ?? output?.location);
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const previousAutopilot = olds?.autopilot === true || output?.autopilot === true;
      const nextAutopilot = news.autopilot === true;
      const previousNetwork = olds?.network ?? output?.network ?? "";
      const nextNetwork = news.network ?? previousNetwork;
      const previousSubnetwork = olds?.subnetwork ?? output?.subnetwork ?? "";
      const nextSubnetwork = news.subnetwork ?? previousSubnetwork;
      const previousAlpha =
        olds?.enableKubernetesAlpha === true || output?.enableKubernetesAlpha === true;
      const nextAlpha = news.enableKubernetesAlpha === true;
      const previousDescription = olds?.description ?? output?.description ?? "";
      const nextDescription = news.description ?? previousDescription;
      const previousServiceAccount = olds?.serviceAccount ?? "";
      const nextServiceAccount = news.serviceAccount ?? previousServiceAccount;
      const previousOauthScopes = olds?.oauthScopes ?? [];
      const nextOauthScopes = news.oauthScopes ?? previousOauthScopes;
      // Without previous props (adoption), compare against the observed
      // cluster so declaring what already runs is not a replacement.
      const ipAllocationChanged =
        olds !== undefined
          ? !deepEqual(
              desiredIpAllocationPolicy(olds.ipAllocationPolicy),
              desiredIpAllocationPolicy(news.ipAllocationPolicy),
              { stripNullish: true },
            )
          : output !== undefined &&
            !matchesDesired(
              output.ipAllocationPolicy,
              desiredIpAllocationPolicy(news.ipAllocationPolicy),
            );
      const privateTopologyChanged =
        news.privateClusterConfig !== undefined &&
        (olds !== undefined
          ? !deepEqual(
              privateTopology(olds.privateClusterConfig),
              privateTopology(news.privateClusterConfig),
            )
          : output !== undefined &&
            !matchesDesired(
              privateTopology(output.privateClusterConfig),
              privateTopology(news.privateClusterConfig),
            ));
      // Default-pool props only describe GKE's bootstrap `default-pool`.
      // Once it is removed (before or after this change) they describe no
      // live node and must not replace the cluster.
      const defaultPoolKept =
        news.removeDefaultNodePool !== true && olds?.removeDefaultNodePool !== true;
      // GKE only creates `default-pool` at cluster creation, so turning
      // `removeDefaultNodePool` back off can only be honored by replacing.
      const defaultPoolRestored =
        !nextAutopilot &&
        olds?.removeDefaultNodePool === true &&
        news.removeDefaultNodePool !== true;
      const nodeShapeChanged =
        !nextAutopilot &&
        defaultPoolKept &&
        olds !== undefined &&
        ((olds.initialNodeCount ?? DEFAULT_NODE_COUNT) !==
          (news.initialNodeCount ?? DEFAULT_NODE_COUNT) ||
          (olds.machineType ?? DEFAULT_MACHINE_TYPE) !==
            (news.machineType ?? DEFAULT_MACHINE_TYPE) ||
          (olds.diskSizeGb ?? DEFAULT_DISK_SIZE_GB) !== (news.diskSizeGb ?? DEFAULT_DISK_SIZE_GB) ||
          (olds.diskType ?? DEFAULT_DISK_TYPE).toLowerCase() !==
            (news.diskType ?? DEFAULT_DISK_TYPE).toLowerCase() ||
          (olds.spot === true) !== (news.spot === true) ||
          (olds.preemptible === true) !== (news.preemptible === true) ||
          previousServiceAccount !== nextServiceAccount ||
          (news.oauthScopes !== undefined && !sameStrings(previousOauthScopes, nextOauthScopes)));
      // Autopilot fixes its nodes' identity at cluster creation.
      const autopilotIdentityChanged =
        nextAutopilot &&
        olds !== undefined &&
        (previousServiceAccount !== nextServiceAccount ||
          (news.oauthScopes !== undefined && !sameStrings(previousOauthScopes, nextOauthScopes)));

      const replace =
        (previousId !== undefined && nextId !== undefined && nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousAutopilot !== nextAutopilot ||
        previousNetwork !== nextNetwork ||
        previousSubnetwork !== nextSubnetwork ||
        previousAlpha !== nextAlpha ||
        previousDescription !== nextDescription ||
        ipAllocationChanged ||
        privateTopologyChanged ||
        defaultPoolRestored ||
        nodeShapeChanged ||
        autopilotIdentityChanged;

      if (!replace) return undefined;
      // A replacement deletes the old cluster with the OLD props, so it would
      // create the new cluster and then strand on ClusterDeletionProtected.
      // Fail at plan time instead. (Adoption has no previous props; the
      // delete-side guard is the backstop there.)
      if (olds?.deletionProtection === true) {
        return yield* new ClusterDeletionProtected({
          resourceName: output?.name ?? previousId ?? nextId ?? "",
        });
      }
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation && previousId !== undefined && nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const clusterId = yield* toId(id, olds?.clusterId, output?.clusterId);
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name = output?.name ?? resourceName(env.project, location, clusterId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, output?.kubernetesObjects ?? []);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.resourceLabels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const page = yield* container
          .listProjectsLocationsClusters({
            parent: `projects/${env.project}/locations/-`,
          })
          .pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                clusters: [],
              } satisfies container.ListClustersResponse),
            ),
          );
        return (page.clusters ?? [])
          .filter((cluster) =>
            Object.keys(cluster.resourceLabels ?? {}).some((key) => key.startsWith("alchemy-")),
          )
          .map((cluster) => toAttrs(cluster, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const env = yield* GcpEnvironment.current;
      const clusterId = yield* toId(id, news.clusterId, output?.clusterId);
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, clusterId);
      const autopilot = news.autopilot === true;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredObjects = getDesiredKubernetesObjects(bindings);
      const desiredPool = workloadPoolOf(env.project);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const create = Effect.gen(function* () {
          const created = yield* container
            .createProjectsLocationsClusters({
              parent: `projects/${env.project}/locations/${location}`,
              body: {
                cluster: toCreateBody(news, clusterId, desiredLabels, autopilot, env.project),
              },
            })
            .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
          if (created !== undefined) {
            yield* waitForOperation(env.project, location, created);
          }
        });
        // GKE intermittently fails a create with INTERNAL ("Failed to create
        // cluster") and leaves the cluster in ERROR; delete it and try again.
        const removeFailed = Effect.gen(function* () {
          const operation = yield* container.deleteProjectsLocationsClusters({ name }).pipe(
            Effect.catchTag("NotFound", () => Effect.undefined),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
          if (operation !== undefined) {
            yield* waitForOperation(env.project, location, operation, {
              notFoundOk: true,
            });
          }
          yield* waitUntilGone(name);
        });
        const isInternal = (error: { _tag: string; code?: number }) =>
          error._tag === "GCP.OperationFailed" && error.code === 13;
        yield* create.pipe(
          Effect.tapError((error) => (isInternal(error) ? removeFailed : Effect.void)),
          Effect.retry({
            while: isInternal,
            times: 2,
            schedule: Schedule.spaced("30 seconds"),
          }),
        );
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new ClusterNotResolved({ resourceName: name });
      }

      let live = current;
      const status = live.status ?? "STATUS_UNSPECIFIED";
      if (status !== "RUNNING" && status !== "DEGRADED") {
        live = yield* waitUntilReady(name);
      }

      if (!autopilot && news.removeDefaultNodePool === true) {
        const removed = yield* ensureDefaultPoolRemoved(env.project, location, name);
        if (removed) live = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(live.resourceLabels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      if (labelsChanged) {
        const labeled = yield* container.setResourceLabelsProjectsLocationsClusters({
          name,
          body: {
            resourceLabels: desiredLabels,
            labelFingerprint: live.labelFingerprint,
          },
        });
        yield* waitForOperation(env.project, location, labeled);
        live = yield* waitUntilReady(name);
      }

      // GKE rejects a logging-only or monitoring-only change that would
      // implicitly flip the other service, so both are always sent together.
      const desiredLogging = news.loggingService ?? live.loggingService;
      const desiredMonitoring = news.monitoringService ?? live.monitoringService;
      if (
        (live.loggingService ?? "") !== (desiredLogging ?? "") ||
        (live.monitoringService ?? "") !== (desiredMonitoring ?? "")
      ) {
        const serviced = yield* container.updateProjectsLocationsClusters({
          name,
          body: {
            update: {
              desiredLoggingService: desiredLogging,
              desiredMonitoringService: desiredMonitoring,
            },
          },
        });
        yield* waitForOperation(env.project, location, serviced);
        live = yield* waitUntilReady(name);
      }

      const desiredChannel = normalizeChannel(news.releaseChannel);
      const observedChannel = normalizeChannel(live.releaseChannel?.channel);
      const desiredLocations = news.nodeLocations;
      const locationsChanged =
        desiredLocations !== undefined && !sameStrings(live.locations ?? [], desiredLocations);
      const channelChanged = desiredChannel.length > 0 && desiredChannel !== observedChannel;

      // GKE applies exactly one `desired*` field per update request.
      const applyUpdate = (update: container.ClusterUpdate) =>
        Effect.gen(function* () {
          const updated = yield* container.updateProjectsLocationsClusters({
            name,
            body: { update },
          });
          yield* waitForOperation(env.project, location, updated);
          return yield* waitUntilReady(name);
        });

      if (channelChanged) {
        live = yield* applyUpdate({
          desiredReleaseChannel: {
            channel: desiredChannel as container.ReleaseChannelChannelEnum,
          },
        });
      }
      if (locationsChanged) {
        live = yield* applyUpdate({ desiredLocations });
      }

      if (
        news.masterAuthorizedNetworksConfig !== undefined &&
        !matchesDesired(live.masterAuthorizedNetworksConfig, news.masterAuthorizedNetworksConfig)
      ) {
        live = yield* applyUpdate({
          desiredMasterAuthorizedNetworksConfig: news.masterAuthorizedNetworksConfig,
        });
      }

      const desiredPrivateEndpoint = news.privateClusterConfig?.enablePrivateEndpoint;
      if (
        desiredPrivateEndpoint !== undefined &&
        !matchesDesired(live.privateClusterConfig, {
          enablePrivateEndpoint: desiredPrivateEndpoint,
        })
      ) {
        live = yield* applyUpdate({
          desiredEnablePrivateEndpoint: desiredPrivateEndpoint,
        });
      }

      const desiredMasterGlobalAccess = news.privateClusterConfig?.masterGlobalAccessConfig;
      if (
        desiredMasterGlobalAccess !== undefined &&
        !matchesDesired(
          live.privateClusterConfig?.masterGlobalAccessConfig,
          desiredMasterGlobalAccess,
        )
      ) {
        live = yield* applyUpdate({
          desiredPrivateClusterConfig: {
            masterGlobalAccessConfig: desiredMasterGlobalAccess,
          },
        });
      }

      if (
        news.enableShieldedNodes !== undefined &&
        (live.shieldedNodes?.enabled === true) !== news.enableShieldedNodes
      ) {
        live = yield* applyUpdate({
          desiredShieldedNodes: { enabled: news.enableShieldedNodes },
        });
      }

      if (
        news.addonsConfig !== undefined &&
        !matchesDesired(live.addonsConfig, news.addonsConfig)
      ) {
        live = yield* applyUpdate({ desiredAddonsConfig: news.addonsConfig });
      }

      if (
        news.datapathProvider !== undefined &&
        // GKE omits the proto3 default, so an unset provider is LEGACY.
        (live.networkConfig?.datapathProvider ?? "LEGACY_DATAPATH") !== news.datapathProvider
      ) {
        live = yield* applyUpdate({
          desiredDatapathProvider:
            news.datapathProvider as container.ClusterUpdateDesiredDatapathProviderEnum,
        });
      }

      if (
        news.loggingConfig !== undefined &&
        !matchesDesired(live.loggingConfig, news.loggingConfig)
      ) {
        live = yield* applyUpdate({ desiredLoggingConfig: news.loggingConfig });
      }

      if (
        news.monitoringConfig !== undefined &&
        !matchesDesired(live.monitoringConfig, news.monitoringConfig)
      ) {
        live = yield* applyUpdate({ desiredMonitoringConfig: news.monitoringConfig });
      }

      if (
        news.costManagementConfig !== undefined &&
        !matchesDesired(live.costManagementConfig, news.costManagementConfig)
      ) {
        live = yield* applyUpdate({
          desiredCostManagementConfig: news.costManagementConfig,
        });
      }

      const observedPool = live.workloadIdentityConfig?.workloadPool ?? "";
      if (observedPool !== desiredPool) {
        const identified = yield* container.updateProjectsLocationsClusters({
          name,
          body: {
            update: {
              desiredWorkloadIdentityConfig: { workloadPool: desiredPool },
            },
          },
        });
        yield* waitForOperation(env.project, location, identified);
        live = yield* waitUntilReady(name);
      }

      const attrs = toAttrs(live, env.project, output?.kubernetesObjects ?? []);
      const kubernetesObjects = yield* reconcileObjects({
        transport: yield* getKubernetesTransport(attrs),
        previousObjects: output?.kubernetesObjects ?? [],
        desiredObjects,
      });
      return { ...attrs, kubernetesObjects };
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      if (olds.deletionProtection === true && force !== true) {
        return yield* new ClusterDeletionProtected({ resourceName: output.name });
      }
      if ((output.kubernetesObjects ?? []).length > 0) {
        yield* deleteObjects({
          transport: yield* getKubernetesTransport(output),
          objects: output.kubernetesObjects ?? [],
        });
      }
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(output.location);
      yield* waitUntilSettled(output.name);
      const operation = yield* container
        .deleteProjectsLocationsClusters({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.undefined),
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" ||
              (error._tag === "BadRequest" && /incompatible operation/i.test(error.message)),
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(env.project, location, operation, {
          notFoundOk: true,
        });
      }
      yield* waitUntilGone(output.name);
    }),
  });
