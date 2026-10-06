import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
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
   * Immutable — changing it replaces the instance.
   * @default "MYSQL_8_0"
   */
  databaseVersion?:
    | sqladmin.DatabaseInstanceDatabaseVersionEnum
    | (string & {});
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
   * Assign a public IPv4 address.
   * @default true
   */
  ipv4Enabled?: boolean;
  /**
   * Enable automated backups. MySQL also enables binary logs when true.
   * @default false
   */
  backupEnabled?: boolean;
  /**
   * Protect against accidental instance deletion. Disabled automatically
   * on destroy.
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
    /** Whether public IPv4 is enabled. */
    ipv4Enabled: boolean;
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
 * Changing `instanceName`, `region`, or `databaseVersion` replaces the
 * instance. Provisioning typically takes several minutes (often 5–15).
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
 *   backupEnabled: false,
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
 * @resource
 * @category SQL
 */
export const Instance = Resource<Instance>("GCP.SQL.Instance");

export class InstanceNotResolved extends Data.TaggedError(
  "GCP.SQL.InstanceNotResolved",
)<{
  instanceName: string;
  project: string;
}> {}

export class InstanceNotReady extends Data.TaggedError(
  "GCP.SQL.InstanceNotReady",
)<{
  instanceName: string;
  state: string;
}> {}

export class InstanceFailed extends Data.TaggedError("GCP.SQL.InstanceFailed")<{
  instanceName: string;
  state: string;
}> {}

export class InstanceStillExists extends Data.TaggedError(
  "GCP.SQL.InstanceStillExists",
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

const normalizeTier = (tier: string | undefined) => tier ?? DEFAULT_TIER;

const normalizeEdition = (edition: string | undefined) =>
  (edition ?? DEFAULT_EDITION).toUpperCase();

const normalizeAvailability = (value: string | undefined) =>
  (value ?? DEFAULT_AVAILABILITY).toUpperCase();

const normalizeActivation = (value: string | undefined) =>
  (value ?? DEFAULT_ACTIVATION).toUpperCase();

const normalizeDiskType = (value: string | undefined) =>
  (value ?? DEFAULT_DISK_TYPE).toUpperCase();

const isMysql = (version: string) => version.toUpperCase().startsWith("MYSQL_");

const isPostgres = (version: string) =>
  version.toUpperCase().startsWith("POSTGRES_");

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
  JSON.stringify(
    [...(flags ?? [])]
      .map((flag) => `${flag.name ?? ""}=${flag.value ?? ""}`)
      .sort(),
  );

const diskSizeOf = (value: string | number | undefined) => {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const primaryIp = (instance: sqladmin.DatabaseInstance) =>
  instance.ipAddresses?.find((item) => item.type === "PRIMARY")?.ipAddress ??
  instance.ipAddresses?.[0]?.ipAddress;

const toAttrs = (
  instance: sqladmin.DatabaseInstance,
  project: string,
  defaultRegion: string,
) => {
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
    ipv4Enabled: settings?.ipConfiguration?.ipv4Enabled !== false,
    deletionProtectionEnabled: settings?.deletionProtectionEnabled === true,
    activationPolicy: settings?.activationPolicy,
    availabilityType: settings?.availabilityType,
    dataDiskSizeGb: diskSizeOf(settings?.dataDiskSizeGb),
    backupEnabled: settings?.backupConfiguration?.enabled === true,
    serviceAccountEmailAddress: instance.serviceAccountEmailAddress,
    selfLink: instance.selfLink,
    createTime: instance.createTime,
  };
};

const getByName = (project: string, instance: string) =>
  sqladmin
    .getInstances({ project, instance })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Instance create, patch, and delete operations routinely run 5–15
 * minutes; poll every 10s for up to 20 minutes.
 */
const LONG_OPERATION_POLL = {
  times: 120,
  schedule: Schedule.spaced("10 seconds"),
};

const waitForOperation = (
  project: string,
  operation: sqladmin.Operation,
  options?: { notFoundOk?: boolean },
) =>
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
      (instance): instance is sqladmin.DatabaseInstance =>
        instance !== undefined,
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
        error._tag === "GCP.SQL.InstanceNotReady" ||
        error._tag === "GCP.SQL.InstanceNotResolved",
      ...LONG_OPERATION_POLL,
    }),
  );

const waitUntilGone = (project: string, instanceName: string) =>
  getByName(project, instanceName).pipe(
    Effect.flatMap((instance) =>
      instance === undefined
        ? Effect.void
        : Effect.fail(new InstanceStillExists({ instanceName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.InstanceStillExists",
      ...LONG_OPERATION_POLL,
    }),
  );

const backupConfiguration = (
  enabled: boolean,
  version: string,
): sqladmin.BackupConfiguration => ({
  enabled,
  binaryLogEnabled: enabled && isMysql(version),
  pointInTimeRecoveryEnabled: enabled && isPostgres(version),
});

const dataApiAccessOf = (enabled: boolean | undefined) => {
  if (enabled === true) return "ALLOW_DATA_API";
  if (enabled === false) return "DISALLOW_DATA_API";
  return undefined;
};

const insertBody = (
  news: InstanceProps,
  instanceName: string,
  region: string,
  version: string,
  desiredLabels: Record<string, string>,
): sqladmin.DatabaseInstance => {
  const backupEnabled = news.backupEnabled === true;
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
      storageAutoResize: false,
      ipConfiguration: {
        ipv4Enabled: news.ipv4Enabled !== false,
      },
      backupConfiguration: backupConfiguration(backupEnabled, version),
      locationPreference: news.zone ? { zone: news.zone } : undefined,
      databaseFlags: news.databaseFlags,
      dataApiAccess: dataApiAccessOf(news.dataApiAccess),
    },
  };
};

