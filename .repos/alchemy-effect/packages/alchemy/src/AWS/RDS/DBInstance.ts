import * as rds from "@distilled.cloud/aws/rds";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { toWireDays, toWireSeconds } from "../../Util/Duration.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";

export interface DBInstanceProps {
  /**
   * Instance identifier. If omitted, Alchemy generates one.
   */
  dbInstanceIdentifier?: string;
  /**
   * Aurora cluster the instance belongs to. When set, the instance is a
   * cluster member and most storage/backup props are managed by the cluster.
   * Replacing this forces a new instance.
   */
  dbClusterIdentifier?: string;
  /**
   * Instance class such as `db.serverless` or `db.t3.micro`.
   */
  dbInstanceClass: string;
  /**
   * Database engine, e.g. `mysql`, `postgres`, `aurora-postgresql`.
   * Changing the engine forces replacement.
   */
  engine: string;
  /**
   * Optional engine version. Changed in place via `modifyDBInstance`.
   */
  engineVersion?: string;
  /**
   * Standalone (non-Aurora) database name created with the instance.
   * Immutable — forces replacement.
   */
  dbName?: string;
  /**
   * Allocated storage in GiB (standalone instances). In-place modify.
   * @default undefined
   */
  allocatedStorage?: number;
  /**
   * Upper limit (GiB) for storage autoscaling. In-place modify.
   */
  maxAllocatedStorage?: number;
  /**
   * Storage type: `gp2` | `gp3` | `io1` | `io2` | `standard`. In-place modify.
   */
  storageType?: string;
  /**
   * Provisioned IOPS (io1/io2/gp3). In-place modify (rate-limited by AWS).
   */
  iops?: number;
  /**
   * Storage throughput in MiBps (gp3). In-place modify.
   */
  storageThroughput?: number;
  /**
   * Master username (standalone instances). Immutable — forces replacement.
   */
  masterUsername?: string;
  /**
   * Master password (standalone instances). In-place modify.
   */
  masterUserPassword?: Redacted.Redacted<string>;
  /**
   * Let RDS manage the master user password in Secrets Manager.
   */
  manageMasterUserPassword?: boolean;
  /**
   * Rotate the managed master user password on the next reconcile.
   */
  rotateMasterUserPassword?: boolean;
  /**
   * KMS key used to encrypt the managed master user secret.
   */
  masterUserSecretKmsKeyId?: string;
  /**
   * Listener port. In-place modify (sent as `DBPortNumber` on modify).
   */
  port?: number;
  /**
   * Multi-AZ deployment (standalone instances). In-place modify.
   */
  multiAZ?: boolean;
  /**
   * Availability zone (standalone single-AZ). Immutable — forces replacement.
   */
  availabilityZone?: string;
  /**
   * Backup retention period (e.g. `"7 days"` or `Duration.days(7)`).
   * Sent to the API in whole days. In-place modify.
   */
  backupRetentionPeriod?: Duration.Input;
  /**
   * Daily backup window, e.g. `07:00-09:00`. In-place modify.
   */
  preferredBackupWindow?: string;
  /**
   * Weekly maintenance window, e.g. `Mon:00:00-Mon:03:00`. In-place modify.
   */
  preferredMaintenanceWindow?: string;
  /**
   * Optional DB subnet group. Effectively immutable for an in-VPC instance.
   */
  dbSubnetGroupName?: string;
  /**
   * Optional DB parameter group. In-place modify.
   */
  dbParameterGroupName?: string;
  /**
   * VPC security groups attached to the instance. In-place modify.
   * Ignored for Aurora cluster members (`dbClusterIdentifier` set) — security
   * groups are managed on the DB cluster instead.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Option group (MySQL/Oracle/SQL Server). In-place modify.
   */
  optionGroupName?: string;
  /**
   * License model, e.g. `license-included` | `bring-your-own-license`.
   */
  licenseModel?: string;
  /**
   * Whether storage is encrypted. Immutable — forces replacement.
   */
  storageEncrypted?: boolean;
  /**
   * KMS key for storage encryption. Immutable — forces replacement.
   */
  kmsKeyId?: string;
  /**
   * CA certificate identifier. In-place modify.
   */
  caCertificateIdentifier?: string;
  /**
   * Enable IAM database authentication. In-place modify.
   */
  enableIAMDatabaseAuthentication?: boolean;
  /**
   * Enable Performance Insights. In-place modify.
   */
  enablePerformanceInsights?: boolean;
  /**
   * KMS key for Performance Insights. In-place modify.
   */
  performanceInsightsKMSKeyId?: string;
  /**
   * Performance Insights retention (e.g. `"7 days"`). Sent to the API in
   * whole days (valid: 7, 731, or month multiples).
   */
  performanceInsightsRetentionPeriod?: Duration.Input;
  /**
   * Enhanced-monitoring granularity (e.g. `"60 seconds"`). Sent to the API
   * in whole seconds (valid: 0, 1, 5, 10, 15, 30, 60).
   */
  monitoringInterval?: Duration.Input;
  /**
   * IAM role ARN for enhanced monitoring. In-place modify.
   */
  monitoringRoleArn?: string;
  /**
   * Log types to export to CloudWatch Logs. Diffed against observed state and
   * applied via the delta-shaped `CloudwatchLogsExportConfiguration` on modify.
   */
  enableCloudwatchLogsExports?: string[];
  /**
   * Block accidental deletion. In-place modify.
   */
  deletionProtection?: boolean;
  /**
   * Network type: `IPV4` | `DUAL`. In-place modify.
   */
  networkType?: string;
  /**
   * Allow a major engine-version upgrade during a modify. Modify-only flag.
   */
  allowMajorVersionUpgrade?: boolean;
  /**
   * Whether the instance is publicly reachable. In-place modify.
   */
  publiclyAccessible?: boolean;
  /**
   * Promotion tier inside the cluster.
   */
  promotionTier?: number;
  /**
   * Auto minor version upgrades.
   */
  autoMinorVersionUpgrade?: boolean;
  /**
   * Copy tags to snapshots.
   */
  copyTagsToSnapshot?: boolean;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
  /**
   * Skip the final snapshot when the instance is deleted. Set `false` to
   * have RDS take a final snapshot on teardown — belt-and-suspenders beyond
   * `deletionProtection` for databases whose data must survive a deliberate
   * destroy. Persisted into state so `delete` honors it without props.
   * @default true
   */
  skipFinalSnapshot?: boolean;
  /**
   * Identifier for the final snapshot taken when `skipFinalSnapshot` is
   * `false`. Defaults to `<instance-identifier>-final-<timestamp>` so
   * repeated destroy/create cycles never collide on snapshot names.
   */
  finalDBSnapshotIdentifier?: string;
}

