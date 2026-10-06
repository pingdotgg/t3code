import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForDeleteOperation, waitForOperation } from "./operations.ts";

const DEFAULT_CLUSTER_TYPE = "PRIMARY";
const DEFAULT_NETWORK = "default";
/** Cluster ids must match `^[a-z]([a-z0-9-]{0,53}[a-z0-9])?$`. */
const MAX_NAME_LENGTH = 55;

export type ClusterTimeOfDay = {
  /** Hours of day in 24-hour format (`0`–`23`). */
  hours?: number;
  /** Minutes of hour (`0`–`59`). */
  minutes?: number;
  /** Seconds of minute (`0`–`59`). */
  seconds?: number;
  /** Fractional seconds, in nanoseconds. */
  nanos?: number;
};

export type MaintenanceWindow = {
  /** Preferred day of week (`MONDAY` … `SUNDAY`). */
  day?: alloydb.MaintenanceWindowDayEnum | (string & {});
  /** Preferred UTC start time. Maintenance starts within 1 hour. */
  startTime?: ClusterTimeOfDay;
};

export type DenyMaintenancePeriod = {
  /** Inclusive start date. */
  startDate?: { year?: number; month?: number; day?: number };
  /** Inclusive end date. */
  endDate?: { year?: number; month?: number; day?: number };
  /** UTC time of day for the window bounds. */
  time?: ClusterTimeOfDay;
};

export type MaintenanceUpdatePolicy = {
  /** Preferred windows. Currently limited to 1. */
  maintenanceWindows?: MaintenanceWindow[];
  /** Periods to deny maintenance. Currently limited to 1. */
  denyMaintenancePeriods?: DenyMaintenancePeriod[];
};

export type NetworkConfig = {
  /**
   * VPC network
   * (`projects/{project}/global/networks/{network}`). Immutable.
   * Required unless Private Service Connect is enabled.
   */
  network?: string;
  /**
   * Allocated IP range name for private IP (e.g.
   * `google-managed-services-default`). Immutable.
   */
  allocatedIpRange?: string;
};

export type PscConfig = {
  /**
   * Allow Private Service Connect endpoints. When true, a VPC network is
   * not required. Immutable.
   */
  pscEnabled?: boolean;
};

export type EncryptionConfig = {
  /**
   * Customer-managed KMS key
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Immutable — changing it replaces the cluster.
   */
  kmsKeyName?: string;
};

export type WeeklySchedule = {
  /** UTC start times (typically exact hours). */
  startTimes?: ClusterTimeOfDay[];
  /** Days of week. Empty means every day. */
  daysOfWeek?: Array<alloydb.WeeklyScheduleDaysOfWeekItemEnum | (string & {})>;
};

export type AutomatedBackupPolicy = {
  /** Whether automated backups are enabled. Defaults to true when omitted. */
  enabled?: boolean;
  /** Backup window duration (e.g. `"1800s"`). */
  backupWindow?: string;
  /** Weekly schedule. */
  weeklySchedule?: WeeklySchedule;
  /** Keep the most recent N backups. */
  quantityBasedRetention?: { count?: number };
  /** Keep backups for a duration (e.g. `"1209600s"`). */
  timeBasedRetention?: { retentionPeriod?: string };
  /** Backup location. Defaults to the cluster region. */
  location?: string;
  /** Labels applied to created backups. */
  labels?: Record<string, string>;
  /** CMEK for backups. Defaults to the cluster encryption config. */
  encryptionConfig?: EncryptionConfig;
};

export type ContinuousBackupConfig = {
  /** Whether continuous backup (PITR) is enabled. */
  enabled?: boolean;
  /** Recovery window in days. Defaults to 14. */
  recoveryWindowDays?: number;
  /** CMEK for continuous backups. */
  encryptionConfig?: EncryptionConfig;
};

export type InitialUser = {
  /** Database username. Defaults to `postgres` when omitted. */
  user?: string;
  /** Initial password. Create-only. */
  password?: string;
};