const applyPatch = (
  project: string,
  instanceName: string,
  body: sqladmin.DatabaseInstance,
) =>
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
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const previousVersion = normalizeVersion(
        olds?.databaseVersion ?? output?.databaseVersion,
      );
      const nextVersion = normalizeVersion(
        news.databaseVersion ?? output?.databaseVersion,
      );

      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const regionChanged = previousRegion !== nextRegion;
      const versionChanged = previousVersion !== nextVersion;

      if (!nameChanged && !regionChanged && !versionChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst: !nameChanged,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceName = yield* toName(
        id,
        olds?.instanceName,
        output?.instanceName,
      );
      const existing = yield* getByName(env.project, instanceName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(
        id,
        tagRecord(existing.settings?.userLabels),
      ))
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
            Stream.map((instance) =>
              toAttrs(instance, env.project, env.region),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceName = yield* toName(
        id,
        news.instanceName,
        output?.instanceName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const version = normalizeVersion(
        news.databaseVersion ?? output?.databaseVersion,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(
        env.project,
        output?.instanceName ?? instanceName,
      );

      if (current === undefined) {
        const created = yield* sqladmin
          .insertInstances({
            project: env.project,
            body: insertBody(
              news,
              instanceName,
              region,
              version,
              desiredLabels,
            ),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
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

      const settings = current.settings;
      const observedLabels = tagRecord(settings?.userLabels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      const desiredTier = normalizeTier(news.tier ?? settings?.tier);
      const tierChanged =
        news.tier !== undefined &&
        (settings?.tier ?? DEFAULT_TIER) !== desiredTier;

      const desiredEdition = normalizeEdition(
        news.edition ?? settings?.edition,
      );
      const editionChanged =
        news.edition !== undefined &&
        (settings?.edition ?? DEFAULT_EDITION).toUpperCase() !== desiredEdition;

      const desiredActivation = normalizeActivation(
        news.activationPolicy ?? settings?.activationPolicy,
      );
      const activationChanged =
        news.activationPolicy !== undefined &&
        (settings?.activationPolicy ?? DEFAULT_ACTIVATION).toUpperCase() !==
          desiredActivation;

      const desiredAvailability = normalizeAvailability(
        news.availabilityType ?? settings?.availabilityType,
      );
      const availabilityChanged =
        news.availabilityType !== undefined &&
        (settings?.availabilityType ?? DEFAULT_AVAILABILITY).toUpperCase() !==
          desiredAvailability;

      const desiredProtection = news.deletionProtectionEnabled === true;
      const protectionChanged =
        (settings?.deletionProtectionEnabled === true) !== desiredProtection;

      const desiredIpv4 = news.ipv4Enabled !== false;
      const ipv4Changed =
        news.ipv4Enabled !== undefined &&
        (settings?.ipConfiguration?.ipv4Enabled !== false) !== desiredIpv4;

      const desiredBackup = news.backupEnabled === true;
      const backupChanged =
        news.backupEnabled !== undefined &&
        (settings?.backupConfiguration?.enabled === true) !== desiredBackup;

      const desiredDisk = news.dataDiskSizeGb;
      const currentDisk = diskSizeOf(settings?.dataDiskSizeGb);
      const diskChanged =
        desiredDisk !== undefined &&
        currentDisk !== undefined &&
        desiredDisk > currentDisk;

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
        ipv4Changed ||
        backupChanged ||
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
            activationPolicy:
              news.activationPolicy !== undefined
                ? desiredActivation
                : undefined,
            availabilityType:
              news.availabilityType !== undefined
                ? desiredAvailability
                : undefined,
            deletionProtectionEnabled: desiredProtection,
            dataDiskSizeGb: diskChanged ? String(desiredDisk) : undefined,
            ipConfiguration: ipv4Changed
              ? { ipv4Enabled: desiredIpv4 }
              : undefined,
            backupConfiguration: backupChanged
              ? backupConfiguration(desiredBackup, version)
              : undefined,
            locationPreference: zoneChanged ? { zone: desiredZone } : undefined,
            databaseFlags:
              news.databaseFlags !== undefined ? news.databaseFlags : undefined,
            dataApiAccess: desiredDataApi,
          },
        });
        yield* waitForOperation(env.project, patched);
        current = yield* waitUntilRunnable(env.project, instanceName);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const instanceName = output.instanceName;
      const existing = yield* getByName(env.project, instanceName);
      if (existing === undefined) return;

      if (existing.settings?.deletionProtectionEnabled === true) {
        const patched = yield* applyPatch(env.project, instanceName, {
          settings: {
            settingsVersion: existing.settings.settingsVersion,
            deletionProtectionEnabled: false,
          },
        }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (patched !== undefined) {
          yield* waitForOperation(env.project, patched, { notFoundOk: true });
        }
      }

      const operation = yield* sqladmin
        .deleteInstances({
          project: env.project,
          instance: instanceName,
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
        yield* waitForOperation(env.project, operation, { notFoundOk: true });
      }
      yield* waitUntilGone(env.project, instanceName);
    }),
  });
