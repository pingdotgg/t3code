import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  expandParent,
  fieldMask,
  fingerprint,
  gibOf,
  lastSegment,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const DEFAULT_PROTOCOL: netapp.VolumeProtocolsItemEnum = "NFSV3";
const DEFAULT_CAPACITY_GIB = 100;

export type ExportPolicyRule = {
  /** Access type (`READ_ONLY`, `READ_WRITE`, `READ_NONE`). */
  accessType?: netapp.SimpleExportPolicyRuleAccessTypeEnum | (string & {});
  /** Squash mode. Takes precedence over `hasRootAccess`. */
  squashMode?: netapp.SimpleExportPolicyRuleSquashModeEnum | (string & {});
  /** Comma-separated allowed client IPs or CIDRs. */
  allowedClients?: string;
  /** Enable NFSv3. */
  nfsv3?: boolean;
  /** Enable NFSv4. */
  nfsv4?: boolean;
  /** Unix root access (`true` / `false`). */
  hasRootAccess?: string;
  /** Anonymous user id when squash is ROOT_SQUASH or ALL_SQUASH. */
  anonUid?: string;
  kerberos5ReadOnly?: boolean;
  kerberos5ReadWrite?: boolean;
  kerberos5iReadOnly?: boolean;
  kerberos5iReadWrite?: boolean;
  kerberos5pReadOnly?: boolean;
  kerberos5pReadWrite?: boolean;
};

export type ExportPolicy = {
  /** Export policy rules. */
  rules?: ExportPolicyRule[];
};

export type SnapshotSchedule = {
  snapshotsToKeep?: number;
  minute?: number;
  hour?: number;
  day?: string;
  daysOfMonth?: string;
};

export type SnapshotPolicy = {
  enabled?: boolean;
  hourlySchedule?: SnapshotSchedule;
  dailySchedule?: SnapshotSchedule;
  weeklySchedule?: SnapshotSchedule;
  monthlySchedule?: SnapshotSchedule;
};

export type BackupConfig = {
  /** Backup vault name or id. */
  backupVault?: string;
  /** Backup policy names. */
  backupPolicies?: string[];
  /** Enable scheduled backups. */
  scheduledBackupEnabled?: boolean;
};

export type TieringPolicy = {
  tierAction?: netapp.TieringPolicyTierActionEnum | (string & {});
  coolingThresholdDays?: number;
  hotTierBypassModeEnabled?: boolean;
};

export type RestoreParameters = {
  sourceSnapshot?: string;
  sourceBackup?: string;
};

export type BlockDevice = {
  osType?: netapp.BlockDeviceOsTypeEnum | (string & {});
  name?: string;
  sizeGib?: number | string;
  hostGroups?: string[];
};

