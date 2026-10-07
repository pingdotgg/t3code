import * as gkeonprem from "@distilled.cloud/gcp/gkeonprem_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  ResourceNotResolved,
  collectPages,
  createInternalLabels,
  desiredAnnotations,
  differs,
  encodeOwnership,
  fieldMask,
  isOwned,
  listAtLocation,
  membershipName,
  normalizeLocation,
  parentOf,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  rfc1035,
  sameText,
  textState,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";
import type {
  BareMetalClusterOperationsConfig,
  BareMetalClusterUpgradePolicy,
  BareMetalControlPlaneConfig,
  BareMetalLoadBalancerConfig,
  BareMetalMaintenanceConfig,
  BareMetalNetworkConfig,
  BareMetalNodeAccessConfig,
  BareMetalOsEnvironmentConfig,
  BareMetalProxyConfig,
  BareMetalSecurityConfig,
  BareMetalStorageConfig,
  BareMetalWorkloadNodeConfig,
  BinaryAuthorization,
} from "./types.ts";

const COLLECTION = "bareMetalClusters";

export type BareMetalClusterProps = {
  /**
   * Cluster id (the `{bareMetalCluster}` segment). If omitted, a unique
   * RFC1035 name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the cluster.
   */
  bareMetalClusterId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the cluster. `US-CENTRAL1` is accepted and normalized.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Admin cluster Hub membership this user cluster belongs to. Full name
   * `projects/{project}/locations/global/memberships/{membership}` or a
   * membership id. Immutable — changing it replaces the cluster.
   */
  adminClusterMembership: string;
  /**
   * Anthos clusters on bare metal version for the user cluster.
   */
  bareMetalVersion: string;
  /**
   * Control plane configuration, including the control plane node pool.
   */
  controlPlane: BareMetalControlPlaneConfig;
  /**
   * Local PV storage configuration.
   */
  storage: BareMetalStorageConfig;
  /**
   * Cluster network configuration (island-mode CIDRs, SR-IOV, …).
   */
  networkConfig: BareMetalNetworkConfig;
  /**
   * Load balancer configuration (MetalLB, BGP, or manual).
   */
  loadBalancer: BareMetalLoadBalancerConfig;
  /**
   * Human-readable description. Clusters have no GCP labels field, so
   * Alchemy stamps ownership into annotations and a `[alchemy …]`
   * description prefix and strips both from attributes.
   */
  description?: string;
  /**
   * Security / bootstrap RBAC configuration.
   */
  securityConfig?: BareMetalSecurityConfig;
  /**
   * HTTP(S) proxy used by cluster machines.
   */
  proxy?: BareMetalProxyConfig;
  /**
   * Cluster upgrade policy.
   */
  upgradePolicy?: BareMetalClusterUpgradePolicy;
  /**
   * SSH login user for node machines.
   */
  nodeAccessConfig?: BareMetalNodeAccessConfig;
  /**
   * CIDRs whose nodes are placed into maintenance.
   */
  maintenanceConfig?: BareMetalMaintenanceConfig;
  /**
   * Binary Authorization evaluation mode.
   */
  binaryAuthorization?: BinaryAuthorization;
  /**
   * Workload node defaults (max pods, container runtime).
   */
  nodeConfig?: BareMetalWorkloadNodeConfig;
  /**
   * Observability: application logs and metrics.
   */
  clusterOperations?: BareMetalClusterOperationsConfig;
  /**
   * OS environment settings (package repo).
   */
  osEnvironmentConfig?: BareMetalOsEnvironmentConfig;
  /**
   * Kubernetes-style annotations. Alchemy ownership keys are merged in.
   */
  annotations?: Record<string, string>;
  /**
   * User labels stored as annotations (keys sanitized like GCP labels).
   * Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BareMetalCluster = Resource<
  "GCP.GKEOnPrem.BareMetalCluster",
  BareMetalClusterProps,
  {
    /** Full resource name. */
    name: string;
    /** Cluster id (last path segment). */
    bareMetalClusterId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Admin cluster Hub membership. */
    adminClusterMembership: string | undefined;
    /** Output-only admin cluster resource name. */
    adminClusterName: string | undefined;
    /** Anthos on-prem version. */
    bareMetalVersion: string | undefined;
    /** Control plane configuration. */
    controlPlane: gkeonprem.BareMetalControlPlaneConfig | undefined;
    /** Storage configuration. */
    storage: gkeonprem.BareMetalStorageConfig | undefined;
    /** Network configuration. */
    networkConfig: gkeonprem.BareMetalNetworkConfig | undefined;
    /** Load balancer configuration. */
    loadBalancer: gkeonprem.BareMetalLoadBalancerConfig | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Security configuration. */
    securityConfig: gkeonprem.BareMetalSecurityConfig | undefined;
    /** Proxy configuration. */
    proxy: gkeonprem.BareMetalProxyConfig | undefined;
    /** Upgrade policy. */
    upgradePolicy: gkeonprem.BareMetalClusterUpgradePolicy | undefined;
    /** Node access configuration. */
    nodeAccessConfig: gkeonprem.BareMetalNodeAccessConfig | undefined;
    /** Maintenance configuration. */
    maintenanceConfig: gkeonprem.BareMetalMaintenanceConfig | undefined;
    /** Binary Authorization configuration. */
    binaryAuthorization: gkeonprem.BinaryAuthorization | undefined;
    /** Workload node defaults. */
    nodeConfig: gkeonprem.BareMetalWorkloadNodeConfig | undefined;
    /** Cluster operations configuration. */
    clusterOperations: gkeonprem.BareMetalClusterOperationsConfig | undefined;
    /** OS environment configuration. */
    osEnvironmentConfig: gkeonprem.BareMetalOsEnvironmentConfig | undefined;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership keys stripped). */
    labels: Record<string, string>;
    /** Output-only Kubernetes API endpoint. */
    endpoint: string | undefined;
    /** Output-only Fleet membership. */
    fleet: gkeonprem.Fleet | undefined;
    /** Local CR name on the admin cluster. */
    localName: string | undefined;
    /** Local namespace on the admin cluster. */
    localNamespace: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** Whether a change is in flight. */
    reconciling: boolean | undefined;
    /** Controller error message. */
    errorMessage: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 deletion timestamp. */
    deleteTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Anthos on bare metal user cluster registered with the GKE On-Prem
 * API. Creating a cluster requires a connected admin cluster (Hub
 * membership) and on-prem hardware.
 *
 * Clusters have no GCP labels field, so Alchemy stamps ownership into
 * annotations and a `[alchemy …]` description prefix for `list` / nuke.
 * Cluster id, location, and admin membership are identity — changing
 * them replaces the cluster. Other fields update in place.
 *
 * ### Creating a Bare Metal Cluster
 * **Example:** User cluster with MetalLB
 * ```typescript
 * const cluster = yield* GCP.GKEOnPrem.BareMetalCluster("Workload", {
 *   adminClusterMembership:
 *     "projects/my-project/locations/global/memberships/admin",
 *   bareMetalVersion: "1.28.0-gke.1",
 *   controlPlane: {
 *     controlPlaneNodePoolConfig: {
 *       nodePoolConfig: {
 *         nodeConfigs: [{ nodeIp: "10.200.0.2" }],
 *       },
 *     },
 *   },
 *   storage: {
 *     lvpShareConfig: {
 *       lvpConfig: { path: "/mnt/localpv-share", storageClass: "local-shared" },
 *     },
 *     lvpNodeMountsConfig: {
 *       path: "/mnt/localpv-disk",
 *       storageClass: "local-disks",
 *     },
 *   },
 *   networkConfig: {
 *     islandModeCidr: {
 *       serviceAddressCidrBlocks: ["10.96.0.0/12"],
 *       podAddressCidrBlocks: ["192.168.0.0/16"],
 *     },
 *   },
 *   loadBalancer: {
 *     vipConfig: { controlPlaneVip: "10.200.0.8", ingressVip: "10.200.0.9" },
 *     metalLbConfig: {
 *       addressPools: [{ pool: "pool-1", addresses: ["10.200.0.10-10.200.0.20"] }],
 *     },
 *   },
 *   description: "app user cluster",
 * });
 * ```
 *
 * ### Updating a Bare Metal Cluster
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description and version
 * ```typescript
 * const cluster = yield* GCP.GKEOnPrem.BareMetalCluster("Workload", {
 *   adminClusterMembership:
 *     "projects/my-project/locations/global/memberships/admin",
 *   bareMetalVersion: "1.29.0-gke.1",
 *   controlPlane: {
 *     controlPlaneNodePoolConfig: {
 *       nodePoolConfig: {
 *         nodeConfigs: [{ nodeIp: "10.200.0.2" }],
 *       },
 *     },
 *   },
 *   storage: {
 *     lvpShareConfig: {
 *       lvpConfig: { path: "/mnt/localpv-share", storageClass: "local-shared" },
 *     },
 *     lvpNodeMountsConfig: {
 *       path: "/mnt/localpv-disk",
 *       storageClass: "local-disks",
 *     },
 *   },
 *   networkConfig: {
 *     islandModeCidr: {
 *       serviceAddressCidrBlocks: ["10.96.0.0/12"],
 *       podAddressCidrBlocks: ["192.168.0.0/16"],
 *     },
 *   },
 *   loadBalancer: {
 *     vipConfig: { controlPlaneVip: "10.200.0.8", ingressVip: "10.200.0.9" },
 *     metalLbConfig: {
 *       addressPools: [{ pool: "pool-1", addresses: ["10.200.0.10-10.200.0.20"] }],
 *     },
 *   },
 *   description: "app user cluster v2",
 * });
 * ```
 *
 * @resource
 * @category GKEOnPrem
 */
