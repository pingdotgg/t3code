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
  type CustomerContact,
  expandNetwork,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceNameOf,
  retryQuota,
  specifiedEquals,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
  retryConflict,
  waitUntilReady,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "autonomousDatabases";
const FALLBACK_ID = "adb";
const DEFAULT_LICENSE: oracle.AutonomousDatabasePropertiesLicenseTypeEnum =
  "LICENSE_INCLUDED";
const DEFAULT_WORKLOAD: oracle.AutonomousDatabasePropertiesDbWorkloadEnum =
  "OLTP";

export type EncryptionKey = {
  /** Key provider (`GOOGLE_MANAGED` or `ORACLE_MANAGED`). */
  provider?: oracle.EncryptionKeyProviderEnum | (string & {});
  /**
   * KMS key
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   */
  kmsKeyId?: string;
};

export type SourceConfig = {
  /** Primary Autonomous Database used to create a peer. */
  autonomousDatabase?: string;
  /** Replicate automatic backups when creating Data Guard. */
  automaticBackupsReplicationEnabled?: boolean;
};

export type AutonomousDatabasePropertiesInput = {
  /** License type. Immutable. */
  licenseType?:
    | oracle.AutonomousDatabasePropertiesLicenseTypeEnum
    | (string & {});
  /** Workload type (`OLTP`, `DW`, `AJD`, `APEX`). Immutable. */
  dbWorkload?:
    | oracle.AutonomousDatabasePropertiesDbWorkloadEnum
    | (string & {});
  /** Database edition. Immutable. */
  dbEdition?: oracle.AutonomousDatabasePropertiesDbEditionEnum | (string & {});
  /** Oracle Database version. Immutable. */
  dbVersion?: string;
  /** CPU cores. */
  cpuCoreCount?: number;
  /** Compute count (ECPU). */
  computeCount?: number;
  /** Data storage in GB. */
  dataStorageSizeGb?: number;
  /** Data storage in TB. */
  dataStorageSizeTb?: number;
  /** Enable compute auto scaling. */
  isAutoScalingEnabled?: boolean;
  /** Enable storage auto scaling. */
  isStorageAutoScalingEnabled?: boolean;
  /** Require mTLS. Immutable. */
  mtlsConnectionRequired?: boolean;
  /** Backup retention in days (1-60). Immutable. */
  backupRetentionPeriodDays?: number;
  /** Character set. Immutable. */
  characterSet?: string;
  /** National character set. Immutable. */
  nCharacterSet?: string;
  /** Maintenance schedule (`EARLY`, `REGULAR`). Immutable. */
  maintenanceScheduleType?:
    | oracle.AutonomousDatabasePropertiesMaintenanceScheduleTypeEnum
    | (string & {});
  /** Allowlisted IP addresses. Immutable. */
  allowlistedIps?: string[];
  /** Customer contacts. Immutable. */
  customerContacts?: CustomerContact[];
  /** Encryption key. Updating appends a history entry. */
  encryptionKey?: EncryptionKey;
  /** Enable in-region Data Guard. */
  localDataGuardEnabled?: boolean;
  /** Private endpoint label. Immutable. */
  privateEndpointLabel?: string;
  /** Private endpoint IP. Immutable. */
  privateEndpointIp?: string;
  /** Maximum Data Guard failover data-loss limit, in seconds. */
  localAdgAutoFailoverMaxDataLossLimitDuration?: number;
};