export type VolumeProps = {
  /**
   * Volume id (the `{volume}` segment of
   * `projects/{project}/locations/{location}/volumes/{volume}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the volume.
   */
  volumeId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the volume. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Storage pool name or id. Immutable — changing it replaces the volume.
   */
  storagePool: string;
  /**
   * NFS/SMB share name. Defaults to the volume id. Immutable — changing
   * it replaces the volume.
   */
  shareName?: string;
  /**
   * Protocols. Immutable — changing them replaces the volume.
   * @default ["NFSV3"]
   */
  protocols?: Array<netapp.VolumeProtocolsItemEnum | (string & {})>;
  /**
   * Capacity in GiB.
   * @default 100
   */
  capacityGib?: number | string;
  /**
   * Unix permissions on the mount point (NFS).
   */
  unixPermissions?: string;
  /**
   * Security style. Immutable — changing it replaces the volume.
   */
  securityStyle?: netapp.VolumeSecurityStyleEnum | (string & {});
  /**
   * Percentage of capacity reserved for snapshots.
   */
  snapReserve?: number;
  /**
   * Expose a read-only `.snapshot` directory.
   */
  snapshotDirectory?: boolean;
  /**
   * Throughput in MiB/s.
   */
  throughputMibps?: number;
  /**
   * Enable Kerberos. Immutable — changing it replaces the volume.
   */
  kerberosEnabled?: boolean;
  /**
   * SMB share settings.
   */
  smbSettings?: Array<netapp.VolumeSmbSettingsItemEnum | (string & {})>;
  /**
   * Restricted actions (`DELETE`, …).
   */
  restrictedActions?: Array<
    netapp.VolumeRestrictedActionsItemEnum | (string & {})
  >;
  /**
   * NFS export policy.
   */
  exportPolicy?: ExportPolicy;
  /**
   * Snapshot schedule.
   */
  snapshotPolicy?: SnapshotPolicy;
  /**
   * Backup configuration.
   */
  backupConfig?: BackupConfig;
  /**
   * Auto-tiering policy.
   */
  tieringPolicy?: TieringPolicy;
  /**
   * Restore from a snapshot or backup. Immutable.
   */
  restoreParameters?: RestoreParameters;
  /**
   * Block devices (unified pools). Currently one device per volume.
   */
  blockDevices?: BlockDevice[];
  /**
   * Large-capacity volume (legacy FILE pools). Immutable.
   */
  largeCapacity?: boolean;
  /**
   * Large-capacity constituent config (unified pools). Immutable.
   */
  largeCapacityConfig?: { constituentCount?: number };
  /**
   * One IP per node for large-capacity volumes. Immutable.
   */
  multipleEndpoints?: boolean;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MountOption = {
  export: string | undefined;
  exportFull: string | undefined;
  protocol: string | undefined;
  instructions: string | undefined;
  ipAddress: string | undefined;
};

export type Volume = Resource<
  "GCP.NetApp.Volume",
  VolumeProps,
  {
    /** Full resource name. */
    name: string;
    /** Volume id (last path segment). */
    volumeId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Storage pool name. */
    storagePool: string | undefined;
    /** Share name. */
    shareName: string | undefined;
    /** Protocols. */
    protocols: string[];
    /** Capacity in GiB. */
    capacityGib: string | undefined;
    /** Used capacity in GiB. */
    usedGib: string | undefined;
    /** VPC network path. */
    network: string | undefined;
    /** Service level inherited from the pool. */
    serviceLevel: string | undefined;
    /** Unix permissions. */
    unixPermissions: string | undefined;
    /** Security style. */
    securityStyle: string | undefined;
    /** Snapshot reserve percent. */
    snapReserve: number | undefined;
    /** Whether `.snapshot` is exposed. */
    snapshotDirectory: boolean | undefined;
    /** Throughput in MiB/s. */
    throughputMibps: number | undefined;
    /** Whether Kerberos is enabled. */
    kerberosEnabled: boolean | undefined;
    /** SMB settings. */
    smbSettings: string[];
    /** Restricted actions. */
    restrictedActions: string[];
    /** Export policy. */
    exportPolicy: ExportPolicy | undefined;
    /** Snapshot policy. */
    snapshotPolicy: SnapshotPolicy | undefined;
    /** Backup configuration. */
    backupConfig: BackupConfig | undefined;
    /** Tiering policy. */
    tieringPolicy: TieringPolicy | undefined;
    /** Mount options. */
    mountOptions: MountOption[];
    /** Active zone. */
    zone: string | undefined;
    /** Replica zone. */
    replicaZone: string | undefined;
    /** KMS config name. */
    kmsConfig: string | undefined;
    /** Active Directory name. */
    activeDirectory: string | undefined;
    /** Whether NFS LDAP is enabled. */
    ldapEnabled: boolean | undefined;
    /** Whether the volume is in a replication. */
    hasReplication: boolean | undefined;
    /** Encryption key source. */
    encryptionType: string | undefined;
    /** Cold-tier usage in GiB. */
    coldTierSizeGib: string | undefined;
    /** Hot-tier usage in GiB. */
    hotTierSizeUsedGib: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** State details. */
    stateDetails: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes file or block volume hosted in a storage pool.
 *
 * Changing `volumeId`, `location`, `storagePool`, `shareName`,
 * `protocols`, `securityStyle`, `kerberosEnabled`, `restoreParameters`,
 * or large-capacity flags replaces the volume. Capacity, export policy,
 * snapshots, backups, description, and labels update in place.
 *
 * ### Creating a Volume
 * **Example:** NFS volume
 * ```typescript
 * const volume = yield* GCP.NetApp.Volume("Share", {
 *   storagePool: pool.name,
 *   protocols: ["NFSV3"],
 *   capacityGib: 100,
 * });
 * ```
 *
 * **Example:** Explicit share name and export policy
 * ```typescript
 * const volume = yield* GCP.NetApp.Volume("Share", {
 *   storagePool: pool.name,
 *   shareName: "app",
 *   protocols: ["NFSV3"],
 *   capacityGib: 200,
 *   unixPermissions: "0770",
 *   exportPolicy: {
 *     rules: [{ allowedClients: "10.0.0.0/24", accessType: "READ_WRITE" }],
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Volume
 * **Example:** Capacity and labels
 * ```typescript
 * const volume = yield* GCP.NetApp.Volume("Share", {
 *   storagePool: pool.name,
 *   capacityGib: 300,
 *   description: "app share v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const Volume = Resource<Volume>("GCP.NetApp.Volume");

const resourceName = (project: string, location: string, volumeId: string) =>
  `projects/${project}/locations/${location}/volumes/${volumeId}`;

const toBackupConfig = (
  config: netapp.BackupConfig | undefined,
): BackupConfig | undefined =>
  config === undefined
    ? undefined
    : {
        backupVault: config.backupVault,
        backupPolicies: config.backupPolicies,
        scheduledBackupEnabled: config.scheduledBackupEnabled,
      };

const toExportPolicy = (
  policy: netapp.ExportPolicy | undefined,
): ExportPolicy | undefined =>
  policy === undefined
    ? undefined
    : {
        rules: policy.rules?.map((rule) => ({
          accessType: rule.accessType,
          squashMode: rule.squashMode,
          allowedClients: rule.allowedClients,
          nfsv3: rule.nfsv3,
          nfsv4: rule.nfsv4,
          hasRootAccess: rule.hasRootAccess,
          anonUid: rule.anonUid,
          kerberos5ReadOnly: rule.kerberos5ReadOnly,
          kerberos5ReadWrite: rule.kerberos5ReadWrite,
          kerberos5iReadOnly: rule.kerberos5iReadOnly,
          kerberos5iReadWrite: rule.kerberos5iReadWrite,
          kerberos5pReadOnly: rule.kerberos5pReadOnly,
          kerberos5pReadWrite: rule.kerberos5pReadWrite,
        })),
      };

const toSnapshotPolicy = (
  policy: netapp.SnapshotPolicy | undefined,
): SnapshotPolicy | undefined =>
  policy === undefined
    ? undefined
    : {
        enabled: policy.enabled,
        hourlySchedule: policy.hourlySchedule,
        dailySchedule: policy.dailySchedule,
        weeklySchedule: policy.weeklySchedule,
        monthlySchedule: policy.monthlySchedule,
      };

const toTieringPolicy = (
  policy: netapp.TieringPolicy | undefined,
): TieringPolicy | undefined =>
  policy === undefined
    ? undefined
    : {
        tierAction: policy.tierAction,
        coolingThresholdDays: policy.coolingThresholdDays,
        hotTierBypassModeEnabled: policy.hotTierBypassModeEnabled,
      };

const toAttrs = (item: netapp.Volume, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "volumes", region);
  return {
    name,
    volumeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    storagePool: item.storagePool,
    shareName: item.shareName,
    protocols: item.protocols ?? [],
    capacityGib: item.capacityGib,
    usedGib: item.usedGib,
    network: item.network,
    serviceLevel: item.serviceLevel,
    unixPermissions: item.unixPermissions,
    securityStyle: item.securityStyle,
    snapReserve: item.snapReserve,
    snapshotDirectory: item.snapshotDirectory,
    throughputMibps: item.throughputMibps,
    kerberosEnabled: item.kerberosEnabled,
    smbSettings: item.smbSettings ?? [],
    restrictedActions: item.restrictedActions ?? [],
    exportPolicy: toExportPolicy(item.exportPolicy),
    snapshotPolicy: toSnapshotPolicy(item.snapshotPolicy),
    backupConfig: toBackupConfig(item.backupConfig),
    tieringPolicy: toTieringPolicy(item.tieringPolicy),
    mountOptions: (item.mountOptions ?? []).map((option) => ({
      export: option.export,
      exportFull: option.exportFull,
      protocol: option.protocol,
      instructions: option.instructions,
      ipAddress: option.ipAddress,
    })),
    zone: item.zone,
    replicaZone: item.replicaZone,
    kmsConfig: item.kmsConfig,
    activeDirectory: item.activeDirectory,
    ldapEnabled: item.ldapEnabled,
    hasReplication: item.hasReplication,
    encryptionType: item.encryptionType,
    coldTierSizeGib: item.coldTierSizeGib,
    hotTierSizeUsedGib: item.hotTierSizeUsedGib,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    stateDetails: item.stateDetails,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  netapp
    .getProjectsLocationsVolumes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsVolumes.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.volumes,
      (item) => item.labels,
    ),
  );

const desiredBackupConfig = (
  project: string,
  location: string,
  config: BackupConfig | undefined,
): netapp.BackupConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    backupVault:
      config.backupVault === undefined
        ? undefined
        : expandParent(config.backupVault, project, location, "backupVaults"),
    backupPolicies: config.backupPolicies?.map((policy) =>
      expandParent(policy, project, location, "backupPolicies"),
    ),
    scheduledBackupEnabled: config.scheduledBackupEnabled,
  };
};

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    stables: ["name", "volumeId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousPool = olds?.storagePool ?? output?.storagePool;
      const previousShare = olds?.shareName ?? output?.shareName;
      const previousProtocols = olds?.protocols ?? output?.protocols;
      const previousStyle = olds?.securityStyle ?? output?.securityStyle;
      const previousKerberos = olds?.kerberosEnabled ?? output?.kerberosEnabled;
      const nextProtocols = news.protocols ?? [DEFAULT_PROTOCOL];
      return replaceOnIdentity({
        previousId: olds?.volumeId ?? output?.volumeId,
        nextId: news.volumeId ?? olds?.volumeId ?? output?.volumeId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousPool !== undefined &&
            news.storagePool !== previousPool &&
            !previousPool.endsWith(`/${news.storagePool}`)) ||
          (previousShare !== undefined &&
            news.shareName !== undefined &&
            news.shareName !== previousShare) ||
          (previousProtocols !== undefined &&
            !sameStringList(previousProtocols, nextProtocols)) ||
          (previousStyle !== undefined &&
            news.securityStyle !== undefined &&
            news.securityStyle !== previousStyle) ||
          (previousKerberos !== undefined &&
            news.kerberosEnabled !== undefined &&
            news.kerberosEnabled !== previousKerberos) ||
          (olds?.restoreParameters !== undefined &&
            news.restoreParameters !== undefined &&
            fingerprint(olds.restoreParameters) !==
              fingerprint(news.restoreParameters)) ||
          (olds?.largeCapacity !== undefined &&
            news.largeCapacity !== undefined &&
            news.largeCapacity !== olds.largeCapacity) ||
          (olds?.multipleEndpoints !== undefined &&
            news.multipleEndpoints !== undefined &&
            news.multipleEndpoints !== olds.multipleEndpoints),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const volumeId = yield* toPhysicalId(
        id,
        olds?.volumeId,
        output?.volumeId,
        "volume",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, volumeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const volumeId = yield* toPhysicalId(
        id,
        news.volumeId,
        output?.volumeId,
        "volume",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, volumeId);
      // Volumes reference their pool by id; a full resource name is rejected
      // with `BadRequest: specified storage pool not found`.
      const storagePool = lastSegment(news.storagePool);
      const shareName = news.shareName ?? volumeId;
      const protocols = news.protocols ?? [DEFAULT_PROTOCOL];
      const capacityGib = gibOf(news.capacityGib ?? DEFAULT_CAPACITY_GIB);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const backupConfig = desiredBackupConfig(
        env.project,
        location,
        news.backupConfig,
      );
      const blockDevices = news.blockDevices?.map((device) => ({
        osType: device.osType,
        name: device.name,
        sizeGib: gibOf(device.sizeGib),
        hostGroups: device.hostGroups?.map((group) =>
          expandParent(group, env.project, location, "hostGroups"),
        ),
      }));

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsVolumes({
            parent: parentOf(env.project, location),
            volumeId,
            body: {
              storagePool,
              shareName,
              protocols,
              capacityGib,
              unixPermissions: news.unixPermissions,
              securityStyle: news.securityStyle,
              snapReserve: news.snapReserve,
              snapshotDirectory: news.snapshotDirectory,
              throughputMibps: news.throughputMibps,
              kerberosEnabled: news.kerberosEnabled,
              smbSettings: news.smbSettings,
              restrictedActions: news.restrictedActions,
              exportPolicy: news.exportPolicy,
              snapshotPolicy: news.snapshotPolicy,
              backupConfig,
              tieringPolicy: news.tieringPolicy,
              restoreParameters: news.restoreParameters,
              blockDevices,
              largeCapacity: news.largeCapacity,
              largeCapacityConfig: news.largeCapacityConfig,
              multipleEndpoints: news.multipleEndpoints,
              description: news.description,
              labels: desiredLabels,
            },
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

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
        (item) => item.stateDetails,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.description ?? "") !== (news.description ?? "") &&
          "description",
        (current.capacityGib ?? "") !== (capacityGib ?? "") && "capacityGib",
        news.unixPermissions !== undefined &&
          (current.unixPermissions ?? "") !== news.unixPermissions &&
          "unixPermissions",
        news.snapReserve !== undefined &&
          (current.snapReserve ?? 0) !== news.snapReserve &&
          "snapReserve",
        news.snapshotDirectory !== undefined &&
          (current.snapshotDirectory ?? false) !== news.snapshotDirectory &&
          "snapshotDirectory",
        news.throughputMibps !== undefined &&
          (current.throughputMibps ?? 0) !== news.throughputMibps &&
          "throughputMibps",
        news.smbSettings !== undefined &&
          !sameStringList(current.smbSettings, news.smbSettings) &&
          "smbSettings",
        news.restrictedActions !== undefined &&
          !sameStringList(current.restrictedActions, news.restrictedActions) &&
          "restrictedActions",
        news.exportPolicy !== undefined &&
          fingerprint(toExportPolicy(current.exportPolicy)) !==
            fingerprint(news.exportPolicy) &&
          "exportPolicy",
        news.snapshotPolicy !== undefined &&
          fingerprint(toSnapshotPolicy(current.snapshotPolicy)) !==
            fingerprint(news.snapshotPolicy) &&
          "snapshotPolicy",
        news.backupConfig !== undefined &&
          fingerprint(toBackupConfig(current.backupConfig)) !==
            fingerprint(backupConfig) &&
          "backupConfig",
        news.tieringPolicy !== undefined &&
          fingerprint(toTieringPolicy(current.tieringPolicy)) !==
            fingerprint(news.tieringPolicy) &&
          "tieringPolicy",
        news.blockDevices !== undefined &&
          fingerprint(current.blockDevices) !== fingerprint(blockDevices) &&
          "blockDevices",
      ]);

      if (mask.length > 0) {
        const operation = yield* netapp.patchProjectsLocationsVolumes({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
            capacityGib,
            unixPermissions: news.unixPermissions,
            snapReserve: news.snapReserve,
            snapshotDirectory: news.snapshotDirectory,
            throughputMibps: news.throughputMibps,
            smbSettings: news.smbSettings,
            restrictedActions: news.restrictedActions,
            exportPolicy: news.exportPolicy,
            snapshotPolicy: news.snapshotPolicy,
            backupConfig,
            tieringPolicy: news.tieringPolicy,
            blockDevices,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateDetails,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* netapp
        .deleteProjectsLocationsVolumes({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