export const BareMetalCluster = Resource<BareMetalCluster>(
  "GCP.GKEOnPrem.BareMetalCluster",
);

const resourceName = (
  project: string,
  location: string,
  bareMetalClusterId: string,
) => `${parentOf(project, location)}/${COLLECTION}/${bareMetalClusterId}`;

const toAttrs = (
  item: gkeonprem.BareMetalCluster,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(item.description);
  const annotations = userLabels(item.annotations);
  return {
    name,
    bareMetalClusterId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    adminClusterMembership: item.adminClusterMembership,
    adminClusterName: item.adminClusterName,
    bareMetalVersion: item.bareMetalVersion,
    controlPlane: item.controlPlane,
    storage: item.storage,
    networkConfig: item.networkConfig,
    loadBalancer: item.loadBalancer,
    description: ownership.text,
    securityConfig: item.securityConfig,
    proxy: item.proxy,
    upgradePolicy: item.upgradePolicy,
    nodeAccessConfig: item.nodeAccessConfig,
    maintenanceConfig: item.maintenanceConfig,
    binaryAuthorization: item.binaryAuthorization,
    nodeConfig: item.nodeConfig,
    clusterOperations: item.clusterOperations,
    osEnvironmentConfig: item.osEnvironmentConfig,
    annotations,
    labels: annotations,
    endpoint: item.endpoint,
    fleet: item.fleet,
    localName: item.localName,
    localNamespace: item.localNamespace,
    state: textState(item.state),
    uid: item.uid,
    reconciling: item.reconciling,
    errorMessage: item.status?.errorMessage,
    createTime: item.createTime,
    updateTime: item.updateTime,
    deleteTime: item.deleteTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  gkeonprem
    .getProjectsLocationsBareMetalClusters({ name, view: "FULL" })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    collectPages(
      gkeonprem.listProjectsLocationsBareMetalClusters.pages({
        parent,
        pageSize: 1000,
        view: "FULL",
      }),
      (page): readonly gkeonprem.BareMetalCluster[] | undefined =>
        page.bareMetalClusters,
    ),
  ).pipe(
    Effect.map((items) =>
      items.filter((item: gkeonprem.BareMetalCluster) =>
        isOwned(item.annotations, item.description),
      ),
    ),
  );

const toBody = (
  news: BareMetalClusterProps,
  annotations: Record<string, string>,
  description: string,
  membership: string,
): gkeonprem.BareMetalCluster => ({
  adminClusterMembership: membership,
  bareMetalVersion: news.bareMetalVersion,
  controlPlane: news.controlPlane,
  storage: news.storage,
  networkConfig: news.networkConfig,
  loadBalancer: news.loadBalancer,
  description,
  securityConfig: news.securityConfig,
  proxy: news.proxy,
  upgradePolicy: news.upgradePolicy,
  nodeAccessConfig: news.nodeAccessConfig,
  maintenanceConfig: news.maintenanceConfig,
  binaryAuthorization: news.binaryAuthorization,
  nodeConfig: news.nodeConfig,
  clusterOperations: news.clusterOperations,
  osEnvironmentConfig: news.osEnvironmentConfig,
  annotations,
});

export const BareMetalClusterProvider = () =>
  Provider.succeed(BareMetalCluster, {
    stables: [
      "name",
      "bareMetalClusterId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousMembership =
        olds?.adminClusterMembership ?? output?.adminClusterMembership;
      const nextMembership = news.adminClusterMembership;
      return replaceOnIdentity({
        previousId: olds?.bareMetalClusterId ?? output?.bareMetalClusterId,
        nextId: news.bareMetalClusterId
          ? rfc1035(news.bareMetalClusterId, "baremetalcluster")
          : (olds?.bareMetalClusterId ?? output?.bareMetalClusterId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          previousMembership !== undefined &&
          nextMembership !== undefined &&
          previousMembership !== nextMembership &&
          !previousMembership.endsWith(`/${nextMembership}`),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const bareMetalClusterId = yield* toPhysicalId(
        id,
        olds?.bareMetalClusterId,
        output?.bareMetalClusterId,
        "baremetalcluster",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, bareMetalClusterId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const fromDescription = parseOwnership(existing.description).labels;
      const owned =
        (yield* hasAlchemyLabels(id, tagRecord(existing.annotations))) ||
        (yield* hasAlchemyLabels(id, fromDescription));
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item: gkeonprem.BareMetalCluster) =>
          toAttrs(item, env.project, env.region),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const bareMetalClusterId = yield* toPhysicalId(
        id,
        news.bareMetalClusterId,
        output?.bareMetalClusterId,
        "baremetalcluster",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, bareMetalClusterId);
      const ownership = yield* createInternalLabels(id);
      const annotations = desiredAnnotations(
        ownership,
        news.labels,
        news.annotations,
      );
      const description = encodeOwnership(ownership, news.description);
      const membership = membershipName(
        news.adminClusterMembership,
        env.project,
      );
      const body = toBody(news, annotations, description, membership);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* gkeonprem
          .createProjectsLocationsBareMetalClusters({
            parent: parentOf(env.project, location),
            bareMetalClusterId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const mask = fieldMask([
        differs(current.annotations, annotations) && "annotations",
        !sameText(parseOwnership(current.description).text, news.description) &&
          "description",
        differs(current.bareMetalVersion, news.bareMetalVersion) &&
          "bareMetalVersion",
        differs(current.controlPlane, news.controlPlane) && "controlPlane",
        differs(current.storage, news.storage) && "storage",
        differs(current.networkConfig, news.networkConfig) && "networkConfig",
        differs(current.loadBalancer, news.loadBalancer) && "loadBalancer",
        differs(current.securityConfig, news.securityConfig) &&
          "securityConfig",
        differs(current.proxy, news.proxy) && "proxy",
        differs(current.upgradePolicy, news.upgradePolicy) && "upgradePolicy",
        differs(current.nodeAccessConfig, news.nodeAccessConfig) &&
          "nodeAccessConfig",
        differs(current.maintenanceConfig, news.maintenanceConfig) &&
          "maintenanceConfig",
        differs(current.binaryAuthorization, news.binaryAuthorization) &&
          "binaryAuthorization",
        differs(current.nodeConfig, news.nodeConfig) && "nodeConfig",
        differs(current.clusterOperations, news.clusterOperations) &&
          "clusterOperations",
        differs(current.osEnvironmentConfig, news.osEnvironmentConfig) &&
          "osEnvironmentConfig",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* gkeonprem.patchProjectsLocationsBareMetalClusters({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              ...body,
              etag: current.etag,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }
      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* gkeonprem
        .deleteProjectsLocationsBareMetalClusters({
          name: output.name,
          allowMissing: true,
          force: true,
          etag: output.etag,
        })
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