export type AutonomousDatabaseProps = {
  /**
   * Autonomous Database id (the `{autonomous_database}` segment of
   * `projects/{project}/locations/{location}/autonomousDatabases/{autonomous_database}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the database.
   */
  autonomousDatabaseId?: string;
  /**
   * Region (`us-central1`, `us-east4`, …). Immutable — changing it
   * replaces the database. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Oracle database name (1-30 alphanumeric, unique in the project).
   * Immutable.
   */
  database?: string;
  /**
   * Display name. Immutable.
   */
  displayName?: string;
  /**
   * VPC network (`projects/{project}/global/networks/{network}` or a
   * bare network id). Immutable. Required unless `odbSubnet` is set.
   */
  network?: string;
  /**
   * Subnet CIDR for the database. Immutable. Required unless
   * `odbSubnet` is set.
   */
  cidr?: string;
  /**
   * ODB Network
   * (`projects/{project}/locations/{location}/odbNetworks/{odb_network}`).
   * Immutable.
   */
  odbNetwork?: string;
  /**
   * ODB Subnet
   * (`projects/{project}/locations/{location}/odbNetworks/{odb_network}/odbSubnets/{odb_subnet}`).
   * Immutable.
   */
  odbSubnet?: string;
  /**
   * ADMIN user password. Create-only. Mutually exclusive with
   * `adminPasswordSecretVersion`.
   */
  adminPassword?: string;
  /**
   * Secret Manager version holding the ADMIN password
   * (`projects/{project}/secrets/{secret}/versions/{version}`).
   * Create-only.
   */
  adminPasswordSecretVersion?: string;
  /**
   * Source Autonomous Database when creating a Data Guard peer.
   * Immutable.
   */
  sourceConfig?: SourceConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Database properties. Flattened aliases (`licenseType`,
   * `dbWorkload`, …) are also accepted on the resource and win over
   * this nested object when both are set.
   */
  properties?: AutonomousDatabasePropertiesInput;
  /** License type. Immutable. Convenience alias for `properties.licenseType`. */
  licenseType?:
    | oracle.AutonomousDatabasePropertiesLicenseTypeEnum
    | (string & {});
  /** Workload type. Immutable. Convenience alias for `properties.dbWorkload`. */
  dbWorkload?:
    | oracle.AutonomousDatabasePropertiesDbWorkloadEnum
    | (string & {});
  /** CPU cores. Convenience alias for `properties.cpuCoreCount`. */
  cpuCoreCount?: number;
  /** Compute count. Convenience alias for `properties.computeCount`. */
  computeCount?: number;
  /** Data storage in GB. Convenience alias for `properties.dataStorageSizeGb`. */
  dataStorageSizeGb?: number;
  /** Data storage in TB. Convenience alias for `properties.dataStorageSizeTb`. */
  dataStorageSizeTb?: number;
  /** Compute auto scaling. Convenience alias for `properties.isAutoScalingEnabled`. */
  isAutoScalingEnabled?: boolean;
  /** Storage auto scaling. Convenience alias for `properties.isStorageAutoScalingEnabled`. */
  isStorageAutoScalingEnabled?: boolean;
  /** Oracle Database version. Immutable. */
  dbVersion?: string;
  /** Database edition. Immutable. */
  dbEdition?: oracle.AutonomousDatabasePropertiesDbEditionEnum | (string & {});
};

