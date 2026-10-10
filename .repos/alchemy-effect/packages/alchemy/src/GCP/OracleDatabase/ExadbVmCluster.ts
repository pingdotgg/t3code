import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
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
  OracleDatabaseNotResolved,
  collectPages,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceNameOf,
  retryConflict,
  retryQuota,
  specifiedEquals,
  type TimeZone,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "exadbVmClusters";
const FALLBACK_ID = "exadbvm";

export type ExadbVmClusterStorageDetails = {
  /** Storage per node in GB. */
  sizeInGbsPerNode?: number;
};

export type DataCollectionOptionsCommon = {
  /** Enable incident logs. */
  isIncidentLogsEnabled?: boolean;
  /** Enable health monitoring. */
  isHealthMonitoringEnabled?: boolean;
  /** Enable diagnostics events. */
  isDiagnosticsEventsEnabled?: boolean;
};

export type ExadbVmClusterPropertiesInput = {
  /** OCI cluster name. Immutable. */
  clusterName?: string;
  /** Grid image id. Immutable. Required on create. */
  gridImageId?: string;
  /** License model. Immutable. */
  licenseModel?:
    | oracle.ExadbVmClusterPropertiesLicenseModelEnum
    | (string & {});
  /** VM file system storage. Immutable. Required on create. */
  vmFileSystemStorage?: ExadbVmClusterStorageDetails;
  /** Additional ECPUs per node. Immutable. */
  additionalEcpuCountPerNode?: number;
  /** Data collection options. Immutable. */
  dataCollectionOptions?: DataCollectionOptionsCommon;
  /** Shape attribute (`SMART_STORAGE`, `BLOCK_STORAGE`). Immutable. */
  shapeAttribute?:
    | oracle.ExadbVmClusterPropertiesShapeAttributeEnum
    | (string & {});
  /** Node/VM count. Mutable via patch. */
  nodeCount?: number;
  /** Enabled ECPUs per node. Immutable. */
  enabledEcpuCountPerNode?: number;
  /** SCAN listener TCP port. Immutable. */
  scanListenerPortTcp?: number;
  /** SSH public keys. Immutable. */
  sshPublicKeys?: string[];
  /** Time zone. Immutable. */
  timeZone?: TimeZone;
  /** Exascale storage vault. Immutable. */
  exascaleDbStorageVault?: string;
  /** Hostname prefix. Immutable. */
  hostnamePrefix?: string;
};

export type ExadbVmClusterProps = {
  /**
   * Exadb VM Cluster id. If omitted, a unique RFC1035 name is generated.
   * Immutable.
   */
  exadbVmClusterId?: string;
  /**
   * Region. Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Immutable.
   */
  displayName?: string;
  /**
   * Client ODB Subnet. Immutable.
   */
  odbSubnet?: string;
  /**
   * Backup ODB Subnet. Immutable.
   */
  backupOdbSubnet?: string;
  /**
   * ODB Network. Immutable.
   */
  odbNetwork?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Cluster properties.
   */
  properties?: ExadbVmClusterPropertiesInput;
  /** Node count. Convenience alias for `properties.nodeCount`. */
  nodeCount?: number;
  /** Grid image id. Convenience alias for `properties.gridImageId`. */
  gridImageId?: string;
  /** Hostname prefix. Convenience alias for `properties.hostnamePrefix`. */
  hostnamePrefix?: string;
  /** SSH public keys. Convenience alias for `properties.sshPublicKeys`. */
  sshPublicKeys?: string[];
  /** Exascale vault. Convenience alias. */
  exascaleDbStorageVault?: string;
  /** Enabled ECPUs per node. Convenience alias. */
  enabledEcpuCountPerNode?: number;
};

