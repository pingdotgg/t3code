import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  OracleDatabaseNotResolved,
  collectPages,
  expandNetwork,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceNameOf,
  retryConflict,
  retryQuota,
  type TimeZone,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "cloudVmClusters";
const FALLBACK_ID = "vmcluster";

export type DataCollectionOptions = {
  /** Enable incident logs and traces. */
  incidentLogsEnabled?: boolean;
  /** Enable diagnostic collection. */
  diagnosticsEventsEnabled?: boolean;
  /** Enable health monitoring. */
  healthMonitoringEnabled?: boolean;
};

export type CloudVmClusterPropertiesInput = {
  /** License type. Required on create. */
  licenseType?: oracle.CloudVmClusterPropertiesLicenseTypeEnum | (string & {});
  /** Enabled CPU cores. Required on create. */
  cpuCoreCount?: number;
  /** OCPU count per VM. */
  ocpuCount?: number;
  /** Node count. */
  nodeCount?: number;
  /** Grid Infrastructure version. */
  giVersion?: string;
  /** OS image version. */
  systemVersion?: string;
  /** Memory in GB. */
  memorySizeGb?: number;
  /** Local storage per VM in GB. */
  dbNodeStorageSizeGb?: number;
  /** DATA disk group size in TB. */
  dataStorageSizeTb?: number;
  /** Hostname prefix. */
  hostnamePrefix?: string;
  /** SSH public keys. */
  sshPublicKeys?: string[];
  /** SCAN listener TCP port. */
  scanListenerPortTcp?: number;
  /** SCAN listener TLS port. */
  scanListenerPortTcpSsl?: number;
  /** Disk redundancy (`HIGH`, `NORMAL`). */
  diskRedundancy?:
    | oracle.CloudVmClusterPropertiesDiskRedundancyEnum
    | (string & {});
  /** Time zone. */
  timeZone?: TimeZone;
  /** OCI cluster name. */
  clusterName?: string;
  /** Use local backup. */
  localBackupEnabled?: boolean;
  /** Use sparse disk group. */
  sparseDiskgroupEnabled?: boolean;
  /** Diagnostics collection options. */
  diagnosticsDataCollectionOptions?: DataCollectionOptions;
  /** Database server OCIDs. */
  dbServerOcids?: string[];
};

export type CloudVmClusterProps = {
  /**
   * VM Cluster id. If omitted, a unique RFC1035 name is generated.
   * Immutable.
   */
  cloudVmClusterId?: string;
  /**
   * Region. Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Exadata Infrastructure
   * (`projects/{project}/locations/{region}/cloudExadataInfrastructures/{id}`).
   * Immutable.
   */
  exadataInfrastructure?: string;
  /**
   * Display name.
   */
  displayName?: string;
  /**
   * VPC network. Immutable. Required unless `odbSubnet` is set.
   */
  network?: string;
  /**
   * Cluster IP CIDR. Immutable.
   */
  cidr?: string;
  /**
   * Backup subnet CIDR. Immutable.
   */
  backupSubnetCidr?: string;
  /**
   * ODB Network. Immutable.
   */
  odbNetwork?: string;
  /**
   * ODB Subnet for IP allocation. Immutable.
   */
  odbSubnet?: string;
  /**
   * Backup ODB Subnet. Immutable.
   */
  backupOdbSubnet?: string;
  /**
   * Exascale storage vault. Immutable.
   */
  exascaleDbStorageVault?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * VM cluster properties.
   */
  properties?: CloudVmClusterPropertiesInput;
  /** License type. Convenience alias for `properties.licenseType`. */
  licenseType?: oracle.CloudVmClusterPropertiesLicenseTypeEnum | (string & {});
  /** CPU core count. Convenience alias for `properties.cpuCoreCount`. */
  cpuCoreCount?: number;
  /** Grid Infrastructure version. Convenience alias for `properties.giVersion`. */
  giVersion?: string;
  /** Hostname prefix. Convenience alias for `properties.hostnamePrefix`. */
  hostnamePrefix?: string;
  /** SSH public keys. Convenience alias for `properties.sshPublicKeys`. */
  sshPublicKeys?: string[];
};