export type SslConfig = {
  /** Client-server SSL mode. */
  sslMode?: alloydb.SslConfigSslModeEnum | (string & {});
  /** Certificate authority source. Only `CA_SOURCE_MANAGED` is supported. */
  caSource?: alloydb.SslConfigCaSourceEnum | (string & {});
};

export type DataplexConfig = {
  /** Integrate AlloyDB PG resources with Dataplex. */
  enabled?: boolean;
};

export type SecondaryConfig = {
  /**
   * Primary cluster name
   * `projects/{project}/locations/{location}/clusters/{cluster}`.
   * Required when `clusterType` is `SECONDARY`. Immutable.
   */
  primaryClusterName?: string;
};

export type ClusterProps = {
  /**
   * Cluster id (the `{cluster}` segment of
   * `projects/{project}/locations/{location}/clusters/{cluster}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `[a-z0-9-]{1,63}`. Immutable — changing it
   * replaces the cluster.
   */
  clusterId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the cluster. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Arbitrary client annotations (distinct from labels).
   */
  annotations?: Record<string, string>;
  /**
   * Convenience alias for `networkConfig.network`. A bare network id
   * (`default`) is expanded to
   * `projects/{project}/global/networks/{network}`. Immutable.
   */
  network?: string;
  /**
   * Private IP network configuration. Immutable. Defaults to the project
   * `default` network when Private Service Connect is not enabled.
   */
  networkConfig?: NetworkConfig;
  /**
   * Private Service Connect configuration. `pscEnabled` is immutable.
   */
  pscConfig?: PscConfig;
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * cluster.
   */
  encryptionConfig?: EncryptionConfig;
  /**
   * Database engine major version (`POSTGRES_14`, `POSTGRES_15`, …).
   * Upgrading patches in place; downgrading replaces the cluster. If
   * omitted at create time, AlloyDB picks a default.
   */
  databaseVersion?: alloydb.ClusterDatabaseVersionEnum | (string & {});
  /**
   * Cluster type. `SECONDARY` uses `clusters.createsecondary` and
   * requires `secondaryConfig`. Immutable — changing it replaces the
   * cluster.
   * @default "PRIMARY"
   */
  clusterType?: alloydb.ClusterClusterTypeEnum | (string & {});
  /**
   * Cross-region replica config. Required for `SECONDARY` clusters.
   * Immutable.
   */
  secondaryConfig?: SecondaryConfig;
  /**
   * Initial database user. Create-only; ignored on update.
   */
  initialUser?: InitialUser;
  /**
   * Automated backup policy. If omitted, AlloyDB applies its default
   * (daily backups, 14-day retention).
   */
  automatedBackupPolicy?: AutomatedBackupPolicy;
  /**
   * Continuous backup (PITR) configuration.
   */
  continuousBackupConfig?: ContinuousBackupConfig;
  /**
   * Preferred maintenance windows and deny periods.
   */
  maintenanceUpdatePolicy?: MaintenanceUpdatePolicy;
  /**
   * Client-server SSL configuration.
   */
  sslConfig?: SslConfig;
  /**
   * Dataplex integration.
   */
  dataplexConfig?: DataplexConfig;
  /**
   * Subscription type (`STANDARD`, `TRIAL`).
   */
  subscriptionType?: alloydb.ClusterSubscriptionTypeEnum | (string & {});
};