export type ExadbVmCluster = Resource<
  "GCP.OracleDatabase.ExadbVmCluster",
  ExadbVmClusterProps,
  {
    /** Full resource name. */
    name: string;
    /** Cluster id. */
    exadbVmClusterId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Client ODB Subnet. */
    odbSubnet: string | undefined;
    /** Backup ODB Subnet. */
    backupOdbSubnet: string | undefined;
    /** ODB Network. */
    odbNetwork: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** GCP Oracle zone. */
    gcpOracleZone: string | undefined;
    /** Entitlement id. */
    entitlementId: string | undefined;
    /** Lifecycle state. */
    lifecycleState: string | undefined;
    /** Node count. */
    nodeCount: number | undefined;
    /** Hostname. */
    hostname: string | undefined;
    /** Grid Infrastructure version. */
    giVersion: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle Exascale VM Cluster on Google Cloud.
 *
 * Changing `exadbVmClusterId`, `location`, ODB identity, `gridImageId`,
 * or `exascaleDbStorageVault` replaces the cluster. Labels and
 * `nodeCount` patch in place (adding VMs). Removing VMs uses a separate
 * API and is not modeled here.
 *
 * ### Creating an Exadb VM Cluster
 * **Example:** Generated name
 * ```typescript
 * const cluster = yield* GCP.OracleDatabase.ExadbVmCluster("ExaVm", {
 *   displayName: "exavm",
 *   odbSubnet: subnet.name,
 *   backupOdbSubnet: backupSubnet.name,
 *   gridImageId: "19.0.0.0",
 *   hostnamePrefix: "exavm",
 *   sshPublicKeys: [publicKey],
 *   exascaleDbStorageVault: vault.name,
 *   enabledEcpuCountPerNode: 8,
 *   nodeCount: 2,
 *   properties: {
 *     vmFileSystemStorage: { sizeInGbsPerNode: 180 },
 *     shapeAttribute: "SMART_STORAGE",
 *   },
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const ExadbVmCluster = Resource<ExadbVmCluster>(
  "GCP.OracleDatabase.ExadbVmCluster",
);

const mergedProperties = (
  news: ExadbVmClusterProps,
): ExadbVmClusterPropertiesInput => ({
  ...(news.properties ?? {}),
  nodeCount: news.nodeCount ?? news.properties?.nodeCount,
  gridImageId: news.gridImageId ?? news.properties?.gridImageId,
  hostnamePrefix: news.hostnamePrefix ?? news.properties?.hostnamePrefix,
  sshPublicKeys: news.sshPublicKeys ?? news.properties?.sshPublicKeys,
  exascaleDbStorageVault:
    news.exascaleDbStorageVault ?? news.properties?.exascaleDbStorageVault,
  enabledEcpuCountPerNode:
    news.enabledEcpuCountPerNode ?? news.properties?.enabledEcpuCountPerNode,
});

const toCreateBody = (
  news: ExadbVmClusterProps,
  desiredLabels: Record<string, string>,
): oracle.ExadbVmCluster => {
  const props = mergedProperties(news);
  const properties: oracle.ExadbVmClusterProperties = {};
  if (props.clusterName !== undefined)
    properties.clusterName = props.clusterName;
  if (props.gridImageId !== undefined)
    properties.gridImageId = props.gridImageId;
  if (props.licenseModel !== undefined) {
    properties.licenseModel = props.licenseModel;
  }
  if (props.vmFileSystemStorage !== undefined) {
    properties.vmFileSystemStorage = props.vmFileSystemStorage;
  }
  if (props.additionalEcpuCountPerNode !== undefined) {
    properties.additionalEcpuCountPerNode = props.additionalEcpuCountPerNode;
  }
  if (props.dataCollectionOptions !== undefined) {
    properties.dataCollectionOptions = props.dataCollectionOptions;
  }
  if (props.shapeAttribute !== undefined) {
    properties.shapeAttribute = props.shapeAttribute;
  }
  if (props.nodeCount !== undefined) properties.nodeCount = props.nodeCount;
  if (props.enabledEcpuCountPerNode !== undefined) {
    properties.enabledEcpuCountPerNode = props.enabledEcpuCountPerNode;
  }
  if (props.scanListenerPortTcp !== undefined) {
    properties.scanListenerPortTcp = props.scanListenerPortTcp;
  }
  if (props.sshPublicKeys !== undefined) {
    properties.sshPublicKeys = props.sshPublicKeys;
  }
  if (props.timeZone !== undefined) properties.timeZone = props.timeZone;
  if (props.exascaleDbStorageVault !== undefined) {
    properties.exascaleDbStorageVault = props.exascaleDbStorageVault;
  }
  if (props.hostnamePrefix !== undefined) {
    properties.hostnamePrefix = props.hostnamePrefix;
  }
  const body: oracle.ExadbVmCluster = {
    labels: desiredLabels,
    properties,
  };
  if (news.displayName !== undefined) body.displayName = news.displayName;
  if (news.odbSubnet !== undefined) body.odbSubnet = news.odbSubnet;
  if (news.backupOdbSubnet !== undefined) {
    body.backupOdbSubnet = news.backupOdbSubnet;
  }
  if (news.odbNetwork !== undefined) body.odbNetwork = news.odbNetwork;
  return body;
};

const toAttrs = (cluster: oracle.ExadbVmCluster, project: string) => {
  const name = cluster.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    exadbVmClusterId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: cluster.displayName,
    odbSubnet: cluster.odbSubnet,
    backupOdbSubnet: cluster.backupOdbSubnet,
    odbNetwork: cluster.odbNetwork,
    labels: userLabels(cluster.labels),
    gcpOracleZone: cluster.gcpOracleZone,
    entitlementId: cluster.entitlementId,
    lifecycleState: cluster.properties?.lifecycleState,
    nodeCount: cluster.properties?.nodeCount,
    hostname: cluster.properties?.hostname,
    giVersion: cluster.properties?.giVersion,
    createTime: cluster.createTime,
  };
};

const getByName = (name: string) =>
  retryQuota(oracle.getProjectsLocationsExadbVmClusters({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listClusters = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      oracle.listProjectsLocationsExadbVmClusters.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.exadbVmClusters,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    );
  return listAtLocation(project, region, collect).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );
};

export const ExadbVmClusterProvider = () =>
  Provider.succeed(ExadbVmCluster, {
    stables: ["name", "exadbVmClusterId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousOdb = olds?.odbSubnet ?? output?.odbSubnet ?? "";
      const nextOdb = news.odbSubnet ?? previousOdb;
      const previousBackup =
        olds?.backupOdbSubnet ?? output?.backupOdbSubnet ?? "";
      const nextBackup = news.backupOdbSubnet ?? previousBackup;
      const previousVault =
        olds?.exascaleDbStorageVault ??
        olds?.properties?.exascaleDbStorageVault ??
        "";
      const nextVault =
        news.exascaleDbStorageVault ??
        news.properties?.exascaleDbStorageVault ??
        previousVault;
      return replaceOnIdentity({
        previousId: olds?.exadbVmClusterId ?? output?.exadbVmClusterId,
        nextId:
          news.exadbVmClusterId ??
          olds?.exadbVmClusterId ??
          output?.exadbVmClusterId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra:
          nextOdb !== previousOdb ||
          nextBackup !== previousBackup ||
          nextVault !== previousVault,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const exadbVmClusterId = yield* toPhysicalId(
        id,
        olds?.exadbVmClusterId,
        output?.exadbVmClusterId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceNameOf(env.project, location, COLLECTION, exadbVmClusterId);
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
        const items = yield* listClusters(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const exadbVmClusterId = yield* toPhysicalId(
        id,
        news.exadbVmClusterId,
        output?.exadbVmClusterId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceNameOf(
        env.project,
        location,
        COLLECTION,
        exadbVmClusterId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsExadbVmClusters({
            parent: parentOf(env.project, location),
            exadbVmClusterId,
            body: toCreateBody(news, desiredLabels),
          })
          .pipe(
            retryQuota,
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new OracleDatabaseNotResolved({ name });
      }

      const ready = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (value) => value.properties?.lifecycleState,
      );

      const props = mergedProperties(news);
      const observedLabels = tagRecord(ready.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const nodeCountChanged =
        props.nodeCount !== undefined &&
        !specifiedEquals(props.nodeCount, ready.properties?.nodeCount);

      if (labelsChanged || nodeCountChanged) {
        const mask = [
          labelsChanged ? "labels" : undefined,
          nodeCountChanged ? "properties.node_count" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation = yield* retryQuota(
          oracle.patchProjectsLocationsExadbVmClusters({
            name: ready.name ?? name,
            updateMask: mask.join(","),
            body: {
              name: ready.name ?? name,
              labels: desiredLabels,
              properties: {
                nodeCount: props.nodeCount,
              },
            },
          }),
        );
        yield* waitForOperation(operation);
        return toAttrs(
          yield* waitUntilExists(
            getByName(ready.name ?? name),
            ready.name ?? name,
          ),
          env.project,
        );
      }

      return toAttrs(ready, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* oracle
        .deleteProjectsLocationsExadbVmClusters({
          name: output.name,
        })
        .pipe(
          retryConflict,
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