export type CloudVmCluster = Resource<
  "GCP.OracleDatabase.CloudVmCluster",
  CloudVmClusterProps,
  {
    /** Full resource name. */
    name: string;
    /** VM Cluster id. */
    cloudVmClusterId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Exadata Infrastructure. */
    exadataInfrastructure: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** VPC network. */
    network: string | undefined;
    /** Cluster CIDR. */
    cidr: string | undefined;
    /** Backup subnet CIDR. */
    backupSubnetCidr: string | undefined;
    /** ODB Network. */
    odbNetwork: string | undefined;
    /** ODB Subnet. */
    odbSubnet: string | undefined;
    /** Backup ODB Subnet. */
    backupOdbSubnet: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** GCP Oracle zone. */
    gcpOracleZone: string | undefined;
    /** Lifecycle state. */
    state: string | undefined;
    /** License type. */
    licenseType: string | undefined;
    /** CPU cores. */
    cpuCoreCount: number | undefined;
    /** Hostname. */
    hostname: string | undefined;
    /** OCID. */
    ocid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle Exadata VM Cluster on Google Cloud.
 *
 * Changing `cloudVmClusterId`, `location`, `exadataInfrastructure`,
 * network identity (`network`/`cidr`/`odbSubnet`), or license type
 * replaces the cluster. There is no patch API in the distilled SDK, so
 * labels are applied at create.
 *
 * Delete sends `force=true` so child resources do not block teardown.
 *
 * ### Creating a VM Cluster
 * **Example:** Attach to Exadata Infrastructure
 * ```typescript
 * const cluster = yield* GCP.OracleDatabase.CloudVmCluster("Vms", {
 *   exadataInfrastructure: infra.name,
 *   network: "default",
 *   cidr: "10.10.0.0/24",
 *   backupSubnetCidr: "10.10.1.0/24",
 *   licenseType: "LICENSE_INCLUDED",
 *   cpuCoreCount: 4,
 *   giVersion: "19.0.0.0",
 *   hostnamePrefix: "exa",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const CloudVmCluster = Resource<CloudVmCluster>(
  "GCP.OracleDatabase.CloudVmCluster",
);

const mergedProperties = (
  news: CloudVmClusterProps,
): CloudVmClusterPropertiesInput => ({
  ...(news.properties ?? {}),
  licenseType: news.licenseType ?? news.properties?.licenseType,
  cpuCoreCount: news.cpuCoreCount ?? news.properties?.cpuCoreCount,
  giVersion: news.giVersion ?? news.properties?.giVersion,
  hostnamePrefix: news.hostnamePrefix ?? news.properties?.hostnamePrefix,
  sshPublicKeys: news.sshPublicKeys ?? news.properties?.sshPublicKeys,
});

const toCreateBody = (
  news: CloudVmClusterProps,
  desiredLabels: Record<string, string>,
  project: string,
): oracle.CloudVmCluster => {
  const props = mergedProperties(news);
  const properties: oracle.CloudVmClusterProperties = {};
  if (props.licenseType !== undefined)
    properties.licenseType = props.licenseType;
  if (props.cpuCoreCount !== undefined) {
    properties.cpuCoreCount = props.cpuCoreCount;
  }
  if (props.ocpuCount !== undefined) properties.ocpuCount = props.ocpuCount;
  if (props.nodeCount !== undefined) properties.nodeCount = props.nodeCount;
  if (props.giVersion !== undefined) properties.giVersion = props.giVersion;
  if (props.systemVersion !== undefined) {
    properties.systemVersion = props.systemVersion;
  }
  if (props.memorySizeGb !== undefined) {
    properties.memorySizeGb = props.memorySizeGb;
  }
  if (props.dbNodeStorageSizeGb !== undefined) {
    properties.dbNodeStorageSizeGb = props.dbNodeStorageSizeGb;
  }
  if (props.dataStorageSizeTb !== undefined) {
    properties.dataStorageSizeTb = props.dataStorageSizeTb;
  }
  if (props.hostnamePrefix !== undefined) {
    properties.hostnamePrefix = props.hostnamePrefix;
  }
  if (props.sshPublicKeys !== undefined) {
    properties.sshPublicKeys = props.sshPublicKeys;
  }
  if (props.scanListenerPortTcp !== undefined) {
    properties.scanListenerPortTcp = props.scanListenerPortTcp;
  }
  if (props.scanListenerPortTcpSsl !== undefined) {
    properties.scanListenerPortTcpSsl = props.scanListenerPortTcpSsl;
  }
  if (props.diskRedundancy !== undefined) {
    properties.diskRedundancy = props.diskRedundancy;
  }
  if (props.timeZone !== undefined) properties.timeZone = props.timeZone;
  if (props.clusterName !== undefined)
    properties.clusterName = props.clusterName;
  if (props.localBackupEnabled !== undefined) {
    properties.localBackupEnabled = props.localBackupEnabled;
  }
  if (props.sparseDiskgroupEnabled !== undefined) {
    properties.sparseDiskgroupEnabled = props.sparseDiskgroupEnabled;
  }
  if (props.diagnosticsDataCollectionOptions !== undefined) {
    properties.diagnosticsDataCollectionOptions =
      props.diagnosticsDataCollectionOptions;
  }
  if (props.dbServerOcids !== undefined) {
    properties.dbServerOcids = props.dbServerOcids;
  }
  const body: oracle.CloudVmCluster = {
    labels: desiredLabels,
    properties,
  };
  if (news.exadataInfrastructure !== undefined) {
    body.exadataInfrastructure = news.exadataInfrastructure;
  }
  if (news.displayName !== undefined) body.displayName = news.displayName;
  const network = expandNetwork(project, news.network);
  if (network !== undefined) body.network = network;
  if (news.cidr !== undefined) body.cidr = news.cidr;
  if (news.backupSubnetCidr !== undefined) {
    body.backupSubnetCidr = news.backupSubnetCidr;
  }
  if (news.odbNetwork !== undefined) body.odbNetwork = news.odbNetwork;
  if (news.odbSubnet !== undefined) body.odbSubnet = news.odbSubnet;
  if (news.backupOdbSubnet !== undefined) {
    body.backupOdbSubnet = news.backupOdbSubnet;
  }
  if (news.exascaleDbStorageVault !== undefined) {
    body.exascaleDbStorageVault = news.exascaleDbStorageVault;
  }
  return body;
};

const toAttrs = (cluster: oracle.CloudVmCluster, project: string) => {
  const name = cluster.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    cloudVmClusterId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    exadataInfrastructure: cluster.exadataInfrastructure,
    displayName: cluster.displayName,
    network: cluster.network,
    cidr: cluster.cidr,
    backupSubnetCidr: cluster.backupSubnetCidr,
    odbNetwork: cluster.odbNetwork,
    odbSubnet: cluster.odbSubnet,
    backupOdbSubnet: cluster.backupOdbSubnet,
    labels: userLabels(cluster.labels),
    gcpOracleZone: cluster.gcpOracleZone,
    state: cluster.properties?.state,
    licenseType: cluster.properties?.licenseType,
    cpuCoreCount: cluster.properties?.cpuCoreCount,
    hostname: cluster.properties?.hostname,
    ocid: cluster.properties?.ocid,
    createTime: cluster.createTime,
  };
};

const getByName = (name: string) =>
  retryQuota(oracle.getProjectsLocationsCloudVmClusters({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listClusters = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      oracle.listProjectsLocationsCloudVmClusters.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.cloudVmClusters,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    );
  return listAtLocation(project, region, collect).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );
};

export const CloudVmClusterProvider = () =>
  Provider.succeed(CloudVmCluster, {
    stables: [
      "name",
      "cloudVmClusterId",
      "project",
      "location",
      "createTime",
      "ocid",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousInfra =
        olds?.exadataInfrastructure ?? output?.exadataInfrastructure ?? "";
      const nextInfra = news.exadataInfrastructure ?? previousInfra;
      const previousNetwork = olds?.network ?? output?.network ?? "";
      const nextNetwork = news.network ?? previousNetwork;
      const previousOdb = olds?.odbSubnet ?? output?.odbSubnet ?? "";
      const nextOdb = news.odbSubnet ?? previousOdb;
      return replaceOnIdentity({
        previousId: olds?.cloudVmClusterId ?? output?.cloudVmClusterId,
        nextId:
          news.cloudVmClusterId ??
          olds?.cloudVmClusterId ??
          output?.cloudVmClusterId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra:
          nextInfra !== previousInfra ||
          nextNetwork !== previousNetwork ||
          nextOdb !== previousOdb,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const cloudVmClusterId = yield* toPhysicalId(
        id,
        olds?.cloudVmClusterId,
        output?.cloudVmClusterId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceNameOf(env.project, location, COLLECTION, cloudVmClusterId);
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
      const cloudVmClusterId = yield* toPhysicalId(
        id,
        news.cloudVmClusterId,
        output?.cloudVmClusterId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceNameOf(
        env.project,
        location,
        COLLECTION,
        cloudVmClusterId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsCloudVmClusters({
            parent: parentOf(env.project, location),
            cloudVmClusterId,
            body: toCreateBody(news, desiredLabels, env.project),
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
        (value) => value.properties?.state,
      );

      return toAttrs(ready, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* oracle
        .deleteProjectsLocationsCloudVmClusters({
          name: output.name,
          force: true,
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
