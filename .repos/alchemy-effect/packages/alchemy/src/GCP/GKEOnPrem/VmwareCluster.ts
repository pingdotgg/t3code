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
  VMWARE_NAME_LENGTH,
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
  Authorization,
  BinaryAuthorization,
  Fleet,
  VmwareAAGConfig,
  VmwareAutoRepairConfig,
  VmwareClusterUpgradePolicy,
  VmwareControlPlaneNodeConfig,
  VmwareDataplaneV2Config,
  VmwareLoadBalancerConfig,
  VmwareNetworkConfig,
  VmwareStorageConfig,
  VmwareVCenterConfig,
} from "./types.ts";

const COLLECTION = "vmwareClusters";

export type VmwareClusterProps = {
  /**
   * Cluster id (the `{vmwareCluster}` segment). If omitted, a unique
   * RFC1123 name is generated. Max 40 characters. Immutable — changing
   * it replaces the cluster.
   */
  vmwareClusterId?: string;
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
   * Anthos clusters on VMware version for the user cluster.
   */
  onPremVersion: string;
  /**
   * Control plane node configuration (CPU, memory, replica count).
   */
  controlPlaneNode?: VmwareControlPlaneNodeConfig;
  /**
   * Cluster network configuration (pod/service CIDRs, DHCP or static IP).
   */
  networkConfig?: VmwareNetworkConfig;
  /**
   * Load balancer configuration (MetalLB, F5, Seesaw, or manual).
   */
  loadBalancer?: VmwareLoadBalancerConfig;
  /**
   * vSphere CSI storage configuration.
   */
  storage?: VmwareStorageConfig;
  /**
   * vCenter settings. Inherited from the admin cluster when omitted.
   */
  vcenter?: VmwareVCenterConfig;
  /**
   * Dataplane V2 configuration.
   */
  dataplaneV2?: VmwareDataplaneV2Config;
  /**
   * Anti-affinity group (spread nodes across three hosts).
   */
  antiAffinityGroups?: VmwareAAGConfig;
  /**
   * Bootstrap RBAC users granted cluster-admin.
   */
  authorization?: Authorization;
  /**
   * Auto-repair configuration.
   */
  autoRepairConfig?: VmwareAutoRepairConfig;
  /**
   * Cluster upgrade policy.
   */
  upgradePolicy?: VmwareClusterUpgradePolicy;
  /**
   * Binary Authorization evaluation mode.
   */
  binaryAuthorization?: BinaryAuthorization;
  /**
   * Enable control plane V2.
   * @default false
   */
  enableControlPlaneV2?: boolean;
  /**
   * Enable advanced cluster.
   */
  enableAdvancedCluster?: boolean;
  /**
   * Disable bundled ingress.
   */
  disableBundledIngress?: boolean;
  /**
   * Enable VM tracking.
   */
  vmTrackingEnabled?: boolean;
  /**
   * Human-readable description. Clusters have no GCP labels field, so
   * Alchemy stamps ownership into annotations and a `[alchemy …]`
   * description prefix and strips both from attributes.
   */
  description?: string;
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

export type VmwareCluster = Resource<
  "GCP.GKEOnPrem.VmwareCluster",
  VmwareClusterProps,
  {
    /** Full resource name. */
    name: string;
    /** Cluster id (last path segment). */
    vmwareClusterId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Admin cluster Hub membership. */
    adminClusterMembership: string | undefined;
    /** Output-only admin cluster resource name. */
    adminClusterName: string | undefined;
    /** Anthos on-prem version. */
    onPremVersion: string | undefined;
    /** Control plane node configuration. */
    controlPlaneNode: VmwareControlPlaneNodeConfig | undefined;
    /** Network configuration. */
    networkConfig: VmwareNetworkConfig | undefined;
    /** Load balancer configuration. */
    loadBalancer: VmwareLoadBalancerConfig | undefined;
    /** Storage configuration. */
    storage: VmwareStorageConfig | undefined;
    /** vCenter configuration. */
    vcenter: VmwareVCenterConfig | undefined;
    /** Dataplane V2 configuration. */
    dataplaneV2: VmwareDataplaneV2Config | undefined;
    /** Anti-affinity configuration. */
    antiAffinityGroups: VmwareAAGConfig | undefined;
    /** Bootstrap RBAC. */
    authorization: Authorization | undefined;
    /** Auto-repair configuration. */
    autoRepairConfig: VmwareAutoRepairConfig | undefined;
    /** Upgrade policy. */
    upgradePolicy: VmwareClusterUpgradePolicy | undefined;
    /** Binary Authorization configuration. */
    binaryAuthorization: BinaryAuthorization | undefined;
    /** Control plane V2 enabled. */
    enableControlPlaneV2: boolean | undefined;
    /** Advanced cluster enabled. */
    enableAdvancedCluster: boolean | undefined;
    /** Bundled ingress disabled. */
    disableBundledIngress: boolean | undefined;
    /** VM tracking enabled. */
    vmTrackingEnabled: boolean | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership keys stripped). */
    labels: Record<string, string>;
    /** Output-only Kubernetes API endpoint. */
    endpoint: string | undefined;
    /** Output-only Fleet membership. */
    fleet: Fleet | undefined;
    /** Local CR name on the admin cluster. */
    localName: string | undefined;
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
 * An Anthos on VMware user cluster registered with the GKE On-Prem API.
 * Creating a cluster requires a connected admin cluster (Hub membership)
 * and vSphere infrastructure.
 *
 * Clusters have no GCP labels field, so Alchemy stamps ownership into
 * annotations and a `[alchemy …]` description prefix for `list` / nuke.
 * Cluster id, location, and admin membership are identity — changing
 * them replaces the cluster. Other fields update in place.
 *
 * ### Creating a VMware Cluster
 * **Example:** User cluster with MetalLB
 * ```typescript
 * const cluster = yield* GCP.GKEOnPrem.VmwareCluster("Workload", {
 *   adminClusterMembership:
 *     "projects/my-project/locations/global/memberships/admin",
 *   onPremVersion: "1.28.0-gke.1",
 *   controlPlaneNode: { cpus: "4", memory: "8192", replicas: "1" },
 *   networkConfig: {
 *     serviceAddressCidrBlocks: ["10.96.0.0/12"],
 *     podAddressCidrBlocks: ["192.168.0.0/16"],
 *     dhcpIpConfig: { enabled: true },
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
 * ### Updating a VMware Cluster
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description and version
 * ```typescript
 * const cluster = yield* GCP.GKEOnPrem.VmwareCluster("Workload", {
 *   adminClusterMembership:
 *     "projects/my-project/locations/global/memberships/admin",
 *   onPremVersion: "1.29.0-gke.1",
 *   controlPlaneNode: { cpus: "4", memory: "8192", replicas: "1" },
 *   networkConfig: {
 *     serviceAddressCidrBlocks: ["10.96.0.0/12"],
 *     podAddressCidrBlocks: ["192.168.0.0/16"],
 *     dhcpIpConfig: { enabled: true },
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
export const VmwareCluster = Resource<VmwareCluster>(
  "GCP.GKEOnPrem.VmwareCluster",
);

const resourceName = (
  project: string,
  location: string,
  vmwareClusterId: string,
) => `${parentOf(project, location)}/${COLLECTION}/${vmwareClusterId}`;

const toAttrs = (
  item: gkeonprem.VmwareCluster,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(item.description);
  const annotations = userLabels(item.annotations);
  return {
    name,
    vmwareClusterId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    adminClusterMembership: item.adminClusterMembership,
    adminClusterName: item.adminClusterName,
    onPremVersion: item.onPremVersion,
    controlPlaneNode: item.controlPlaneNode,
    networkConfig: item.networkConfig,
    loadBalancer: item.loadBalancer,
    storage: item.storage,
    vcenter: item.vcenter,
    dataplaneV2: item.dataplaneV2,
    antiAffinityGroups: item.antiAffinityGroups,
    authorization: item.authorization,
    autoRepairConfig: item.autoRepairConfig,
    upgradePolicy: item.upgradePolicy,
    binaryAuthorization: item.binaryAuthorization,
    enableControlPlaneV2: item.enableControlPlaneV2,
    enableAdvancedCluster: item.enableAdvancedCluster,
    disableBundledIngress: item.disableBundledIngress,
    vmTrackingEnabled: item.vmTrackingEnabled,
    description: ownership.text,
    annotations,
    labels: annotations,
    endpoint: item.endpoint,
    fleet: item.fleet,
    localName: item.localName,
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
    .getProjectsLocationsVmwareClusters({ name, view: "FULL" })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    collectPages(
      gkeonprem.listProjectsLocationsVmwareClusters.pages({
        parent,
        pageSize: 1000,
        view: "FULL",
      }),
      (page): readonly gkeonprem.VmwareCluster[] | undefined =>
        page.vmwareClusters,
    ),
  ).pipe(
    Effect.map((items) =>
      items.filter((item: gkeonprem.VmwareCluster) =>
        isOwned(item.annotations, item.description),
      ),
    ),
  );

const toBody = (
  news: VmwareClusterProps,
  annotations: Record<string, string>,
  description: string,
  membership: string,
): gkeonprem.VmwareCluster => ({
  adminClusterMembership: membership,
  onPremVersion: news.onPremVersion,
  controlPlaneNode: news.controlPlaneNode,
  networkConfig: news.networkConfig,
  loadBalancer: news.loadBalancer,
  storage: news.storage,
  vcenter: news.vcenter,
  dataplaneV2: news.dataplaneV2,
  antiAffinityGroups: news.antiAffinityGroups,
  authorization: news.authorization,
  autoRepairConfig: news.autoRepairConfig,
  upgradePolicy: news.upgradePolicy,
  binaryAuthorization: news.binaryAuthorization,
  enableControlPlaneV2: news.enableControlPlaneV2,
  enableAdvancedCluster: news.enableAdvancedCluster,
  disableBundledIngress: news.disableBundledIngress,
  vmTrackingEnabled: news.vmTrackingEnabled,
  description,
  annotations,
});

export const VmwareClusterProvider = () =>
  Provider.succeed(VmwareCluster, {
    stables: [
      "name",
      "vmwareClusterId",
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
        previousId: olds?.vmwareClusterId ?? output?.vmwareClusterId,
        nextId: news.vmwareClusterId
          ? rfc1035(news.vmwareClusterId, "vmwarecluster", VMWARE_NAME_LENGTH)
          : (olds?.vmwareClusterId ?? output?.vmwareClusterId),
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
      const vmwareClusterId = yield* toPhysicalId(
        id,
        olds?.vmwareClusterId,
        output?.vmwareClusterId,
        "vmwarecluster",
        VMWARE_NAME_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, vmwareClusterId);
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
        return items.map((item: gkeonprem.VmwareCluster) =>
          toAttrs(item, env.project, env.region),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const vmwareClusterId = yield* toPhysicalId(
        id,
        news.vmwareClusterId,
        output?.vmwareClusterId,
        "vmwarecluster",
        VMWARE_NAME_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, vmwareClusterId);
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
          .createProjectsLocationsVmwareClusters({
            parent: parentOf(env.project, location),
            vmwareClusterId,
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
        differs(current.onPremVersion, news.onPremVersion) && "onPremVersion",
        differs(current.controlPlaneNode, news.controlPlaneNode) &&
          "controlPlaneNode",
        differs(current.networkConfig, news.networkConfig) && "networkConfig",
        differs(current.loadBalancer, news.loadBalancer) && "loadBalancer",
        differs(current.storage, news.storage) && "storage",
        differs(current.vcenter, news.vcenter) && "vcenter",
        differs(current.dataplaneV2, news.dataplaneV2) && "dataplaneV2",
        differs(current.antiAffinityGroups, news.antiAffinityGroups) &&
          "antiAffinityGroups",
        differs(current.authorization, news.authorization) && "authorization",
        differs(current.autoRepairConfig, news.autoRepairConfig) &&
          "autoRepairConfig",
        differs(current.upgradePolicy, news.upgradePolicy) && "upgradePolicy",
        differs(current.binaryAuthorization, news.binaryAuthorization) &&
          "binaryAuthorization",
        news.enableControlPlaneV2 !== undefined &&
          news.enableControlPlaneV2 !== current.enableControlPlaneV2 &&
          "enableControlPlaneV2",
        news.enableAdvancedCluster !== undefined &&
          news.enableAdvancedCluster !== current.enableAdvancedCluster &&
          "enableAdvancedCluster",
        news.disableBundledIngress !== undefined &&
          news.disableBundledIngress !== current.disableBundledIngress &&
          "disableBundledIngress",
        news.vmTrackingEnabled !== undefined &&
          news.vmTrackingEnabled !== current.vmTrackingEnabled &&
          "vmTrackingEnabled",
      ]);

      if (mask.length > 0) {
        const operation = yield* gkeonprem.patchProjectsLocationsVmwareClusters(
          {
            name: current.name ?? name,
            updateMask: mask,
            body: {
              ...body,
              etag: current.etag,
            },
          },
        );
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
        .deleteProjectsLocationsVmwareClusters({
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