export type Cluster = Resource<
  "GCP.AlloyDB.Cluster",
  ClusterProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/clusters/{cluster}`. */
    name: string;
    /** Cluster id (last path segment). */
    clusterId: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Client annotations. */
    annotations: Record<string, string>;
    /** Serving state (`READY`, `EMPTY`, `CREATING`, …). */
    state: string | undefined;
    /** Cluster type (`PRIMARY`, `SECONDARY`). */
    clusterType: string;
    /** Database engine major version. */
    databaseVersion: string | undefined;
    /** VPC network, if any. */
    network: string | undefined;
    /** Private IP network configuration. */
    networkConfig: NetworkConfig | undefined;
    /** Private Service Connect configuration. */
    pscConfig: PscConfig | undefined;
    /** Customer-managed encryption, if any. */
    encryptionConfig: EncryptionConfig | undefined;
    /** Automated backup policy currently applied. */
    automatedBackupPolicy: AutomatedBackupPolicy | undefined;
    /** Continuous backup configuration currently applied. */
    continuousBackupConfig: ContinuousBackupConfig | undefined;
    /** SSL configuration currently applied. */
    sslConfig: SslConfig | undefined;
    /** Subscription type. */
    subscriptionType: string | undefined;
    /** System-generated UID. */
    uid: string | undefined;
    /** Whether the service is reconciling intended vs actual state. */
    reconciling: boolean;
    /** Secondary-cluster config, if any. */
    secondaryConfig: SecondaryConfig | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An AlloyDB for PostgreSQL cluster (regional storage layer).
 *
 * Changing `clusterId`, `location`, `network` / `networkConfig`,
 * `encryptionConfig`, `clusterType`, `secondaryConfig`, or
 * `pscConfig.pscEnabled` replaces the cluster. A database version
 * upgrade patches in place; a downgrade replaces.
 *
 * Provisioning typically takes several minutes. Delete always sends
 * `force=true` so child instances do not block teardown.
 *
 * ### Creating a Cluster
 * **Example:** Generated name with Private Service Connect
 * ```typescript
 * const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
 *   location: "us-central1",
 *   pscConfig: { pscEnabled: true },
 *   initialUser: { user: "postgres", password: "change-me" },
 *   automatedBackupPolicy: { enabled: false },
 *   continuousBackupConfig: { enabled: false },
 * });
 * ```
 *
 * **Example:** Explicit id, default VPC, and labels
 * ```typescript
 * const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
 *   clusterId: "app-db",
 *   location: "us-central1",
 *   network: "default",
 *   displayName: "app-db",
 *   labels: { env: "prod" },
 *   initialUser: { user: "postgres", password: "change-me" },
 * });
 * ```
 *
 * ### Backups
 * **Example:** Disable automated and continuous backups
 * ```typescript
 * const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
 *   pscConfig: { pscEnabled: true },
 *   automatedBackupPolicy: { enabled: false },
 *   continuousBackupConfig: { enabled: false },
 * });
 * ```
 *
 * @resource
 * @category AlloyDB
 */
export const Cluster = Resource<Cluster>("GCP.AlloyDB.Cluster");

export class ClusterNotResolved extends Data.TaggedError(
  "GCP.AlloyDB.ClusterNotResolved",
)<{
  name: string;
}> {}

export class ClusterNotReady extends Data.TaggedError(
  "GCP.AlloyDB.ClusterNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ClusterFailed extends Data.TaggedError(
  "GCP.AlloyDB.ClusterFailed",
)<{
  name: string;
  state: string;
}> {}

export class ClusterStillExists extends Data.TaggedError(
  "GCP.AlloyDB.ClusterStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

const normalizeClusterType = (type: string | undefined) => {
  const value = (type ?? DEFAULT_CLUSTER_TYPE).toUpperCase();
  return value === "CLUSTER_TYPE_UNSPECIFIED" ? DEFAULT_CLUSTER_TYPE : value;
};

const normalizeVersion = (version: string | undefined) => {
  if (version === undefined || version.length === 0) return undefined;
  const value = version.toUpperCase();
  return value === "DATABASE_VERSION_UNSPECIFIED" ? undefined : value;
};

const parsePostgresVersion = (version: string | undefined) => {
  const normalized = normalizeVersion(version);
  if (normalized === undefined) return undefined;
  const match = normalized.match(/^POSTGRES_(\d+)$/);
  return match ? Number(match[1]) : undefined;
};

const versionDecreasing = (previous: string | undefined, next: string) => {
  const oldN = parsePostgresVersion(previous);
  const newN = parsePostgresVersion(next);
  if (oldN === undefined || newN === undefined) return previous !== next;
  return newN < oldN;
};

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
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    clusterId:
      clustersAt >= 0 && parts[clustersAt + 1]
        ? parts[clustersAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const stringMapOf = (
  map: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[1].length > 0,
    ),
  );

const expandNetwork = (project: string, network: string | undefined) => {
  if (network === undefined || network.length === 0) return undefined;
  if (network.includes("/")) return network;
  return `projects/${project}/global/networks/${network}`;
};

const networkIdOf = (network: string | undefined) => lastSegment(network);

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

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

const specifiedEquals = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (
    typeof desired === "boolean" ||
    typeof desired === "number" ||
    typeof desired === "string" ||
    Array.isArray(desired)
  ) {
    return fingerprint(desired) === fingerprint(observed);
  }
  if (desired !== null && typeof desired === "object") {
    const obs =
      observed !== null && typeof observed === "object"
        ? (observed as Record<string, unknown>)
        : {};
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => specifiedEquals(value, obs[key]),
    );
  }
  return fingerprint(desired) === fingerprint(observed);
};

const toNetworkConfig = (
  config: alloydb.NetworkConfig | NetworkConfig | undefined,
  fallbackNetwork?: string,
): NetworkConfig | undefined => {
  const network = config?.network ?? fallbackNetwork;
  const allocatedIpRange = config?.allocatedIpRange;
  if (
    (network === undefined || network.length === 0) &&
    (allocatedIpRange === undefined || allocatedIpRange.length === 0)
  ) {
    return undefined;
  }
  return {
    network: network || undefined,
    allocatedIpRange: allocatedIpRange || undefined,
  };
};

const toPscConfig = (
  config: alloydb.PscConfig | PscConfig | undefined,
): PscConfig | undefined => {
  if (config === undefined) return undefined;
  return { pscEnabled: config.pscEnabled === true };
};

const toEncryptionConfig = (
  config: alloydb.EncryptionConfig | EncryptionConfig | undefined,
): EncryptionConfig | undefined => {
  const kmsKeyName = config?.kmsKeyName;
  if (kmsKeyName === undefined || kmsKeyName.length === 0) return undefined;
  return { kmsKeyName };
};

const toSslConfig = (
  config: alloydb.SslConfig | SslConfig | undefined,
): SslConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    sslMode: config.sslMode,
    caSource: config.caSource,
  };
};

const toSecondaryConfig = (
  config: alloydb.SecondaryConfig | SecondaryConfig | undefined,
): SecondaryConfig | undefined => {
  const primaryClusterName = config?.primaryClusterName;
  if (primaryClusterName === undefined || primaryClusterName.length === 0) {
    return undefined;
  }
  return { primaryClusterName };
};

const toAutomatedBackupPolicy = (
  policy: alloydb.AutomatedBackupPolicy | AutomatedBackupPolicy | undefined,
): AutomatedBackupPolicy | undefined => {
  if (policy === undefined) return undefined;
  return canonical(policy) as AutomatedBackupPolicy | undefined;
};

const toContinuousBackupConfig = (
  config: alloydb.ContinuousBackupConfig | ContinuousBackupConfig | undefined,
): ContinuousBackupConfig | undefined => {
  if (config === undefined) return undefined;
  return canonical(config) as ContinuousBackupConfig | undefined;
};

const isAvailable = (state: string | undefined) => {
  const value = (state ?? "").toUpperCase();
  return value === "READY" || value === "EMPTY";
};

const isFailed = (state: string | undefined) =>
  (state ?? "").toUpperCase() === "FAILED";

const toAttrs = (cluster: alloydb.Cluster, project: string) => {
  const name = cluster.name ?? "";
  const parsed = parseName(name);
  const networkConfig = toNetworkConfig(cluster.networkConfig, cluster.network);
  return {
    name,
    clusterId: parsed.clusterId,
    project: parsed.project || project,
    location: parsed.location,
    displayName: cluster.displayName,
    labels: userLabels(cluster.labels),
    annotations: stringMapOf(cluster.annotations),
    state: cluster.state,
    clusterType: normalizeClusterType(cluster.clusterType),
    databaseVersion: cluster.databaseVersion,
    network: networkConfig?.network ?? cluster.network,
    networkConfig,
    pscConfig: toPscConfig(cluster.pscConfig),
    encryptionConfig: toEncryptionConfig(cluster.encryptionConfig),
    automatedBackupPolicy: toAutomatedBackupPolicy(
      cluster.automatedBackupPolicy,
    ),
    continuousBackupConfig: toContinuousBackupConfig(
      cluster.continuousBackupConfig,
    ),
    sslConfig: toSslConfig(cluster.sslConfig),
    subscriptionType: cluster.subscriptionType,
    uid: cluster.uid,
    reconciling: cluster.reconciling === true,
    secondaryConfig: toSecondaryConfig(cluster.secondaryConfig),
    createTime: cluster.createTime,
    updateTime: cluster.updateTime,
  };
};

const isPlaceholder = (cluster: alloydb.Cluster) => {
  const name = cluster.name ?? "";
  return name.endsWith("/clusters/-") || name.endsWith("/clusters/");
};

const getByName = (name: string) =>
  alloydb
    .getProjectsLocationsClusters({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((cluster) =>
      cluster
        ? Effect.succeed(cluster)
        : Effect.fail(new ClusterNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.ClusterNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  Effect.gen(function* () {
    const cluster = yield* getByName(name);
    if (cluster === undefined) {
      return yield* new ClusterNotReady({ name, state: "MISSING" });
    }
    if (isFailed(cluster.state)) {
      return yield* new ClusterFailed({
        name,
        state: cluster.state ?? "FAILED",
      });
    }
    if (!(isAvailable(cluster.state) && cluster.reconciling !== true)) {
      return yield* new ClusterNotReady({
        name,
        state: cluster.state ?? "STATE_UNSPECIFIED",
      });
    }
    return cluster;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.ClusterNotReady",
      times: 120,
      schedule: Schedule.spaced("15 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((cluster) =>
      cluster === undefined
        ? Effect.void
        : Effect.fail(new ClusterStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.ClusterStillExists",
      times: 120,
      schedule: Schedule.spaced("15 seconds"),
    }),
  );

const desiredNetworkConfig = (
  news: ClusterProps,
  project: string,
  pscEnabled: boolean,
): NetworkConfig | undefined => {
  const network = expandNetwork(
    project,
    news.networkConfig?.network ?? news.network,
  );
  const allocatedIpRange = news.networkConfig?.allocatedIpRange;
  if (pscEnabled) {
    if (
      (network === undefined || network.length === 0) &&
      (allocatedIpRange === undefined || allocatedIpRange.length === 0)
    ) {
      return undefined;
    }
    return { network, allocatedIpRange };
  }
  return {
    network: network ?? expandNetwork(project, DEFAULT_NETWORK),
    allocatedIpRange,
  };
};

const toCreateBody = (
  news: ClusterProps,
  desiredLabels: Record<string, string>,
  clusterType: string,
  networkConfig: NetworkConfig | undefined,
  pscEnabled: boolean,
): alloydb.Cluster => {
  const body: alloydb.Cluster = {
    displayName: news.displayName,
    labels: desiredLabels,
    clusterType,
  };
  if (news.annotations !== undefined) {
    body.annotations = news.annotations;
  }
  if (networkConfig !== undefined) {
    body.networkConfig = networkConfig;
  }
  if (news.pscConfig !== undefined || pscEnabled) {
    body.pscConfig = { pscEnabled };
  }
  const encryption = toEncryptionConfig(news.encryptionConfig);
  if (encryption !== undefined) {
    body.encryptionConfig = encryption;
  }
  const version = normalizeVersion(news.databaseVersion);
  if (version !== undefined) {
    body.databaseVersion = version;
  }
  if (clusterType === "SECONDARY" && news.secondaryConfig !== undefined) {
    body.secondaryConfig = news.secondaryConfig;
  }
  if (news.initialUser !== undefined) {
    body.initialUser = news.initialUser;
  }
  if (news.automatedBackupPolicy !== undefined) {
    body.automatedBackupPolicy = news.automatedBackupPolicy;
  }
  if (news.continuousBackupConfig !== undefined) {
    body.continuousBackupConfig = news.continuousBackupConfig;
  }
  if (news.maintenanceUpdatePolicy !== undefined) {
    body.maintenanceUpdatePolicy = news.maintenanceUpdatePolicy;
  }
  if (news.sslConfig !== undefined) {
    body.sslConfig = news.sslConfig;
  }
  if (news.dataplexConfig !== undefined) {
    body.dataplexConfig = news.dataplexConfig;
  }
  if (news.subscriptionType !== undefined) {
    body.subscriptionType = news.subscriptionType;
  }
  return body;
};

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["name", "clusterId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.clusterId ?? output?.clusterId;
      const nextId = news.clusterId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const previousType = normalizeClusterType(
        olds?.clusterType ?? output?.clusterType,
      );
      const nextType = normalizeClusterType(
        news.clusterType ?? output?.clusterType,
      );
      const previousNetwork = networkIdOf(
        olds?.networkConfig?.network ??
          olds?.network ??
          output?.networkConfig?.network ??
          output?.network,
      );
      const nextNetwork = networkIdOf(
        news.networkConfig?.network ?? news.network ?? previousNetwork,
      );
      const previousRange =
        olds?.networkConfig?.allocatedIpRange ??
        output?.networkConfig?.allocatedIpRange ??
        "";
      const nextRange = news.networkConfig?.allocatedIpRange ?? previousRange;
      const previousPsc =
        olds?.pscConfig?.pscEnabled === true ||
        output?.pscConfig?.pscEnabled === true;
      const nextPsc =
        news.pscConfig?.pscEnabled !== undefined
          ? news.pscConfig.pscEnabled === true
          : previousPsc;
      const previousKey =
        olds?.encryptionConfig?.kmsKeyName ??
        output?.encryptionConfig?.kmsKeyName ??
        "";
      const nextKey = news.encryptionConfig?.kmsKeyName ?? previousKey;
      const previousPrimary =
        olds?.secondaryConfig?.primaryClusterName ??
        output?.secondaryConfig?.primaryClusterName ??
        "";
      const nextPrimary =
        news.secondaryConfig?.primaryClusterName ?? previousPrimary;
      const previousVersion = normalizeVersion(
        olds?.databaseVersion ?? output?.databaseVersion,
      );
      const nextVersion = normalizeVersion(news.databaseVersion);
      const downgrade =
        nextVersion !== undefined &&
        previousVersion !== undefined &&
        versionDecreasing(previousVersion, nextVersion);

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousType !== nextType ||
        previousNetwork !== nextNetwork ||
        previousRange !== nextRange ||
        previousPsc !== nextPsc ||
        previousKey !== nextKey ||
        previousPrimary !== nextPrimary ||
        downgrade;

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
      const clusterId = yield* toId(id, olds?.clusterId, output?.clusterId);
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, clusterId);
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
        return yield* alloydb.listProjectsLocationsClusters
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.clusters ?? [])),
            Stream.filter(
              (cluster) =>
                !isPlaceholder(cluster) &&
                Object.keys(cluster.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
            ),
            Stream.map((cluster) => toAttrs(cluster, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const clusterId = yield* toId(id, news.clusterId, output?.clusterId);
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, clusterId);
      const clusterType = normalizeClusterType(news.clusterType);
      const pscEnabled = news.pscConfig?.pscEnabled === true;
      const networkConfig = desiredNetworkConfig(news, env.project, pscEnabled);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const parent = `projects/${env.project}/locations/${location}`;
        const body = toCreateBody(
          news,
          desiredLabels,
          clusterType,
          networkConfig,
          pscEnabled,
        );
        const created = yield* (
          clusterType === "SECONDARY"
            ? alloydb.createsecondaryProjectsLocationsClusters({
                parent,
                clusterId,
                body,
              })
            : alloydb.createProjectsLocationsClusters({
                parent,
                clusterId,
                body,
              })
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new ClusterNotResolved({ name });
      }

      if (!isAvailable(current.state) || current.reconciling === true) {
        current = yield* waitUntilReady(name);
      }

      const desiredVersion = normalizeVersion(news.databaseVersion);
      const currentVersion = normalizeVersion(current.databaseVersion);
      const versionChanged =
        desiredVersion !== undefined &&
        currentVersion !== undefined &&
        desiredVersion !== currentVersion &&
        !versionDecreasing(currentVersion, desiredVersion);

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      // AlloyDB has been observed to omit `displayName` from reads; when it
      // does, compare against what was last applied instead of re-patching
      // on every deploy.
      const observedDisplayName =
        current.displayName ?? output?.displayName ?? olds?.displayName;
      const displayNameChanged =
        (observedDisplayName ?? "") !== (news.displayName ?? "");
      const annotationsChanged =
        news.annotations !== undefined &&
        fingerprint(stringMapOf(current.annotations)) !==
          fingerprint(news.annotations);
      const backupChanged =
        news.automatedBackupPolicy !== undefined &&
        !specifiedEquals(
          news.automatedBackupPolicy,
          current.automatedBackupPolicy,
        );
      const continuousChanged =
        news.continuousBackupConfig !== undefined &&
        !specifiedEquals(
          news.continuousBackupConfig,
          current.continuousBackupConfig,
        );
      const maintenanceChanged =
        news.maintenanceUpdatePolicy !== undefined &&
        !specifiedEquals(
          news.maintenanceUpdatePolicy,
          current.maintenanceUpdatePolicy,
        );
      const sslChanged =
        news.sslConfig !== undefined &&
        !specifiedEquals(news.sslConfig, toSslConfig(current.sslConfig));
      const dataplexChanged =
        news.dataplexConfig !== undefined &&
        !specifiedEquals(news.dataplexConfig, current.dataplexConfig);
      const subscriptionChanged =
        news.subscriptionType !== undefined &&
        (current.subscriptionType ?? "") !== news.subscriptionType;

      if (
        labelsChanged ||
        displayNameChanged ||
        annotationsChanged ||
        backupChanged ||
        continuousChanged ||
        maintenanceChanged ||
        sslChanged ||
        dataplexChanged ||
        subscriptionChanged ||
        versionChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "displayName" : undefined,
          annotationsChanged ? "annotations" : undefined,
          backupChanged ? "automatedBackupPolicy" : undefined,
          continuousChanged ? "continuousBackupConfig" : undefined,
          maintenanceChanged ? "maintenanceUpdatePolicy" : undefined,
          sslChanged ? "sslConfig" : undefined,
          dataplexChanged ? "dataplexConfig" : undefined,
          subscriptionChanged ? "subscriptionType" : undefined,
          versionChanged ? "databaseVersion" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* alloydb
          .patchProjectsLocationsClusters({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              displayName: news.displayName,
              annotations: news.annotations,
              automatedBackupPolicy: news.automatedBackupPolicy,
              continuousBackupConfig: news.continuousBackupConfig,
              maintenanceUpdatePolicy: news.maintenanceUpdatePolicy,
              sslConfig: news.sslConfig,
              dataplexConfig: news.dataplexConfig,
              subscriptionType: news.subscriptionType,
              databaseVersion: desiredVersion,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 40,
              schedule: Schedule.spaced("15 seconds"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      // When the read omits `displayName`, the desired value is what is
      // deployed: it was sent on create, patched above, or observed equal.
      return {
        ...toAttrs(current, env.project),
        displayName: current.displayName ?? news.displayName,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* alloydb
        .deleteProjectsLocationsClusters({
          name: output.name,
          force: true,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 40,
            schedule: Schedule.spaced("15 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(output.name);
    }),
  });