export type AutonomousDatabase = Resource<
  "GCP.OracleDatabase.AutonomousDatabase",
  AutonomousDatabaseProps,
  {
    /** Full resource name. */
    name: string;
    /** Autonomous Database id (last path segment). */
    autonomousDatabaseId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Oracle database name. */
    database: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** VPC network. */
    network: string | undefined;
    /** Subnet CIDR. */
    cidr: string | undefined;
    /** ODB Network. */
    odbNetwork: string | undefined;
    /** ODB Subnet. */
    odbSubnet: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Entitlement id. */
    entitlementId: string | undefined;
    /** Lifecycle state. */
    state: string | undefined;
    /** License type. */
    licenseType: string | undefined;
    /** Workload type. */
    dbWorkload: string | undefined;
    /** Database edition. */
    dbEdition: string | undefined;
    /** Oracle Database version. */
    dbVersion: string | undefined;
    /** CPU cores. */
    cpuCoreCount: number | undefined;
    /** Compute count. */
    computeCount: number | undefined;
    /** Data storage in GB. */
    dataStorageSizeGb: number | undefined;
    /** Data storage in TB. */
    dataStorageSizeTb: number | undefined;
    /** Compute auto scaling. */
    isAutoScalingEnabled: boolean | undefined;
    /** Storage auto scaling. */
    isStorageAutoScalingEnabled: boolean | undefined;
    /** OCID. */
    ocid: string | undefined;
    /** Connection strings currently reported. */
    connectionStrings: oracle.AutonomousDatabaseConnectionStrings | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle Autonomous Database on Google Cloud.
 *
 * Changing `autonomousDatabaseId`, `location`, `database`, `network`,
 * `cidr`, `odbNetwork`, `odbSubnet`, `sourceConfig`, `licenseType`,
 * `dbWorkload`, `dbEdition`, or `dbVersion` replaces the database.
 * Labels, compute, storage, and auto-scaling patch in place.
 *
 * Provisioning typically takes tens of minutes and requires an Oracle
 * Database@Google Cloud entitlement.
 *
 * ### Creating an Autonomous Database
 * **Example:** Generated name on a VPC
 * ```typescript
 * const db = yield* GCP.OracleDatabase.AutonomousDatabase("AppDb", {
 *   network: "default",
 *   cidr: "10.10.0.0/24",
 *   adminPassword: "AlchemyTest1!",
 *   licenseType: "LICENSE_INCLUDED",
 *   dbWorkload: "OLTP",
 *   cpuCoreCount: 2,
 *   dataStorageSizeGb: 20,
 * });
 * ```
 *
 * **Example:** Explicit id, ODB subnet, and labels
 * ```typescript
 * const db = yield* GCP.OracleDatabase.AutonomousDatabase("AppDb", {
 *   autonomousDatabaseId: "app-db",
 *   odbSubnet: subnet.name,
 *   adminPassword: "AlchemyTest1!",
 *   displayName: "app-db",
 *   labels: { env: "prod" },
 *   properties: {
 *     licenseType: "LICENSE_INCLUDED",
 *     dbWorkload: "OLTP",
 *     computeCount: 2,
 *     dataStorageSizeGb: 20,
 *   },
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const AutonomousDatabase = Resource<AutonomousDatabase>(
  "GCP.OracleDatabase.AutonomousDatabase",
);

const mergedProperties = (
  news: AutonomousDatabaseProps,
): AutonomousDatabasePropertiesInput => ({
  ...(news.properties ?? {}),
  licenseType: news.licenseType ?? news.properties?.licenseType,
  dbWorkload: news.dbWorkload ?? news.properties?.dbWorkload,
  cpuCoreCount: news.cpuCoreCount ?? news.properties?.cpuCoreCount,
  computeCount: news.computeCount ?? news.properties?.computeCount,
  dataStorageSizeGb:
    news.dataStorageSizeGb ?? news.properties?.dataStorageSizeGb,
  dataStorageSizeTb:
    news.dataStorageSizeTb ?? news.properties?.dataStorageSizeTb,
  isAutoScalingEnabled:
    news.isAutoScalingEnabled ?? news.properties?.isAutoScalingEnabled,
  isStorageAutoScalingEnabled:
    news.isStorageAutoScalingEnabled ??
    news.properties?.isStorageAutoScalingEnabled,
  dbVersion: news.dbVersion ?? news.properties?.dbVersion,
  dbEdition: news.dbEdition ?? news.properties?.dbEdition,
});

const toCreateProperties = (
  news: AutonomousDatabaseProps,
): oracle.AutonomousDatabaseProperties => {
  const props = mergedProperties(news);
  const body: oracle.AutonomousDatabaseProperties = {
    licenseType: props.licenseType ?? DEFAULT_LICENSE,
    dbWorkload: props.dbWorkload ?? DEFAULT_WORKLOAD,
  };
  if (props.dbEdition !== undefined) body.dbEdition = props.dbEdition;
  if (props.dbVersion !== undefined) body.dbVersion = props.dbVersion;
  if (props.cpuCoreCount !== undefined) body.cpuCoreCount = props.cpuCoreCount;
  if (props.computeCount !== undefined) body.computeCount = props.computeCount;
  if (props.dataStorageSizeGb !== undefined) {
    body.dataStorageSizeGb = props.dataStorageSizeGb;
  }
  if (props.dataStorageSizeTb !== undefined) {
    body.dataStorageSizeTb = props.dataStorageSizeTb;
  }
  if (props.isAutoScalingEnabled !== undefined) {
    body.isAutoScalingEnabled = props.isAutoScalingEnabled;
  }
  if (props.isStorageAutoScalingEnabled !== undefined) {
    body.isStorageAutoScalingEnabled = props.isStorageAutoScalingEnabled;
  }
  if (props.mtlsConnectionRequired !== undefined) {
    body.mtlsConnectionRequired = props.mtlsConnectionRequired;
  }
  if (props.backupRetentionPeriodDays !== undefined) {
    body.backupRetentionPeriodDays = props.backupRetentionPeriodDays;
  }
  if (props.characterSet !== undefined) body.characterSet = props.characterSet;
  if (props.nCharacterSet !== undefined) {
    body.nCharacterSet = props.nCharacterSet;
  }
  if (props.maintenanceScheduleType !== undefined) {
    body.maintenanceScheduleType = props.maintenanceScheduleType;
  }
  if (props.allowlistedIps !== undefined) {
    body.allowlistedIps = props.allowlistedIps;
  }
  if (props.customerContacts !== undefined) {
    body.customerContacts = props.customerContacts;
  }
  if (props.encryptionKey !== undefined) {
    body.encryptionKey = props.encryptionKey;
  }
  if (props.localDataGuardEnabled !== undefined) {
    body.localDataGuardEnabled = props.localDataGuardEnabled;
  }
  if (props.privateEndpointLabel !== undefined) {
    body.privateEndpointLabel = props.privateEndpointLabel;
  }
  if (props.privateEndpointIp !== undefined) {
    body.privateEndpointIp = props.privateEndpointIp;
  }
  if (props.localAdgAutoFailoverMaxDataLossLimitDuration !== undefined) {
    body.localAdgAutoFailoverMaxDataLossLimitDuration =
      props.localAdgAutoFailoverMaxDataLossLimitDuration;
  }
  return body;
};

const toCreateBody = (
  news: AutonomousDatabaseProps,
  desiredLabels: Record<string, string>,
  project: string,
): oracle.AutonomousDatabase => {
  const body: oracle.AutonomousDatabase = {
    labels: desiredLabels,
    properties: toCreateProperties(news),
  };
  if (news.database !== undefined) body.database = news.database;
  if (news.displayName !== undefined) body.displayName = news.displayName;
  const network = expandNetwork(project, news.network);
  if (network !== undefined) body.network = network;
  if (news.cidr !== undefined) body.cidr = news.cidr;
  if (news.odbNetwork !== undefined) body.odbNetwork = news.odbNetwork;
  if (news.odbSubnet !== undefined) body.odbSubnet = news.odbSubnet;
  if (news.adminPassword !== undefined) body.adminPassword = news.adminPassword;
  if (news.adminPasswordSecretVersion !== undefined) {
    body.adminPasswordSecretVersion = news.adminPasswordSecretVersion;
  }
  if (news.sourceConfig !== undefined) body.sourceConfig = news.sourceConfig;
  return body;
};

const toAttrs = (database: oracle.AutonomousDatabase, project: string) => {
  const name = database.name ?? "";
  const parsed = parseName(name, COLLECTION);
  const properties = database.properties;
  return {
    name,
    autonomousDatabaseId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    database: database.database,
    displayName: database.displayName,
    network: database.network,
    cidr: database.cidr,
    odbNetwork: database.odbNetwork,
    odbSubnet: database.odbSubnet,
    labels: userLabels(database.labels),
    entitlementId: database.entitlementId,
    state: properties?.state,
    licenseType: properties?.licenseType,
    dbWorkload: properties?.dbWorkload,
    dbEdition: properties?.dbEdition,
    dbVersion: properties?.dbVersion,
    cpuCoreCount: properties?.cpuCoreCount,
    computeCount: properties?.computeCount,
    dataStorageSizeGb: properties?.dataStorageSizeGb,
    dataStorageSizeTb: properties?.dataStorageSizeTb,
    isAutoScalingEnabled: properties?.isAutoScalingEnabled,
    isStorageAutoScalingEnabled: properties?.isStorageAutoScalingEnabled,
    ocid: properties?.ocid,
    connectionStrings: properties?.connectionStrings,
    createTime: database.createTime,
  };
};

const getByName = (name: string) =>
  retryQuota(oracle.getProjectsLocationsAutonomousDatabases({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listDatabases = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      oracle.listProjectsLocationsAutonomousDatabases.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.autonomousDatabases,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    );
  return listAtLocation(project, region, collect).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );
};

const identityChanged = (
  news: AutonomousDatabaseProps,
  olds: AutonomousDatabaseProps | undefined,
  output: AutonomousDatabase["Attributes"] | undefined,
) => {
  const props = mergedProperties(news);
  const previousNetwork = olds?.network ?? output?.network ?? "";
  const nextNetwork = news.network ?? previousNetwork;
  const previousCidr = olds?.cidr ?? output?.cidr ?? "";
  const nextCidr = news.cidr ?? previousCidr;
  const previousOdb = olds?.odbSubnet ?? output?.odbSubnet ?? "";
  const nextOdb = news.odbSubnet ?? previousOdb;
  const previousOdbNet = olds?.odbNetwork ?? output?.odbNetwork ?? "";
  const nextOdbNet = news.odbNetwork ?? previousOdbNet;
  const previousDatabase = olds?.database ?? output?.database ?? "";
  const nextDatabase = news.database ?? previousDatabase;
  const previousLicense =
    olds?.licenseType ??
    olds?.properties?.licenseType ??
    output?.licenseType ??
    "";
  const nextLicense = props.licenseType ?? previousLicense;
  const previousWorkload =
    olds?.dbWorkload ??
    olds?.properties?.dbWorkload ??
    output?.dbWorkload ??
    "";
  const nextWorkload = props.dbWorkload ?? previousWorkload;
  const previousEdition =
    olds?.dbEdition ?? olds?.properties?.dbEdition ?? output?.dbEdition ?? "";
  const nextEdition = props.dbEdition ?? previousEdition;
  const previousVersion =
    olds?.dbVersion ?? olds?.properties?.dbVersion ?? output?.dbVersion ?? "";
  const nextVersion = props.dbVersion ?? previousVersion;
  return (
    nextNetwork !== previousNetwork ||
    nextCidr !== previousCidr ||
    nextOdb !== previousOdb ||
    nextOdbNet !== previousOdbNet ||
    nextDatabase !== previousDatabase ||
    nextLicense !== previousLicense ||
    nextWorkload !== previousWorkload ||
    nextEdition !== previousEdition ||
    nextVersion !== previousVersion
  );
};

export const AutonomousDatabaseProvider = () =>
  Provider.succeed(AutonomousDatabase, {
    stables: [
      "name",
      "autonomousDatabaseId",
      "project",
      "location",
      "createTime",
      "ocid",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.autonomousDatabaseId ?? output?.autonomousDatabaseId,
        nextId:
          news.autonomousDatabaseId ??
          olds?.autonomousDatabaseId ??
          output?.autonomousDatabaseId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra: identityChanged(news, olds, output),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const autonomousDatabaseId = yield* toPhysicalId(
        id,
        olds?.autonomousDatabaseId,
        output?.autonomousDatabaseId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceNameOf(env.project, location, COLLECTION, autonomousDatabaseId);
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
        const items = yield* listDatabases(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const autonomousDatabaseId = yield* toPhysicalId(
        id,
        news.autonomousDatabaseId,
        output?.autonomousDatabaseId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceNameOf(
        env.project,
        location,
        COLLECTION,
        autonomousDatabaseId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsAutonomousDatabases({
            parent: parentOf(env.project, location),
            autonomousDatabaseId,
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

      const props = mergedProperties(news);
      const observedLabels = tagRecord(ready.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const computeChanged =
        (props.cpuCoreCount !== undefined &&
          !specifiedEquals(
            props.cpuCoreCount,
            ready.properties?.cpuCoreCount,
          )) ||
        (props.computeCount !== undefined &&
          !specifiedEquals(props.computeCount, ready.properties?.computeCount));
      const storageChanged =
        (props.dataStorageSizeGb !== undefined &&
          !specifiedEquals(
            props.dataStorageSizeGb,
            ready.properties?.dataStorageSizeGb,
          )) ||
        (props.dataStorageSizeTb !== undefined &&
          !specifiedEquals(
            props.dataStorageSizeTb,
            ready.properties?.dataStorageSizeTb,
          ));
      const scalingChanged =
        (props.isAutoScalingEnabled !== undefined &&
          props.isAutoScalingEnabled !==
            ready.properties?.isAutoScalingEnabled) ||
        (props.isStorageAutoScalingEnabled !== undefined &&
          props.isStorageAutoScalingEnabled !==
            ready.properties?.isStorageAutoScalingEnabled);
      const encryptionChanged =
        props.encryptionKey !== undefined &&
        !specifiedEquals(props.encryptionKey, ready.properties?.encryptionKey);
      const dataGuardChanged =
        props.localDataGuardEnabled !== undefined &&
        props.localDataGuardEnabled !== ready.properties?.localDataGuardEnabled;
      const failoverLimitChanged =
        props.localAdgAutoFailoverMaxDataLossLimitDuration !== undefined &&
        !specifiedEquals(
          props.localAdgAutoFailoverMaxDataLossLimitDuration,
          ready.properties?.localAdgAutoFailoverMaxDataLossLimitDuration,
        );

      if (
        labelsChanged ||
        computeChanged ||
        storageChanged ||
        scalingChanged ||
        encryptionChanged ||
        dataGuardChanged ||
        failoverLimitChanged
      ) {
        const mask = [
          labelsChanged ? "labels" : undefined,
          computeChanged ? "properties.cpu_core_count" : undefined,
          computeChanged ? "properties.compute_count" : undefined,
          storageChanged ? "properties.data_storage_size_gb" : undefined,
          storageChanged ? "properties.data_storage_size_tb" : undefined,
          scalingChanged ? "properties.is_auto_scaling_enabled" : undefined,
          scalingChanged
            ? "properties.is_storage_auto_scaling_enabled"
            : undefined,
          encryptionChanged ? "properties.encryption_key" : undefined,
          dataGuardChanged ? "properties.local_data_guard_enabled" : undefined,
          failoverLimitChanged
            ? "properties.local_adg_auto_failover_max_data_loss_limit_duration"
            : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation = yield* retryQuota(
          oracle.patchProjectsLocationsAutonomousDatabases({
            name: ready.name ?? name,
            updateMask: mask.join(","),
            body: {
              name: ready.name ?? name,
              labels: desiredLabels,
              properties: {
                cpuCoreCount: props.cpuCoreCount,
                computeCount: props.computeCount,
                dataStorageSizeGb: props.dataStorageSizeGb,
                dataStorageSizeTb: props.dataStorageSizeTb,
                isAutoScalingEnabled: props.isAutoScalingEnabled,
                isStorageAutoScalingEnabled: props.isStorageAutoScalingEnabled,
                encryptionKey: props.encryptionKey,
                localDataGuardEnabled: props.localDataGuardEnabled,
                localAdgAutoFailoverMaxDataLossLimitDuration:
                  props.localAdgAutoFailoverMaxDataLossLimitDuration,
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
        .deleteProjectsLocationsAutonomousDatabases({
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