export interface DBInstance extends Resource<
  "AWS.RDS.DBInstance",
  DBInstanceProps,
  {
    /**
     * Identifier of the instance.
     */
    dbInstanceIdentifier: string;
    /**
     * ARN of the instance.
     */
    dbInstanceArn: string;
    /**
     * Aurora cluster the instance belongs to, if any.
     */
    dbClusterIdentifier: string | undefined;
    /**
     * DNS address of the instance endpoint.
     */
    endpointAddress: string | undefined;
    /**
     * Port of the instance endpoint.
     */
    endpointPort: number | undefined;
    /**
     * Instance class (e.g. `db.serverless`, `db.t3.micro`).
     */
    dbInstanceClass: string | undefined;
    /**
     * Database engine.
     */
    engine: string | undefined;
    /**
     * Engine version in use.
     */
    engineVersion: string | undefined;
    /**
     * Status of the instance (e.g. `available`).
     */
    status: string | undefined;
    /**
     * Failover promotion tier inside the cluster.
     */
    promotionTier: number | undefined;
    /**
     * Whether the instance has a public address.
     */
    publiclyAccessible: boolean | undefined;
    /**
     * Subnet group the instance is placed in.
     */
    dbSubnetGroupName: string | undefined;
    /**
     * Parameter groups applied to the instance.
     */
    dbParameterGroupNames: string[];
    /**
     * Allocated storage in GiB.
     */
    allocatedStorage: number | undefined;
    /**
     * Storage autoscaling ceiling in GiB.
     */
    maxAllocatedStorage: number | undefined;
    /**
     * Storage type (e.g. `gp3`, `io1`, `aurora`).
     */
    storageType: string | undefined;
    /**
     * Provisioned IOPS.
     */
    iops: number | undefined;
    /**
     * Storage throughput in MiBps (gp3).
     */
    storageThroughput: number | undefined;
    /**
     * Whether the instance is Multi-AZ.
     */
    multiAZ: boolean | undefined;
    /**
     * Availability Zone of the instance.
     */
    availabilityZone: string | undefined;
    /**
     * Standby AZ for Multi-AZ deployments.
     */
    secondaryAvailabilityZone: string | undefined;
    /**
     * Backup retention period in days.
     */
    backupRetentionPeriod: number | undefined;
    /**
     * Daily backup window (`hh:mm-hh:mm` UTC).
     */
    preferredBackupWindow: string | undefined;
    /**
     * Weekly maintenance window.
     */
    preferredMaintenanceWindow: string | undefined;
    /**
     * KMS key used for storage encryption.
     */
    kmsKeyId: string | undefined;
    /**
     * Whether storage is encrypted.
     */
    storageEncrypted: boolean | undefined;
    /**
     * CA certificate identifier.
     */
    caCertificateIdentifier: string | undefined;
    /**
     * Whether IAM database authentication is enabled.
     */
    iamDatabaseAuthenticationEnabled: boolean | undefined;
    /**
     * Whether Performance Insights is enabled.
     */
    performanceInsightsEnabled: boolean | undefined;
    /**
     * Enhanced-monitoring granularity in seconds.
     */
    monitoringInterval: number | undefined;
    /**
     * ARN of the enhanced-monitoring CloudWatch Logs stream.
     */
    enhancedMonitoringResourceArn: string | undefined;
    /**
     * Log types exported to CloudWatch Logs.
     */
    enabledCloudwatchLogsExports: string[];
    /**
     * Whether deletion protection is enabled.
     */
    deletionProtection: boolean | undefined;
    /**
     * Immutable region-unique instance resource ID (used in IAM auth ARNs).
     */
    dbiResourceId: string | undefined;
    /**
     * Master username.
     */
    masterUsername: string | undefined;
    /**
     * Whether the final snapshot is skipped on delete, persisted from the
     * prop of the same name. `delete` receives only the stored attributes,
     * never live props, so the snapshot decision must ride in state;
     * `undefined` (older state without this attr) is treated as skip.
     */
    skipFinalSnapshot: boolean | undefined;
    /**
     * Identifier used for the final snapshot when `skipFinalSnapshot` is
     * `false`, persisted from props so `delete` can name the snapshot without
     * live props. `undefined` means `delete` falls back to the default
     * `<instance-identifier>-final-<timestamp>` naming scheme.
     */
    finalDBSnapshotIdentifier: string | undefined;
    /**
     * Salted SHA-256 fingerprint of the last `masterUserPassword` this
     * provider sent to RDS — `sha256(`${dbInstanceIdentifier}:${password}`)`,
     * never the secret itself. Lets reconcile skip the `MasterUserPassword`
     * modify (and the `resetting-master-credentials` cycle it triggers) when
     * the configured password has not changed.
     *
     * Persisted `Redacted` because a password hash is still sensitive: an
     * unsalted digest is vulnerable to rainbow-table lookup, so the state
     * store must not surface it in plaintext (logs, `stringify`, dumps). The
     * per-resource identifier salt additionally defeats precomputed tables;
     * it is stable across a resource's life, so the fingerprint stays
     * comparable across reconciles.
     */
    masterUserPasswordFingerprint: Redacted.Redacted<string> | undefined;
    /**
     * ARN of the Secrets Manager secret holding master credentials.
     */
    masterUserSecretArn: string | undefined;
    /**
     * Option group memberships.
     */
    optionGroupMemberships: string[];
    /**
     * License model.
     */
    licenseModel: string | undefined;
    /**
     * Configured database port.
     */
    dbInstancePort: number | undefined;
    /**
     * Network type (`IPV4` or `DUAL`).
     */
    networkType: string | undefined;
    /**
     * Tags on the instance.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An RDS database instance — either a standalone (non-Aurora) database or a
 * member of an Aurora `DBCluster`.
 *
 * Exposes the full storage, backup, monitoring, performance-insights,
 * encryption, networking, and log-export surface of `createDBInstance` /
 * `modifyDBInstance`. Mutable fields are reconciled in place against the
 * observed cloud state; immutable fields (`engine`, `dbName`,
 * `masterUsername`, `availabilityZone`, `storageEncrypted`, `kmsKeyId`,
 * `dbSubnetGroupName`) force a replacement.
 * @resource
 * @section Standalone Instance
 * @example A gp3 MySQL instance
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "mysql",
 *   dbInstanceClass: "db.t3.micro",
 *   allocatedStorage: 20,
 *   storageType: "gp3",
 *   masterUsername: "admin",
 *   masterUserPassword: Redacted.make("supersecret"),
 *   backupRetentionPeriod: "7 days",
 *   deletionProtection: false,
 * });
 * ```
 *
 * @section Cluster Member
 * @example An Aurora writer instance
 * ```typescript
 * const writer = yield* DBInstance("Writer", {
 *   dbClusterIdentifier: cluster.dbClusterIdentifier,
 *   dbInstanceClass: "db.serverless",
 *   engine: "aurora-postgresql",
 * });
 * ```
 *
 * @section Monitoring & Logs
 * @example Enhanced monitoring + log export
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   allocatedStorage: 20,
 *   monitoringInterval: "60 seconds",
 *   monitoringRoleArn: monitoringRole.roleArn,
 *   enablePerformanceInsights: true,
 *   enableCloudwatchLogsExports: ["postgresql", "upgrade"],
 * });
 * ```
 */
export const DBInstance = Resource<DBInstance>("AWS.RDS.DBInstance");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

/**
 * Whether two optional master-password fingerprints match, compared by their
 * underlying (`Redacted`-unwrapped) digest. A missing stored fingerprint
 * counts as "does not match" so a pre-existing instance sends its password
 * once, then records the fingerprint for subsequent reconciles.
 */
const sameFingerprint = (
  a: Redacted.Redacted<string> | undefined,
  b: Redacted.Redacted<string> | undefined,
): boolean =>
  a !== undefined && b !== undefined && Redacted.value(a) === Redacted.value(b);

const toAttrs = ({
  instance,
  tags,
  skipFinalSnapshot,
  finalDBSnapshotIdentifier,
  masterUserPasswordFingerprint,
}: {
  instance: rds.DBInstance;
  tags: Record<string, string>;
  skipFinalSnapshot?: boolean | undefined;
  finalDBSnapshotIdentifier?: string | undefined;
  masterUserPasswordFingerprint?: Redacted.Redacted<string> | undefined;
}): DBInstance["Attributes"] => ({
  skipFinalSnapshot,
  finalDBSnapshotIdentifier,
  masterUserPasswordFingerprint,
  dbInstanceIdentifier: instance.DBInstanceIdentifier ?? "",
  dbInstanceArn: instance.DBInstanceArn ?? "",
  dbClusterIdentifier: instance.DBClusterIdentifier,
  endpointAddress: instance.Endpoint?.Address,
  endpointPort: instance.Endpoint?.Port,
  dbInstanceClass: instance.DBInstanceClass,
  engine: instance.Engine,
  engineVersion: instance.EngineVersion,
  status: instance.DBInstanceStatus,
  promotionTier: instance.PromotionTier,
  publiclyAccessible: instance.PubliclyAccessible,
  dbSubnetGroupName: instance.DBSubnetGroup?.DBSubnetGroupName,
  dbParameterGroupNames: (instance.DBParameterGroups ?? []).flatMap((group) =>
    group.DBParameterGroupName ? [group.DBParameterGroupName] : [],
  ),
  allocatedStorage: instance.AllocatedStorage,
  maxAllocatedStorage: instance.MaxAllocatedStorage,
  storageType: instance.StorageType,
  iops: instance.Iops,
  storageThroughput: instance.StorageThroughput,
  multiAZ: instance.MultiAZ,
  availabilityZone: instance.AvailabilityZone,
  secondaryAvailabilityZone: instance.SecondaryAvailabilityZone,
  backupRetentionPeriod: instance.BackupRetentionPeriod,
  preferredBackupWindow: instance.PreferredBackupWindow,
  preferredMaintenanceWindow: instance.PreferredMaintenanceWindow,
  kmsKeyId: instance.KmsKeyId,
  storageEncrypted: instance.StorageEncrypted,
  caCertificateIdentifier: instance.CACertificateIdentifier,
  iamDatabaseAuthenticationEnabled: instance.IAMDatabaseAuthenticationEnabled,
  performanceInsightsEnabled: instance.PerformanceInsightsEnabled,
  monitoringInterval: instance.MonitoringInterval,
  enhancedMonitoringResourceArn: instance.EnhancedMonitoringResourceArn,
  enabledCloudwatchLogsExports: instance.EnabledCloudwatchLogsExports ?? [],
  deletionProtection: instance.DeletionProtection,
  dbiResourceId: instance.DbiResourceId,
  masterUsername: instance.MasterUsername,
  masterUserSecretArn: instance.MasterUserSecret?.SecretArn,
  optionGroupMemberships: (instance.OptionGroupMemberships ?? []).flatMap(
    (membership) =>
      membership.OptionGroupName ? [membership.OptionGroupName] : [],
  ),
  licenseModel: instance.LicenseModel,
  dbInstancePort: instance.DbInstancePort,
  networkType: instance.NetworkType,
  tags,
});

/**
 * Compute the CloudWatch Logs export delta. The modify API is delta-shaped
 * (`EnableLogTypes`/`DisableLogTypes`), so it must NOT carry the full set.
 * Returns `undefined` when there is no change.
 */
const logExportDelta = (
  observed: string[] | undefined,
  desired: string[] | undefined,
): rds.CloudwatchLogsExportConfiguration | undefined => {
  if (desired === undefined) return undefined;
  const have = new Set(observed ?? []);
  const want = new Set(desired);
  const EnableLogTypes = [...want].filter((t) => !have.has(t));
  const DisableLogTypes = [...have].filter((t) => !want.has(t));
  if (EnableLogTypes.length === 0 && DisableLogTypes.length === 0) {
    return undefined;
  }
  return {
    ...(EnableLogTypes.length > 0 ? { EnableLogTypes } : {}),
    ...(DisableLogTypes.length > 0 ? { DisableLogTypes } : {}),
  };
};

export const DBInstanceProvider = () =>
  Provider.effect(
    DBInstance,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBInstanceProps) =>
        props.dbInstanceIdentifier
          ? Effect.succeed(props.dbInstanceIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readInstance = Effect.fn(function* (instanceId: string) {
        const response = yield* rds
          .describeDBInstances({
            DBInstanceIdentifier: instanceId,
          })
          .pipe(
            Effect.catchTag("DBInstanceNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBInstances?.[0];
      });

      // Bounded readiness wait. Gate on `DBInstanceStatus === "available"` so a
      // follow-on `modifyDBInstance` doesn't hit `InvalidDBInstanceStateFault`.
      // `waitForAvailable` budgets ~10 min (60 * 10s) for slow provisioning;
      // `requireAvailable: false` only waits for the ARN to appear.
      const waitForInstance = Effect.fn(function* (
        instanceId: string,
        { requireAvailable = true }: { requireAvailable?: boolean } = {},
      ) {
        const readinessPolicy = Schedule.max([
          Schedule.fixed("10 seconds"),
          Schedule.recurs(60),
        ]);
        return yield* readInstance(instanceId).pipe(
          Effect.flatMap((instance) => {
            if (!instance?.DBInstanceArn) {
              return Effect.fail(
                new Error(`DB instance '${instanceId}' not found`),
              );
            }
            // Statuses that will never settle on their own — surface instead of
            // spinning until the bound is hit.
            const status = instance.DBInstanceStatus;
            if (
              requireAvailable &&
              status !== "available" &&
              status !== "incompatible-parameters" &&
              status !== "incompatible-restore"
            ) {
              return Effect.fail(
                new Error(
                  `DB instance '${instanceId}' not available (status: ${status})`,
                ),
              );
            }
            return Effect.succeed(instance);
          }),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      return {
        stables: ["dbInstanceArn", "dbInstanceIdentifier"],
        // Pattern (a) AWS account/region collection: `describeDBInstances` is
        // paginated (items: "DBInstances") and returns each instance's
        // `TagList` inline, so we hydrate directly into the same shape `read`
        // produces — no per-item tag fetch needed. An empty/no-instances
        // account simply yields no pages. `DBInstanceNotFoundFault` is in the
        // op's typed error union; treat a stray one as "nothing to list".
        list: () =>
          rds.describeDBInstances.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.DBInstances ?? [])
                  .filter(
                    (
                      instance,
                    ): instance is typeof instance & {
                      DBInstanceArn: string;
                    } => instance.DBInstanceArn != null,
                  )
                  .map((instance) =>
                    toAttrs({
                      instance,
                      tags: toTagRecord(instance.TagList),
                    }),
                  ),
              ),
            ),
            Effect.catchTag("DBInstanceNotFoundFault", () =>
              Effect.succeed([] as DBInstance["Attributes"][]),
            ),
          ),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toIdentifier(id, olds ?? ({} as DBInstanceProps))) !==
            (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
          // Immutable props — any change forces a fresh instance.
          if (
            olds !== undefined &&
            (olds.engine !== news.engine ||
              olds.dbName !== news.dbName ||
              olds.masterUsername !== news.masterUsername ||
              olds.availabilityZone !== news.availabilityZone ||
              olds.storageEncrypted !== news.storageEncrypted ||
              olds.kmsKeyId !== news.kmsKeyId ||
              olds.dbSubnetGroupName !== news.dbSubnetGroupName)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbInstanceIdentifier ??
            (yield* toIdentifier(
              id,
              olds ?? { dbInstanceClass: "", engine: "" },
            ));
          const instance = yield* readInstance(identifier);
          if (!instance?.DBInstanceArn) {
            return undefined;
          }
          return toAttrs({
            instance,
            tags: toTagRecord(instance.TagList),
            // Not observable from AWS — carry the stored deletion behavior
            // and last-sent fingerprint forward so a refresh drops neither.
            skipFinalSnapshot: output?.skipFinalSnapshot,
            finalDBSnapshotIdentifier: output?.finalDBSnapshotIdentifier,
            masterUserPasswordFingerprint:
              output?.masterUserPasswordFingerprint,
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.dbInstanceIdentifier ?? (yield* toIdentifier(id, news));
          // AWS never returns the master password, so there is nothing to
          // observe-and-diff — fingerprint the configured value instead and
          // only send `MasterUserPassword` when the fingerprint changed.
          // Without this, every reconcile of an instance whose props carry a
          // password triggers a live `resetting-master-credentials` modify.
          // The hash is salted with the (stable) instance identifier so the
          // persisted digest is not rainbow-table-lookupable, and kept
          // `Redacted` so it never leaks in plaintext through state/logs.
          const passwordFingerprint =
            news.masterUserPassword !== undefined
              ? Redacted.make(
                  yield* sha256(
                    `${identifier}:${Redacted.value(news.masterUserPassword)}`,
                  ),
                )
              : undefined;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          // Duration props → the exact wire units the RDS API expects.
          const backupRetentionDays = toWireDays(news.backupRetentionPeriod);
          const performanceInsightsRetentionDays = toWireDays(
            news.performanceInsightsRetentionPeriod,
          );
          const monitoringIntervalSeconds = toWireSeconds(
            news.monitoringInterval,
          );

          // Observe — fetch live instance state.
          let observed = yield* readInstance(identifier);

          // Ensure — create if missing. Tolerate
          // `DBInstanceAlreadyExistsFault` as a race with a peer reconciler.
          if (!observed?.DBInstanceArn) {
            yield* rds
              .createDBInstance({
                DBInstanceIdentifier: identifier,
                DBClusterIdentifier: news.dbClusterIdentifier,
                DBInstanceClass: news.dbInstanceClass,
                Engine: news.engine,
                EngineVersion: news.engineVersion,
                DBName: news.dbName,
                AllocatedStorage: news.allocatedStorage,
                MaxAllocatedStorage: news.maxAllocatedStorage,
                StorageType: news.storageType,
                Iops: news.iops,
                StorageThroughput: news.storageThroughput,
                MasterUsername: news.masterUsername,
                MasterUserPassword: news.masterUserPassword,
                ManageMasterUserPassword: news.manageMasterUserPassword,
                MasterUserSecretKmsKeyId: news.masterUserSecretKmsKeyId,
                Port: news.port,
                MultiAZ: news.multiAZ,
                AvailabilityZone: news.availabilityZone,
                BackupRetentionPeriod: backupRetentionDays,
                PreferredBackupWindow: news.preferredBackupWindow,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                DBSubnetGroupName: news.dbSubnetGroupName,
                DBParameterGroupName: news.dbParameterGroupName,
                OptionGroupName: news.optionGroupName,
                LicenseModel: news.licenseModel,
                StorageEncrypted: news.storageEncrypted,
                KmsKeyId: news.kmsKeyId,
                CACertificateIdentifier: news.caCertificateIdentifier,
                EnableIAMDatabaseAuthentication:
                  news.enableIAMDatabaseAuthentication,
                EnablePerformanceInsights: news.enablePerformanceInsights,
                PerformanceInsightsKMSKeyId: news.performanceInsightsKMSKeyId,
                PerformanceInsightsRetentionPeriod:
                  performanceInsightsRetentionDays,
                MonitoringInterval: monitoringIntervalSeconds,
                MonitoringRoleArn: news.monitoringRoleArn,
                EnableCloudwatchLogsExports: news.enableCloudwatchLogsExports,
                DeletionProtection: news.deletionProtection,
                NetworkType: news.networkType,
                // Cluster members inherit VPC security groups from the DB
                // cluster; passing them fails with InvalidParameterCombination
                // ("Set vpc security group for the DB Cluster").
                VpcSecurityGroupIds: news.dbClusterIdentifier
                  ? undefined
                  : news.vpcSecurityGroupIds,
                PubliclyAccessible: news.publiclyAccessible,
                PromotionTier: news.promotionTier,
                AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade,
                CopyTagsToSnapshot: news.copyTagsToSnapshot,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "DBInstanceAlreadyExistsFault",
                  () => Effect.void,
                ),
              );

            observed = yield* waitForInstance(identifier);
          } else {
            // Wait for the instance to settle before any modify so the call
            // doesn't hit `InvalidDBInstanceStateFault`.
            observed = yield* waitForInstance(identifier);

            // syncCoreSettings — single `modifyDBInstance` carrying scalar
            // in-place fields. Only emit a field when the desired value differs
            // from the observed cloud state, to avoid spurious
            // `PendingModifiedValues`. `Port` maps to `DBPortNumber` on modify.
            const core: rds.ModifyDBInstanceMessage = {
              DBInstanceIdentifier: identifier,
              ApplyImmediately: true,
            };
            let coreDirty = false;
            const setIf = <K extends keyof rds.ModifyDBInstanceMessage>(
              key: K,
              desired: rds.ModifyDBInstanceMessage[K] | undefined,
              observedValue: unknown,
            ) => {
              if (desired !== undefined && desired !== observedValue) {
                core[key] = desired;
                coreDirty = true;
              }
            };
            setIf("DBInstanceClass", news.dbInstanceClass, observed.DBInstanceClass); // prettier-ignore
            setIf("EngineVersion", news.engineVersion, observed.EngineVersion);
            setIf("AllocatedStorage", news.allocatedStorage, observed.AllocatedStorage); // prettier-ignore
            setIf("MaxAllocatedStorage", news.maxAllocatedStorage, observed.MaxAllocatedStorage); // prettier-ignore
            setIf("StorageType", news.storageType, observed.StorageType);
            setIf("Iops", news.iops, observed.Iops);
            setIf("StorageThroughput", news.storageThroughput, observed.StorageThroughput); // prettier-ignore
            setIf("MultiAZ", news.multiAZ, observed.MultiAZ);
            setIf("BackupRetentionPeriod", backupRetentionDays, observed.BackupRetentionPeriod); // prettier-ignore
            setIf("PreferredBackupWindow", news.preferredBackupWindow, observed.PreferredBackupWindow); // prettier-ignore
            setIf("PreferredMaintenanceWindow", news.preferredMaintenanceWindow, observed.PreferredMaintenanceWindow); // prettier-ignore
            setIf("DBPortNumber", news.port, observed.DbInstancePort);
            setIf("OptionGroupName", news.optionGroupName, undefined);
            setIf("LicenseModel", news.licenseModel, observed.LicenseModel);
            setIf("CACertificateIdentifier", news.caCertificateIdentifier, observed.CACertificateIdentifier); // prettier-ignore
            setIf("EnableIAMDatabaseAuthentication", news.enableIAMDatabaseAuthentication, observed.IAMDatabaseAuthenticationEnabled); // prettier-ignore
            setIf("EnablePerformanceInsights", news.enablePerformanceInsights, observed.PerformanceInsightsEnabled); // prettier-ignore
            setIf("PerformanceInsightsKMSKeyId", news.performanceInsightsKMSKeyId, observed.PerformanceInsightsKMSKeyId); // prettier-ignore
            setIf("PerformanceInsightsRetentionPeriod", performanceInsightsRetentionDays, observed.PerformanceInsightsRetentionPeriod); // prettier-ignore
            setIf("MonitoringInterval", monitoringIntervalSeconds, observed.MonitoringInterval); // prettier-ignore
            setIf("MonitoringRoleArn", news.monitoringRoleArn, observed.MonitoringRoleArn); // prettier-ignore
            setIf("DeletionProtection", news.deletionProtection, observed.DeletionProtection); // prettier-ignore
            setIf("NetworkType", news.networkType, observed.NetworkType);
            setIf("DBParameterGroupName", news.dbParameterGroupName, undefined);
            setIf("PubliclyAccessible", news.publiclyAccessible, observed.PubliclyAccessible); // prettier-ignore
            setIf("PromotionTier", news.promotionTier, observed.PromotionTier);
            setIf("AutoMinorVersionUpgrade", news.autoMinorVersionUpgrade, observed.AutoMinorVersionUpgrade); // prettier-ignore
            setIf("CopyTagsToSnapshot", news.copyTagsToSnapshot, observed.CopyTagsToSnapshot); // prettier-ignore
            // Security groups on Aurora cluster members are managed by the DB
            // cluster (ModifyDBCluster), so only sync them for standalone
            // instances.
            if (
              news.vpcSecurityGroupIds !== undefined &&
              news.dbClusterIdentifier === undefined
            ) {
              core.VpcSecurityGroupIds = news.vpcSecurityGroupIds;
              coreDirty = true;
            }
            if (news.allowMajorVersionUpgrade) {
              core.AllowMajorVersionUpgrade = true;
            }
            // syncMasterPassword — rotation or explicit password update. The
            // explicit branch is fingerprint-guarded: send only when the
            // configured password actually changed (or was never
            // fingerprinted — pre-existing state sends once, then records).
            if (
              news.manageMasterUserPassword &&
              news.rotateMasterUserPassword
            ) {
              core.RotateMasterUserPassword = true;
              coreDirty = true;
            } else if (
              news.masterUserPassword !== undefined &&
              !sameFingerprint(
                passwordFingerprint,
                output?.masterUserPasswordFingerprint,
              )
            ) {
              core.MasterUserPassword = news.masterUserPassword;
              coreDirty = true;
            }
            if (coreDirty) {
              yield* rds.modifyDBInstance(core);
              observed = yield* waitForInstance(identifier);
            }

            // syncCloudwatchLogsExports — delta-shaped; separate call so it
            // never mixes the full-set fields above.
            const logDelta = logExportDelta(
              observed.EnabledCloudwatchLogsExports,
              news.enableCloudwatchLogsExports,
            );
            if (logDelta) {
              yield* rds.modifyDBInstance({
                DBInstanceIdentifier: identifier,
                CloudwatchLogsExportConfiguration: logDelta,
                ApplyImmediately: true,
              });
              observed = yield* waitForInstance(identifier);
            }
          }

          const dbInstanceArn = observed.DBInstanceArn ?? "";

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = toTagRecord(observed.TagList);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbInstanceArn) {
            yield* rds.addTagsToResource({
              ResourceName: dbInstanceArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbInstanceArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: dbInstanceArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbInstanceArn || identifier);
          return toAttrs({
            instance: observed,
            tags: desiredTags,
            skipFinalSnapshot: news.skipFinalSnapshot,
            finalDBSnapshotIdentifier: news.finalDBSnapshotIdentifier,
            masterUserPasswordFingerprint: passwordFingerprint,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          // Default preserves the existing behavior (no final snapshot). When
          // the resource was declared with `skipFinalSnapshot: false`, take
          // one — timestamped by default so repeated destroy/create cycles
          // never collide on snapshot names.
          const skipFinalSnapshot = output.skipFinalSnapshot ?? true;
          const finalDBSnapshotIdentifier = skipFinalSnapshot
            ? undefined
            : (output.finalDBSnapshotIdentifier ??
              `${output.dbInstanceIdentifier}-final-${new Date()
                .toISOString()
                .replaceAll(/[:.]/g, "-")
                .toLowerCase()}`);
          yield* rds
            .deleteDBInstance({
              DBInstanceIdentifier: output.dbInstanceIdentifier,
              SkipFinalSnapshot: skipFinalSnapshot,
              FinalDBSnapshotIdentifier: finalDBSnapshotIdentifier,
            })
            .pipe(
              Effect.catchTag("DBInstanceNotFoundFault", () => Effect.void),
            );
          // Block until the instance is fully gone. RDS deletion is async; if we
          // return while it is still `deleting`, a dependent (e.g. a
          // DBSubnetGroup or VPC) is torn down next and AWS rejects it with
          // `InvalidDBSubnetGroupStateFault: ... still using it`.
          yield* Effect.repeat(
            rds
              .describeDBInstances({
                DBInstanceIdentifier: output.dbInstanceIdentifier,
              })
              .pipe(
                Effect.as(true),
                Effect.catchTag("DBInstanceNotFoundFault", () =>
                  Effect.succeed(false),
                ),
              ),
            {
              schedule: Schedule.max([
                Schedule.fixed("15 seconds"),
                // A final snapshot serializes before the delete, so give
                // that path a larger budget than the plain-delete wait.
                Schedule.recurs(skipFinalSnapshot ? 40 : 80),
              ]),
              until: (exists) => exists === false,
            },
          ).pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );
