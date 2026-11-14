import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForSqlOperation } from "./operations.ts";

const DEFAULT_DATABASE_VERSION = "MYSQL_8_0";
const DEFAULT_TIER = "db-f1-micro";
const DEFAULT_EDITION = "ENTERPRISE";
const DEFAULT_AVAILABILITY = "ZONAL";
const DEFAULT_ACTIVATION = "ALWAYS";
const DEFAULT_DISK_TYPE = "PD_SSD";
const DEFAULT_DISK_SIZE_GB = 10;
const MAX_NAME_LENGTH = 63;
/**
 * Generated names stay short enough that the connection name
 * `{project}:{region}:{instance}` fits Cloud Run's 97-character limit for
 * Cloud SQL volumes (30-character project ids, 23-character regions).
 */
const GENERATED_NAME_MAX_LENGTH = 42;

export type DatabaseFlag = {
  /** Flag name (underscores, not hyphens). */
  name: string;
  /**
   * Flag value. Boolean flags use `on` / `off`. Omit for flags that take
   * no value.
   */
  value?: string;
};

export type IpConfiguration = {
  /**
   * Assign a public IPv4 address. Set `false` together with
   * `privateNetwork` for a private-IP-only instance.
   * @default true
   */
  ipv4Enabled?: boolean;
  /**
   * VPC network the instance gets a private IP on. Accepts a name
   * (`main`), a resource path (`projects/{project}/global/networks/{network}`),
   * or a Compute self-link. The network needs private services access: an
   * `INTERNAL` / `VPC_PEERING` `GCP.Compute.GlobalAddress` range and a
   * `GCP.ServiceNetworking.Connection` to it. Cloud SQL can move an instance
   * to another network but cannot remove private IP once set, so dropping
   * this prop leaves the observed network in place.
   */
  privateNetwork?: string;
  /**
   * Name of the allocated `VPC_PEERING` range to take the private IP from
   * (`google-managed-services-default`, or a `GlobalAddress`'s
   * `addressName`). When omitted, Cloud SQL picks any range reserved for
   * the connection.
   */
  allocatedIpRange?: string;
  /**
   * How SSL/TLS is enforced on database connections:
   * `ALLOW_UNENCRYPTED_AND_ENCRYPTED`, `ENCRYPTED_ONLY`, or
   * `TRUSTED_CLIENT_CERTIFICATE_REQUIRED` (client certificates from
   * `GCP.SQL.SslCert`). The legacy `requireSsl` flag is set to match.
   * @default Cloud SQL's default, `ALLOW_UNENCRYPTED_AND_ENCRYPTED`
   */
  sslMode?: sqladmin.IpConfigurationSslModeEnum | (string & {});
};

export type BackupSettings = {
  /**
   * Enable automated daily backups. MySQL also enables binary logs and
   * PostgreSQL point-in-time recovery when true.
   * @default false
   */
  enabled?: boolean;
  /**
   * Number of automated backups to retain (1–365).
   * @default 7
   */
  retainedBackups?: number;
  /**
   * Days of transaction logs kept for point-in-time restore (1–7 on
   * `ENTERPRISE`, up to 35 on `ENTERPRISE_PLUS`).
   * @default 7
   */
  transactionLogRetentionDays?: number;
  /**
   * Start of the daily backup window, UTC `HH:MM` (`03:00`).
   */
  startTime?: string;
};

export type InstanceProps = {
  /**
   * Cloud SQL instance id (the `{instance}` segment of
   * `projects/{project}/instances/{instance}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Must start with a
   * letter, contain only lowercase letters, numbers, and hyphens, and not
   * end with a hyphen (1–98 characters). Immutable — changing it replaces
   * the instance.
   */
  instanceName?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the instance. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Database engine and major version (`MYSQL_8_0`, `POSTGRES_15`, …).
   * Changing the version within the same engine (`POSTGRES_16` →
   * `POSTGRES_17`) runs an in-place major version upgrade. Changing the
   * engine (`MYSQL_8_0` → `POSTGRES_17`) replaces the instance.
   * @default "MYSQL_8_0"
   */
  databaseVersion?: sqladmin.DatabaseInstanceDatabaseVersionEnum | (string & {});
  /**
   * Machine type (`db-f1-micro`, `db-custom-1-3840`, …). Changing it
   * restarts the instance.
   * @default "db-f1-micro"
   */
  tier?: string;
  /**
   * Edition (`ENTERPRISE`, `ENTERPRISE_PLUS`, `DEVELOPER`).
   * @default "ENTERPRISE"
   */
  edition?: sqladmin.SettingsEditionEnum | (string & {});
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * onto `settings.userLabels`.
   */
  labels?: Record<string, string>;
  /**
   * Preferred Compute Engine zone (`us-central1-a`). Changing it may
   * restart the instance.
   */
  zone?: string;
  /**
   * High-availability type. `REGIONAL` requires backups.
   * @default "ZONAL"
   */
  availabilityType?: sqladmin.SettingsAvailabilityTypeEnum | (string & {});
  /**
   * When the instance is activated. `NEVER` stops it.
   * @default "ALWAYS"
   */
  activationPolicy?: sqladmin.SettingsActivationPolicyEnum | (string & {});
  /**
   * Data disk size in GiB. Minimum 10. May only increase after create.
   * @default 10
   */
  dataDiskSizeGb?: number;
  /**
   * Data disk type (`PD_SSD`, `PD_HDD`).
   * @default "PD_SSD"
   */
  dataDiskType?: sqladmin.SettingsDataDiskTypeEnum | (string & {});
  /**
   * Public IP, private IP, and SSL settings. Fields left unset keep their
   * observed values.
   */
  ipConfiguration?: IpConfiguration;
  /**
   * Automated backup settings. Fields left unset keep their observed
   * values.
   */
  backup?: BackupSettings;
  /**
   * Grow the data disk automatically when it nears capacity. A grown disk
   * cannot shrink back.
   * @default false
   */
  storageAutoResize?: boolean;
  /**
   * Protect against accidental instance deletion. While enabled, destroy
   * and replacement fail with `InstanceDeletionProtected`; set it to
   * `false` and deploy before removing the instance.
   * @default false
   */
  deletionProtectionEnabled?: boolean;
  /**
   * Database flags passed at instance startup.
   */
  databaseFlags?: DatabaseFlag[];
  /**
   * Allow Cloud SQL `instances.executeSql`. Required for `ExecuteSql`.
   * @default false
   */
  dataApiAccess?: boolean;
  /**
   * Initial root password. Create-only. Required to connect to
   * PostgreSQL.
   */
  rootPassword?: string;
};

export type Instance = Resource<
  "GCP.SQL.Instance",
  InstanceProps,
  {
    /** Cloud SQL instance id. */
    instanceName: string;
    /** Project id. */
    project: string;
    /** Region (`us-central1`, …). */
    region: string;
    /** Database engine and version. */
    databaseVersion: string | undefined;
    /** Installed version including minor, if reported. */
    databaseInstalledVersion: string | undefined;
    /** Machine type. */
    tier: string | undefined;
    /** Edition (`ENTERPRISE`, …). */
    edition: string | undefined;
    /** Serving state (`RUNNABLE`, `PENDING_CREATE`, …). */
    state: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Connection name `project:region:instance`. */
    connectionName: string | undefined;
    /** Preferred / current GCE zone. */
    gceZone: string | undefined;
    /** Public IPv4, if any. */
    ipAddress: string | undefined;
    /** Private IP on `privateNetwork`, if any. */
    privateIpAddress: string | undefined;
    /** Whether public IPv4 is enabled. */
    ipv4Enabled: boolean;
    /** VPC network path of the private IP, if any. */
    privateNetwork: string | undefined;
    /** SSL/TLS enforcement mode. */
    sslMode: string | undefined;
    /** Whether deletion protection is enabled. */
    deletionProtectionEnabled: boolean;
    /** Activation policy (`ALWAYS`, `NEVER`, …). */
    activationPolicy: string | undefined;
    /** Availability type (`ZONAL`, `REGIONAL`). */
    availabilityType: string | undefined;
    /** Data disk size in GiB. */
    dataDiskSizeGb: number | undefined;
    /** Whether automated backups are enabled. */
    backupEnabled: boolean;
    /** Number of automated backups retained. */
    retainedBackups: number | undefined;
    /** Days of transaction logs retained for point-in-time restore. */
    transactionLogRetentionDays: number | undefined;
    /** Whether the data disk grows automatically. */
    storageAutoResize: boolean;
    /** Service account email used by the instance. */
    serviceAccountEmailAddress: string | undefined;
    /** SQL Admin self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud SQL database instance.
 *
 * Changing `instanceName`, `region`, or the `databaseVersion` engine
 * replaces the instance; a major version upgrade within the same engine
 * runs in place. Provisioning typically takes several minutes (often 5–15).
 *
 * ### Creating an Instance
 * **Example:** Generated name, MySQL 8.0 shared-core
 * ```typescript
 * const db = yield* GCP.SQL.Instance("AppDb", {});
 * ```
 *
 * **Example:** Explicit name, labels, and backups off
 * ```typescript
 * const db = yield* GCP.SQL.Instance("AppDb", {
 *   instanceName: "app-db",
 *   region: "us-central1",
 *   databaseVersion: "MYSQL_8_0",
 *   tier: "db-f1-micro",
 *   labels: { env: "prod" },
 *   backup: { enabled: false },
 *   deletionProtectionEnabled: false,
 * });
 * ```
 *
 * ### PostgreSQL
 * **Example:** Postgres 15 with a root password
 * ```typescript
 * const db = yield* GCP.SQL.Instance("AppDb", {
 *   databaseVersion: "POSTGRES_15",
 *   rootPassword: "change-me",
 *   tier: "db-f1-micro",
 * });
 * ```
 *
 * ### Private IP and SSL
 * **Example:** Private-IP-only Postgres over private services access
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const range = yield* GCP.Compute.GlobalAddress("PsaRange", {
 *   addressType: "INTERNAL",
 *   purpose: "VPC_PEERING",
 *   network: network.selfLink,
 *   prefixLength: 20,
 * });
 * const psa = yield* GCP.ServiceNetworking.Connection("Psa", {
 *   network: network.networkName,
 *   reservedPeeringRanges: [range.addressName],
 * });
 * const db = yield* GCP.SQL.Instance("Control", {
 *   databaseVersion: "POSTGRES_17",
 *   tier: "db-custom-2-8192",
 *   ipConfiguration: {
 *     ipv4Enabled: false,
 *     privateNetwork: psa.network,
 *     sslMode: "ENCRYPTED_ONLY",
 *   },
 * });
 * // db.privateIpAddress is reachable from inside the VPC
 * ```
 *
 * ### Backups and Storage
 * **Example:** Retained backups, PITR log retention, and disk auto-resize
 * ```typescript
 * const db = yield* GCP.SQL.Instance("AppDb", {
 *   databaseVersion: "POSTGRES_17",
 *   backup: {
 *     enabled: true,
 *     retainedBackups: 14,
 *     transactionLogRetentionDays: 7,
 *     startTime: "03:00",
 *   },
 *   storageAutoResize: true,
 * });
 * ```
 *
 * @resource
 * @category SQL
 */
export const Instance = Resource<Instance>("GCP.SQL.Instance");

export class InstanceNotResolved extends Data.TaggedError("GCP.SQL.InstanceNotResolved")<{
  instanceName: string;
  project: string;
}> {}

export class InstanceNotReady extends Data.TaggedError("GCP.SQL.InstanceNotReady")<{
  instanceName: string;
  state: string;
}> {}

export class InstanceFailed extends Data.TaggedError("GCP.SQL.InstanceFailed")<{
  instanceName: string;
  state: string;
}> {}

export class InstanceStillExists extends Data.TaggedError("GCP.SQL.InstanceStillExists")<{
  instanceName: string;
}> {}

export class InstanceDeletionProtected extends Data.TaggedError(
  "GCP.SQL.InstanceDeletionProtected",
)<{
  instanceName: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] ?? value;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const normalizeVersion = (version: string | undefined) =>
  (version ?? DEFAULT_DATABASE_VERSION).toUpperCase();

const engineOf = (version: string) => version.split("_")[0];

const normalizeTier = (tier: string | undefined) => tier ?? DEFAULT_TIER;

const normalizeEdition = (edition: string | undefined) =>
  (edition ?? DEFAULT_EDITION).toUpperCase();

const normalizeAvailability = (value: string | undefined) =>
  (value ?? DEFAULT_AVAILABILITY).toUpperCase();

const normalizeActivation = (value: string | undefined) =>
  (value ?? DEFAULT_ACTIVATION).toUpperCase();

const normalizeDiskType = (value: string | undefined) => (value ?? DEFAULT_DISK_TYPE).toUpperCase();

const isMysql = (version: string) => version.toUpperCase().startsWith("MYSQL_");

const isPostgres = (version: string) => version.toUpperCase().startsWith("POSTGRES_");

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "instance";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      rfc1035(
        yield* createPhysicalName({
          id,
          maxLength: GENERATED_NAME_MAX_LENGTH,
          lowercase: true,
        }),
      )
    );
  });

const flagsKey = (flags: sqladmin.DatabaseFlagsList | undefined) =>
  JSON.stringify([...(flags ?? [])].map((flag) => `${flag.name ?? ""}=${flag.value ?? ""}`).sort());

const diskSizeOf = (value: string | number | undefined) => {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const primaryIp = (instance: sqladmin.DatabaseInstance) =>
  instance.ipAddresses?.find((item) => item.type === "PRIMARY")?.ipAddress;

const privateIp = (instance: sqladmin.DatabaseInstance) =>
  instance.ipAddresses?.find((item) => item.type === "PRIVATE")?.ipAddress;

/**
 * Normalize a network name, path, or self-link to
 * `projects/{projectId}/global/networks/{network}`. Cloud SQL rejects a
 * project number, which Service Networking paths carry, so a numeric
 * project is resolved to its id.
 */
const resolveNetworkPath = Effect.fn(function* (value: string | undefined, project: string) {
  if (value === undefined || value.length === 0) return undefined;
  const match = /projects\/([^/]+)\/global\/networks\/([^/]+)/.exec(value);
  if (!match) return `projects/${project}/global/networks/${lastSegment(value)}`;
  const [, owner, network] = match;
  if (!/^\d+$/.test(owner)) return `projects/${owner}/global/networks/${network}`;
  const resolved = yield* resourcemanager.getProjects({ name: `projects/${owner}` });
  return `projects/${resolved.projectId ?? project}/global/networks/${network}`;
});

/** `requireSsl` must pair with `sslMode` (only certificate-required, or SQL Server encrypted-only, is true). */
const requireSslOf = (sslMode: string, version: string) =>
  sslMode === "TRUSTED_CLIENT_CERTIFICATE_REQUIRED" ||
  (sslMode === "ENCRYPTED_ONLY" && version.toUpperCase().startsWith("SQLSERVER_"));

const toAttrs = (instance: sqladmin.DatabaseInstance, project: string, defaultRegion: string) => {
  const settings = instance.settings;
  return {
    instanceName: instance.name ?? "",
    project: instance.project ?? project,
    region: normalizeRegion(instance.region, defaultRegion),
    databaseVersion: instance.databaseVersion,
    databaseInstalledVersion: instance.databaseInstalledVersion,
    tier: settings?.tier,
    edition: settings?.edition,
    state: instance.state,
    labels: userLabels(settings?.userLabels),
    connectionName: instance.connectionName,
    gceZone: instance.gceZone ?? settings?.locationPreference?.zone,
    ipAddress: primaryIp(instance),
    privateIpAddress: privateIp(instance),
    ipv4Enabled: settings?.ipConfiguration?.ipv4Enabled !== false,
    privateNetwork: settings?.ipConfiguration?.privateNetwork,
    sslMode: settings?.ipConfiguration?.sslMode,
    deletionProtectionEnabled: settings?.deletionProtectionEnabled === true,
    activationPolicy: settings?.activationPolicy,
    availabilityType: settings?.availabilityType,
    dataDiskSizeGb: diskSizeOf(settings?.dataDiskSizeGb),
    backupEnabled: settings?.backupConfiguration?.enabled === true,
    retainedBackups: settings?.backupConfiguration?.backupRetentionSettings?.retainedBackups,
    transactionLogRetentionDays: settings?.backupConfiguration?.transactionLogRetentionDays,
    storageAutoResize: settings?.storageAutoResize === true,
    serviceAccountEmailAddress: instance.serviceAccountEmailAddress,
    selfLink: instance.selfLink,
    createTime: instance.createTime,
  };
};

const getByName = (project: string, instance: string) =>
  sqladmin
    .getInstances({ project, instance })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * Instance create, patch, and delete operations routinely run 5–15
 * minutes; poll every 10s for up to 20 minutes.
 */
const LONG_OPERATION_POLL = {
  times: 120,
  schedule: Schedule.spaced("10 seconds"),
};

const waitForOperation = (project: string, operation: sqladmin.Operation) =>
  waitForSqlOperation(project, operation, {
    budget: "30 minutes",
    notFoundOk: true,
  });

const waitUntilExists = (project: string, instanceName: string) =>
  getByName(project, instanceName).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(new InstanceNotResolved({ instanceName, project })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.InstanceNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilRunnable = (project: string, instanceName: string) =>
  getByName(project, instanceName).pipe(
    Effect.filterOrFail(
      (instance): instance is sqladmin.DatabaseInstance => instance !== undefined,
      () => new InstanceNotResolved({ instanceName, project }),
    ),
    Effect.filterOrFail(
      (instance) => {
        const state = instance.state ?? "SQL_INSTANCE_STATE_UNSPECIFIED";
        return state === "RUNNABLE" || state === "SUSPENDED";
      },
      (instance) => {
        const state = instance.state ?? "SQL_INSTANCE_STATE_UNSPECIFIED";
        return state === "FAILED"
          ? new InstanceFailed({ instanceName, state })
          : new InstanceNotReady({ instanceName, state });
      },
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.SQL.InstanceNotReady" || error._tag === "GCP.SQL.InstanceNotResolved",
      ...LONG_OPERATION_POLL,
    }),
  );

const waitUntilGone = (project: string, instanceName: string) =>
  getByName(project, instanceName).pipe(
    Effect.flatMap((instance) =>
      instance === undefined ? Effect.void : Effect.fail(new InstanceStillExists({ instanceName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.InstanceStillExists",
      ...LONG_OPERATION_POLL,
    }),
  );

const backupConfiguration = (
  enabled: boolean,
  version: string,
  backup: BackupSettings | undefined,
): sqladmin.BackupConfiguration => ({
  enabled,
  binaryLogEnabled: enabled && isMysql(version),
  pointInTimeRecoveryEnabled: enabled && isPostgres(version),
  backupRetentionSettings:
    backup?.retainedBackups !== undefined
      ? { retentionUnit: "COUNT", retainedBackups: backup.retainedBackups }
      : undefined,
  transactionLogRetentionDays: backup?.transactionLogRetentionDays,
  startTime: backup?.startTime,
});

const ipConfigurationOf = (
  ip: IpConfiguration | undefined,
  privateNetwork: string | undefined,
  version: string,
): sqladmin.IpConfiguration => ({
  ipv4Enabled: ip?.ipv4Enabled !== false,
  privateNetwork,
  allocatedIpRange: ip?.allocatedIpRange,
  sslMode: ip?.sslMode,
  requireSsl: ip?.sslMode !== undefined ? requireSslOf(ip.sslMode, version) : undefined,
});

const dataApiAccessOf = (enabled: boolean | undefined) => {
  if (enabled === true) return "ALLOW_DATA_API";
  if (enabled === false) return "DISALLOW_DATA_API";
  return undefined;
};

const insertBody = (
  news: InstanceProps,
  privateNetwork: string | undefined,
  instanceName: string,
  region: string,
  version: string,
  desiredLabels: Record<string, string>,
): sqladmin.DatabaseInstance => {
  const backupEnabled = news.backup?.enabled === true;
  return {
    name: instanceName,
    region,
    databaseVersion: version,
    rootPassword: news.rootPassword,
    settings: {
      tier: normalizeTier(news.tier),
      edition: normalizeEdition(news.edition),
      activationPolicy: normalizeActivation(news.activationPolicy),
      availabilityType: normalizeAvailability(news.availabilityType),
      dataDiskSizeGb: String(news.dataDiskSizeGb ?? DEFAULT_DISK_SIZE_GB),
      dataDiskType: normalizeDiskType(news.dataDiskType),
      deletionProtectionEnabled: news.deletionProtectionEnabled === true,
      userLabels: desiredLabels,
      storageAutoResize: news.storageAutoResize === true,
      ipConfiguration: ipConfigurationOf(news.ipConfiguration, privateNetwork, version),
      backupConfiguration: backupConfiguration(backupEnabled, version, news.backup),
      locationPreference: news.zone ? { zone: news.zone } : undefined,
      databaseFlags: news.databaseFlags,
      dataApiAccess: dataApiAccessOf(news.dataApiAccess),
    },
  };
};

const applyPatch = (project: string, instanceName: string, body: sqladmin.DatabaseInstance) =>
  sqladmin
    .patchInstances({
      project,
      instance: instanceName,
      body,
    })
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "Conflict",
        times: 8,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: [
      "instanceName",
      "project",
      "region",
      "databaseVersion",
      "connectionName",
      "selfLink",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousName = olds?.instanceName ?? output?.instanceName;
      const nextName = news.instanceName ?? previousName;
      const previousRegion = normalizeRegion(olds?.region ?? output?.region, env.region);
      const nextRegion = normalizeRegion(news.region ?? output?.region, env.region);
      const previousVersion = normalizeVersion(olds?.databaseVersion ?? output?.databaseVersion);
      const nextVersion = normalizeVersion(news.databaseVersion ?? output?.databaseVersion);

      const nameChanged =
        previousName !== undefined && nextName !== undefined && previousName !== nextName;
      const regionChanged = previousRegion !== nextRegion;
      const versionChanged = previousVersion !== nextVersion;

      if (!nameChanged && !regionChanged && !versionChanged) {
        return undefined;
      }
      if (!nameChanged && !regionChanged && engineOf(previousVersion) === engineOf(nextVersion)) {
        // Same-engine major version upgrades run in place via instances.patch.
        return {
          action: "update" as const,
          stables: [
            "instanceName",
            "project",
            "region",
            "connectionName",
            "selfLink",
            "createTime",
          ],
        };
      }
      return {
        action: "replace" as const,
        deleteFirst: !nameChanged,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceName = yield* toName(id, olds?.instanceName, output?.instanceName);
      const existing = yield* getByName(env.project, instanceName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.settings?.userLabels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* sqladmin.listInstances
          .items({
            project: env.project,
            maxResults: 1000,
          })
          .pipe(
            Stream.filter((instance) =>
              Object.keys(instance.settings?.userLabels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((instance) => toAttrs(instance, env.project, env.region)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceName = yield* toName(id, news.instanceName, output?.instanceName);
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const version = normalizeVersion(news.databaseVersion ?? output?.databaseVersion);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      const desiredPrivateNetwork = yield* resolveNetworkPath(
        news.ipConfiguration?.privateNetwork,
        env.project,
      );

      let current = yield* getByName(env.project, output?.instanceName ?? instanceName);

      if (current === undefined) {
        const created = yield* sqladmin
          .insertInstances({
            project: env.project,
            body: insertBody(
              news,
              desiredPrivateNetwork,
              instanceName,
              region,
              version,
              desiredLabels,
            ),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (created !== undefined) {
          yield* waitForOperation(env.project, created);
        }
        current = yield* waitUntilExists(env.project, instanceName);
      }

      if (current === undefined) {
        return yield* new InstanceNotResolved({
          instanceName,
          project: env.project,
        });
      }

      const state = current.state ?? "";
      if (state !== "RUNNABLE" && state !== "SUSPENDED") {
        current = yield* waitUntilRunnable(env.project, instanceName);
      }

      if (normalizeVersion(current.databaseVersion) !== version) {
        const upgraded = yield* applyPatch(env.project, instanceName, {
          databaseVersion: version,
        });
        // A major version upgrade outlasts the default budget even on
        // db-f1-micro (33–54 minutes observed for POSTGRES_16 → POSTGRES_17).
        yield* waitForSqlOperation(env.project, upgraded, { budget: "2 hours" });
        current = yield* waitUntilRunnable(env.project, instanceName);
      }

      const settings = current.settings;
      const observedLabels = tagRecord(settings?.userLabels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      const desiredTier = normalizeTier(news.tier ?? settings?.tier);
      const tierChanged =
        news.tier !== undefined && (settings?.tier ?? DEFAULT_TIER) !== desiredTier;

      const desiredEdition = normalizeEdition(news.edition ?? settings?.edition);
      const editionChanged =
        news.edition !== undefined &&
        (settings?.edition ?? DEFAULT_EDITION).toUpperCase() !== desiredEdition;

      const desiredActivation = normalizeActivation(
        news.activationPolicy ?? settings?.activationPolicy,
      );
      const activationChanged =
        news.activationPolicy !== undefined &&
        (settings?.activationPolicy ?? DEFAULT_ACTIVATION).toUpperCase() !== desiredActivation;

      const desiredAvailability = normalizeAvailability(
        news.availabilityType ?? settings?.availabilityType,
      );
      const availabilityChanged =
        news.availabilityType !== undefined &&
        (settings?.availabilityType ?? DEFAULT_AVAILABILITY).toUpperCase() !== desiredAvailability;

      const desiredProtection = news.deletionProtectionEnabled === true;
      const protectionChanged =
        (settings?.deletionProtectionEnabled === true) !== desiredProtection;

      const ip = news.ipConfiguration;
      const observedIp = settings?.ipConfiguration;
      const desiredSslMode = ip?.sslMode?.toUpperCase();
      const ipConfiguration: sqladmin.IpConfiguration = {
        ipv4Enabled:
          ip?.ipv4Enabled !== undefined && (observedIp?.ipv4Enabled !== false) !== ip.ipv4Enabled
            ? ip.ipv4Enabled
            : undefined,
        privateNetwork:
          desiredPrivateNetwork !== undefined &&
          /projects\/[^/]+\/global\/networks\/[^/]+/.exec(observedIp?.privateNetwork ?? "")?.[0] !==
            desiredPrivateNetwork
            ? desiredPrivateNetwork
            : undefined,
        allocatedIpRange:
          ip?.allocatedIpRange !== undefined && observedIp?.allocatedIpRange !== ip.allocatedIpRange
            ? ip.allocatedIpRange
            : undefined,
        ...(desiredSslMode !== undefined && observedIp?.sslMode !== desiredSslMode
          ? { sslMode: desiredSslMode, requireSsl: requireSslOf(desiredSslMode, version) }
          : {}),
      };
      const ipChanged = Object.values(ipConfiguration).some((value) => value !== undefined);

      const backup = news.backup;
      const observedBackup = settings?.backupConfiguration;
      const desiredBackup = backup?.enabled ?? observedBackup?.enabled === true;
      const backupChanged =
        (backup?.enabled !== undefined && (observedBackup?.enabled === true) !== desiredBackup) ||
        (backup?.retainedBackups !== undefined &&
          observedBackup?.backupRetentionSettings?.retainedBackups !== backup.retainedBackups) ||
        (backup?.transactionLogRetentionDays !== undefined &&
          observedBackup?.transactionLogRetentionDays !== backup.transactionLogRetentionDays) ||
        (backup?.startTime !== undefined && observedBackup?.startTime !== backup.startTime);

      const autoResizeChanged =
        news.storageAutoResize !== undefined &&
        (settings?.storageAutoResize === true) !== news.storageAutoResize;

      const desiredDisk = news.dataDiskSizeGb;
      const currentDisk = diskSizeOf(settings?.dataDiskSizeGb);
      const diskChanged =
        desiredDisk !== undefined && currentDisk !== undefined && desiredDisk > currentDisk;

      const desiredZone = news.zone;
      const zoneChanged =
        desiredZone !== undefined &&
        (current.gceZone ?? settings?.locationPreference?.zone) !== desiredZone;

      const flagsChanged =
        news.databaseFlags !== undefined &&
        flagsKey(settings?.databaseFlags) !== flagsKey(news.databaseFlags);

      const desiredDataApi = dataApiAccessOf(news.dataApiAccess);
      const dataApiChanged =
        desiredDataApi !== undefined &&
        (settings?.dataApiAccess ?? "DISALLOW_DATA_API") !== desiredDataApi;

      if (
        labelsChanged ||
        tierChanged ||
        editionChanged ||
        activationChanged ||
        availabilityChanged ||
        protectionChanged ||
        ipChanged ||
        backupChanged ||
        autoResizeChanged ||
        diskChanged ||
        zoneChanged ||
        flagsChanged ||
        dataApiChanged
      ) {
        const nextLabels: Record<string, string | null> = {
          ...desiredLabels,
        };
        for (const key of removed) {
          nextLabels[key] = null;
        }
        const patched = yield* applyPatch(env.project, instanceName, {
          settings: {
            settingsVersion: settings?.settingsVersion,
            userLabels: nextLabels as unknown as Record<string, string>,
            tier: desiredTier,
            edition: news.edition !== undefined ? desiredEdition : undefined,
            activationPolicy: news.activationPolicy !== undefined ? desiredActivation : undefined,
            availabilityType: news.availabilityType !== undefined ? desiredAvailability : undefined,
            deletionProtectionEnabled: desiredProtection,
            dataDiskSizeGb: diskChanged ? String(desiredDisk) : undefined,
            ipConfiguration: ipChanged ? ipConfiguration : undefined,
            backupConfiguration: backupChanged
              ? backupConfiguration(desiredBackup, version, backup)
              : undefined,
            storageAutoResize: autoResizeChanged ? news.storageAutoResize : undefined,
            locationPreference: zoneChanged ? { zone: desiredZone } : undefined,
            databaseFlags: news.databaseFlags !== undefined ? news.databaseFlags : undefined,
            dataApiAccess: desiredDataApi,
          },
        });
        yield* waitForOperation(env.project, patched);
        current = yield* waitUntilRunnable(env.project, instanceName);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output, force }) {
      const env = yield* GcpEnvironment.current;
      const instanceName = output.instanceName;
      const existing = yield* getByName(env.project, instanceName);
      if (existing === undefined) return;

      if (existing.settings?.deletionProtectionEnabled === true) {
        if (force !== true) {
          return yield* new InstanceDeletionProtected({ instanceName });
        }
        const patched = yield* applyPatch(env.project, instanceName, {
          settings: {
            settingsVersion: existing.settings.settingsVersion,
            deletionProtectionEnabled: false,
          },
        }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        if (patched !== undefined) {
          yield* waitForOperation(env.project, patched);
        }
      }

      const operation = yield* sqladmin
        .deleteInstances({
          project: env.project,
          instance: instanceName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.undefined),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(env.project, operation);
      }
      yield* waitUntilGone(env.project, instanceName);
    }),
  });
