import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_ZONE,
  VmwareengineNotResolved,
  changedFields,
  collectPages,
  createInternalLabels,
  expandName,
  hasOwnershipMarker,
  listAcrossLocations,
  locationFromName,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  rfc1035,
  sameJson,
  toPhysicalId,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
  waitUntilReady,
} from "./internal.ts";
import type { NodeTypeConfig, StretchedClusterConfig } from "./PrivateCloud.ts";

const COLLECTION = "clusters";
const PARENT_COLLECTION = "privateClouds";
const DEFAULT_NODE_TYPE = "standard-72";
const DEFAULT_NODE_COUNT = 3;

export type Thresholds = {
  /** Utilization percent that triggers scale-out. */
  scaleOut?: number;
  /** Utilization percent that triggers scale-in. */
  scaleIn?: number;
};

export type AutoscalingPolicy = {
  /** Canonical node type id this policy scales. */
  nodeTypeId?: string;
  /** Storage utilization thresholds. */
  storageThresholds?: Thresholds;
  /** CPU utilization thresholds. */
  cpuThresholds?: Thresholds;
  /** Granted-memory utilization thresholds. */
  grantedMemoryThresholds?: Thresholds;
  /** Consumed-memory utilization thresholds. */
  consumedMemoryThresholds?: Thresholds;
  /** Nodes added per scale-out. Must be even for stretched clusters. */
  scaleOutSize?: number;
};

export type AutoscalingSettings = {
  /** Minimum nodes of any type. */
  minClusterNodeCount?: number;
  /** Cool-down between autoscale operations (duration string). */
  coolDownPeriod?: string;
  /** Map of policy id to autoscaling policy. */
  autoscalingPolicies?: Record<string, AutoscalingPolicy | undefined>;
  /** Maximum nodes of any type. */
  maxClusterNodeCount?: number;
};

export type DatastoreNetwork = {
  /** Output-only network peering used to reach the file share. */
  networkPeering?: string;
  /** NFS connections from each ESXi host (`1`–`4`). */
  connectionCount?: number;
  /** Subnet resource name. */
  subnet?: string;
  /** VMKernel adapter MTU. */
  mtu?: number;
};

export type DatastoreMountConfig = {
  /** Output-only file share name. */
  fileShare?: string;
  /** NFS protocol. Default `NFS_V3`. */
  nfsVersion?: vmwareengine.DatastoreMountConfigNfsVersionEnum | (string & {});
  /** Datastore resource name to mount. */
  datastore?: string;
  /** Access mode. Default `READ_WRITE`. */
  accessMode?: vmwareengine.DatastoreMountConfigAccessModeEnum | (string & {});
  /** Network configuration for the mount. */
  datastoreNetwork?: DatastoreNetwork;
  /** Output-only NFS server addresses. */
  servers?: string[];
};

export type PrivateCloudsClusterProps = {
  /**
   * Parent PrivateCloud resource name
   * (`projects/{project}/locations/{location}/privateClouds/{privateCloud}`)
   * or the cloud id. Immutable — changing it replaces the cluster.
   */
  privateCloud: string;
  /**
   * Cluster id (the `{cluster}` segment of
   * `.../privateClouds/{privateCloud}/clusters/{cluster}`). If omitted, a
   * unique RFC1035 name is generated. Immutable.
   */
  clusterId?: string;
  /**
   * Location of the parent private cloud. Inferred from `privateCloud`
   * when that value is a full resource name. Immutable.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Map of node type id to config. Keys are canonical node type ids.
   * @default { "standard-72": { nodeCount: 3 } }
   */
  nodeTypeConfigs?: Record<string, NodeTypeConfig | undefined>;
  /**
   * Autoscaling applied to this cluster.
   */
  autoscalingSettings?: AutoscalingSettings;
  /**
   * Stretched-cluster zones. Required for clusters on a `STRETCHED`
   * private cloud. Immutable.
   */
  stretchedClusterConfig?: StretchedClusterConfig;
};

export type PrivateCloudsCluster = Resource<
  "GCP.VMwareEngine.PrivateCloudsCluster",
  PrivateCloudsClusterProps,
  {
    /** Full resource name. */
    name: string;
    /** Cluster id (last path segment). */
    clusterId: string;
    /** Parent PrivateCloud resource name. */
    privateCloud: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Node type configuration currently applied. */
    nodeTypeConfigs: Record<string, NodeTypeConfig | undefined> | undefined;
    /** Autoscaling configuration currently applied. */
    autoscalingSettings: AutoscalingSettings | undefined;
    /** Stretched-cluster configuration. */
    stretchedClusterConfig: StretchedClusterConfig | undefined;
    /** Mounted datastore configuration. */
    datastoreMountConfig: DatastoreMountConfig[];
    /** Whether this is the management cluster. */
    management: boolean;
    /** Server-reported state. */
    state: string | undefined;
    /** System-generated unique identifier. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A workload cluster in a VMware Engine private cloud. The management
 * cluster is created with the private cloud and cannot be deleted
 * independently.
 *
 * Clusters have no labels or description field, so Alchemy treats
 * clusters whose parent private cloud carries the `[alchemy …]`
 * ownership marker as owned for `list` / nuke. Changing the parent
 * cloud, cluster id, location, or stretched config replaces the
 * cluster. Node counts and autoscaling update in place.
 *
 * ### Creating a PrivateCloudsCluster
 * **Example:** Three-node workload cluster
 * ```typescript
 * const cluster = yield* GCP.VMwareEngine.PrivateCloudsCluster("Work", {
 *   privateCloud: cloud.name,
 *   nodeTypeConfigs: {
 *     "standard-72": { nodeCount: 3 },
 *   },
 * });
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const PrivateCloudsCluster = Resource<PrivateCloudsCluster>(
  "GCP.VMwareEngine.PrivateCloudsCluster",
);

const parentCloudName = (
  project: string,
  location: string,
  privateCloud: string,
) => expandName(privateCloud, project, location, PARENT_COLLECTION);

const resourceNameOf = (parent: string, clusterId: string) =>
  `${parent}/${COLLECTION}/${clusterId}`;

const nodeTypeConfigsOf = (
  value: vmwareengine.NodeTypeConfigMap | undefined,
): Record<string, NodeTypeConfig | undefined> | undefined => {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, config]) => [
      key,
      config === undefined
        ? undefined
        : {
            customCoreCount: config.customCoreCount,
            nodeCount: config.nodeCount,
          },
    ]),
  );
};

const thresholdsOf = (
  value: vmwareengine.Thresholds | Thresholds | undefined,
): Thresholds | undefined => {
  if (value === undefined) return undefined;
  return { scaleOut: value.scaleOut, scaleIn: value.scaleIn };
};

const autoscalingPolicyOf = (
  value: vmwareengine.AutoscalingPolicy | AutoscalingPolicy | undefined,
): AutoscalingPolicy | undefined => {
  if (value === undefined) return undefined;
  return {
    nodeTypeId: value.nodeTypeId,
    storageThresholds: thresholdsOf(value.storageThresholds),
    cpuThresholds: thresholdsOf(value.cpuThresholds),
    grantedMemoryThresholds: thresholdsOf(value.grantedMemoryThresholds),
    consumedMemoryThresholds: thresholdsOf(value.consumedMemoryThresholds),
    scaleOutSize: value.scaleOutSize,
  };
};

const autoscalingOf = (
  value: vmwareengine.AutoscalingSettings | AutoscalingSettings | undefined,
): AutoscalingSettings | undefined => {
  if (value === undefined) return undefined;
  const policies = value.autoscalingPolicies
    ? Object.fromEntries(
        Object.entries(value.autoscalingPolicies).map(([key, policy]) => [
          key,
          autoscalingPolicyOf(policy),
        ]),
      )
    : undefined;
  return {
    minClusterNodeCount: value.minClusterNodeCount,
    coolDownPeriod: value.coolDownPeriod,
    autoscalingPolicies: policies,
    maxClusterNodeCount: value.maxClusterNodeCount,
  };
};

const stretchedOf = (
  value:
    | vmwareengine.StretchedClusterConfig
    | StretchedClusterConfig
    | undefined,
): StretchedClusterConfig | undefined => {
  if (value === undefined) return undefined;
  return {
    preferredLocation: value.preferredLocation,
    secondaryLocation: value.secondaryLocation,
  };
};

const mountsOf = (
  values: vmwareengine.DatastoreMountConfigList | undefined,
): DatastoreMountConfig[] =>
  (values ?? []).map((mount) => ({
    fileShare: mount.fileShare,
    nfsVersion: mount.nfsVersion,
    datastore: mount.datastore,
    accessMode: mount.accessMode,
    datastoreNetwork:
      mount.datastoreNetwork === undefined
        ? undefined
        : {
            networkPeering: mount.datastoreNetwork.networkPeering,
            connectionCount: mount.datastoreNetwork.connectionCount,
            subnet: mount.datastoreNetwork.subnet,
            mtu: mount.datastoreNetwork.mtu,
          },
    servers: mount.servers,
  }));

const toAttrs = (item: vmwareengine.Cluster, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  return {
    name,
    clusterId: parsed.id,
    privateCloud: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    nodeTypeConfigs: nodeTypeConfigsOf(item.nodeTypeConfigs),
    autoscalingSettings: autoscalingOf(item.autoscalingSettings),
    stretchedClusterConfig: stretchedOf(item.stretchedClusterConfig),
    datastoreMountConfig: mountsOf(item.datastoreMountConfig),
    management: item.management === true,
    state: item.state,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  vmwareengine
    .getProjectsLocationsPrivateCloudsClusters({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getParentCloud = (name: string) =>
  vmwareengine
    .getProjectsLocationsPrivateClouds({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const defaultNodeTypeConfigs = (
  value: Record<string, NodeTypeConfig | undefined> | undefined,
) =>
  value ?? {
    [DEFAULT_NODE_TYPE]: { nodeCount: DEFAULT_NODE_COUNT },
  };

export const PrivateCloudsClusterProvider = () =>
  Provider.succeed(PrivateCloudsCluster, {
    stables: [
      "name",
      "clusterId",
      "privateCloud",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      return replaceOnIdentity({
        previousId: olds?.clusterId ?? output?.clusterId,
        nextId: news.clusterId
          ? rfc1035(news.clusterId, "cluster")
          : (olds?.clusterId ?? output?.clusterId),
        previousLocation,
        nextLocation: normalizeLocation(
          news.location ??
            locationFromName(news.privateCloud, previousLocation),
          DEFAULT_ZONE,
        ),
        previousParent: olds?.privateCloud ?? output?.privateCloud,
        nextParent: news.privateCloud,
        extra: !sameJson(
          stretchedOf(news.stretchedClusterConfig),
          stretchedOf(
            olds?.stretchedClusterConfig ?? output?.stretchedClusterConfig,
          ),
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          (olds?.privateCloud
            ? locationFromName(olds.privateCloud, DEFAULT_ZONE)
            : undefined),
        DEFAULT_ZONE,
      );
      const parent = parentCloudName(
        env.project,
        location,
        olds?.privateCloud ?? output?.privateCloud ?? "",
      );
      const clusterId = yield* toPhysicalId(
        id,
        olds?.clusterId,
        output?.clusterId,
        "cluster",
      );
      const name = output?.name ?? resourceNameOf(parent, clusterId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      if (output?.name === (existing.name ?? name)) return attrs;
      const parentCloud = yield* getParentCloud(attrs.privateCloud);
      return hasOwnershipMarker(parentCloud?.description)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const clouds = yield* listAcrossLocations(
          env.project,
          env.region,
          (parent) =>
            collectPages(
              vmwareengine.listProjectsLocationsPrivateClouds.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.privateClouds,
            ),
        );
        const ownedClouds = clouds.filter((cloud) =>
          hasOwnershipMarker(cloud.description),
        );
        const nested = yield* Effect.forEach(
          ownedClouds.filter((cloud) => (cloud.name ?? "").length > 0),
          (cloud) =>
            collectPages(
              vmwareengine.listProjectsLocationsPrivateCloudsClusters.pages({
                parent: cloud.name ?? "",
                pageSize: 1000,
              }),
              (page) => page.clusters,
            ),
          { concurrency: 4 },
        );
        return nested
          .flat()
          .filter((item) => item.management !== true)
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromName(news.privateCloud, DEFAULT_ZONE),
        DEFAULT_ZONE,
      );
      const parent = parentCloudName(env.project, location, news.privateCloud);
      const clusterId = yield* toPhysicalId(
        id,
        news.clusterId,
        output?.clusterId,
        "cluster",
      );
      const name = resourceNameOf(parent, clusterId);
      yield* createInternalLabels(id);
      const nodeTypeConfigs = defaultNodeTypeConfigs(news.nodeTypeConfigs);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsPrivateCloudsClusters({
            parent,
            clusterId,
            body: {
              nodeTypeConfigs,
              autoscalingSettings: news.autoscalingSettings,
              stretchedClusterConfig: news.stretchedClusterConfig,
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

      if (current === undefined) {
        return yield* new VmwareengineNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const nodesChanged = !sameJson(
        nodeTypeConfigsOf(current.nodeTypeConfigs),
        nodeTypeConfigs,
      );
      const autoscalingChanged = !sameJson(
        autoscalingOf(current.autoscalingSettings),
        autoscalingOf(news.autoscalingSettings),
      );
      const updateMask = changedFields([
        ["nodeTypeConfigs", nodesChanged],
        ["autoscalingSettings", autoscalingChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* vmwareengine.patchProjectsLocationsPrivateCloudsClusters({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              nodeTypeConfigs,
              autoscalingSettings: news.autoscalingSettings,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.management) return;
      const operation = yield* vmwareengine
        .deleteProjectsLocationsPrivateCloudsClusters({ name: output.name })
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
