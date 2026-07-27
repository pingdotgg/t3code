import * as rds from "@distilled.cloud/aws/rds";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
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

export interface DBClusterProps {
  /**
   * Cluster identifier. If omitted, Alchemy generates one.
   */
  dbClusterIdentifier?: string;
  /**
   * Aurora engine, such as `aurora-postgresql`.
   */
  engine: string;
  /**
   * Optional engine version.
   */
  engineVersion?: string;
  /**
   * Optional database name created with the cluster.
   */
  databaseName?: string;
  /**
   * Subnet group used by the cluster.
   */
  dbSubnetGroupName?: string;
  /**
   * Cluster parameter group name.
   */
  dbClusterParameterGroupName?: string;
  /**
   * Security groups attached to the cluster.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Optional listener port.
   */
  port?: number;
  /**
   * Enable IAM database authentication.
   */
  enableIAMDatabaseAuthentication?: boolean;
  /**
   * Enable Aurora Data API / HTTP endpoint support.
   */
  enableHttpEndpoint?: boolean;
  /**
   * Engine mode, for example `provisioned` or `serverless`.
   * Changing it forces replacement unless `AllowEngineModeChange` applies.
   */
  engineMode?: string;
  /**
   * Serverless v2 scaling configuration.
   */
  serverlessV2ScalingConfiguration?: rds.ServerlessV2ScalingConfiguration;
  /**
   * Serverless v1 scaling configuration. In-place modify.
   */
  scalingConfiguration?: rds.ScalingConfiguration;
  /**
   * Availability zones for cluster placement. Immutable — forces replacement.
   */
  availabilityZones?: string[];
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
   * Backtrack window (Aurora MySQL only), e.g. `"1 hour"`. Sent to the API
   * in whole seconds. In-place modify.
   */
  backtrackWindow?: Duration.Input;
  /**
   * Option group name. In-place modify.
   */
  optionGroupName?: string;
  /**
   * Log types to export to CloudWatch Logs. Diffed against observed state and
   * applied via the delta-shaped `CloudwatchLogsExportConfiguration` on modify.
   */
  enableCloudwatchLogsExports?: string[];
  /**
   * Auto minor version upgrade. In-place modify.
   */
  autoMinorVersionUpgrade?: boolean;
  /**
   * Allow a major engine-version upgrade during a modify. Modify-only flag.
   */
  allowMajorVersionUpgrade?: boolean;
  /**
   * Enhanced-monitoring granularity (e.g. `"60 seconds"`). Sent to the API
   * in whole seconds (valid: 0, 1, 5, 10, 15, 30, 60). In-place modify.
   */
  monitoringInterval?: Duration.Input;
  /**
   * IAM role ARN for enhanced monitoring. In-place modify.
   */
  monitoringRoleArn?: string;
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
   * whole days (valid: 7, 731, or month multiples). In-place modify.
   */
  performanceInsightsRetentionPeriod?: Duration.Input;
  /**
   * Network type: `IPV4` | `DUAL`. In-place modify.
   */
  networkType?: string;
  /**
   * CA certificate identifier. In-place modify.
   */
  caCertificateIdentifier?: string;
  /**
   * KMS key used to encrypt the managed master user secret. In-place modify.
   */
  masterUserSecretKmsKeyId?: string;
  /**
   * Rotate the managed master user password on the next reconcile.
   */
  rotateMasterUserPassword?: boolean;
  /**
   * Enable global write forwarding (secondary regions of a global cluster).
   */
  enableGlobalWriteForwarding?: boolean;
  /**
   * Enable local write forwarding (Aurora reader endpoints). In-place modify.
   */
  enableLocalWriteForwarding?: boolean;
  /**
   * Join this cluster to an Aurora global cluster. Immutable on create.
   */
  globalClusterIdentifier?: string;
  /**
   * Instance class for a provisioned multi-AZ cluster. In-place modify.
   */
  dbClusterInstanceClass?: string;
  /**
   * Allocated storage (GiB) for a provisioned multi-AZ cluster. In-place.
   */
  allocatedStorage?: number;
  /**
   * Storage type (provisioned multi-AZ cluster). In-place modify.
   */
  storageType?: string;
  /**
   * Provisioned IOPS (provisioned multi-AZ cluster). In-place modify.
   */
  iops?: number;
  /**
   * Whether a provisioned cluster is publicly reachable. In-place modify.
   */
  publiclyAccessible?: boolean;
  /**
   * Engine lifecycle support setting. Immutable — forces replacement.
   */
  engineLifecycleSupport?: string;
  /**
   * Whether to copy tags to snapshots.
   */
  copyTagsToSnapshot?: boolean;
  /**
   * Whether to block accidental deletion.
   */
  deletionProtection?: boolean;
  /**
   * Whether the storage is encrypted. Immutable — forces replacement.
   */
  storageEncrypted?: boolean;
  /**
   * Optional KMS key used for storage encryption. Immutable — forces replace.
   */
  kmsKeyId?: string;
  /**
   * Let RDS manage the master user password in Secrets Manager.
   */
  manageMasterUserPassword?: boolean;
  /**
   * Explicit master username when not deriving credentials from a secret.
   */
  masterUsername?: string;
  /**
   * Explicit master password when not deriving credentials from a secret.
   */
  masterUserPassword?: Redacted.Redacted<string>;
  /**
   * Existing Secrets Manager secret ARN whose JSON payload contains
   * `username` and `password`.
   */
  masterUserSecretArn?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBCluster extends Resource<
  "AWS.RDS.DBCluster",
  DBClusterProps,
  {
    /**
     * Identifier of the cluster.
     */
    dbClusterIdentifier: string;
    /**
     * ARN of the cluster.
     */
    dbClusterArn: string;
    /**
     * Subnet group the cluster is placed in.
     */
    dbSubnetGroupName: string | undefined;
    /**
     * Writer endpoint DNS address.
     */
    endpoint: string | undefined;
    /**
     * Load-balanced reader endpoint DNS address.
     */
    readerEndpoint: string | undefined;
    /**
     * Port the database listens on.
     */
    port: number | undefined;
    /**
     * Database engine (e.g. `aurora-postgresql`).
     */
    engine: string;
    /**
     * Engine version in use.
     */
    engineVersion: string | undefined;
    /**
     * Status of the cluster (e.g. `available`).
     */
    status: string | undefined;
    /**
     * Name of the initial database.
     */
    databaseName: string | undefined;
    /**
     * Master username.
     */
    masterUsername: string | undefined;
    /**
     * ARN of the Secrets Manager secret holding master credentials.
     */
    masterUserSecretArn: string | undefined;
    /**
     * Security groups attached to the cluster.
     */
    vpcSecurityGroupIds: string[];
    /**
     * Whether the Data API HTTP endpoint is enabled.
     */
    httpEndpointEnabled: boolean | undefined;
    /**
     * Allocated storage in GiB (provisioned engines).
     */
    allocatedStorage: number | undefined;
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
     * Whether storage is encrypted.
     */
    storageEncrypted: boolean | undefined;
    /**
     * KMS key used for storage encryption.
     */
    kmsKeyId: string | undefined;
    /**
     * Whether deletion protection is enabled.
     */
    deletionProtection: boolean | undefined;
    /**
     * Whether IAM database authentication is enabled.
     */
    iamDatabaseAuthenticationEnabled: boolean | undefined;
    /**
     * Engine mode (e.g. `provisioned`).
     */
    engineMode: string | undefined;
    /**
     * Member instances with their writer flag and promotion tier.
     */
    dbClusterMembers: Array<{
      dbInstanceIdentifier: string | undefined;
      isClusterWriter: boolean | undefined;
      promotionTier: number | undefined;
    }>;
    /**
     * Immutable region-unique cluster resource ID (used in IAM auth ARNs).
     */
    dbClusterResourceId: string | undefined;
    /**
     * Route 53 hosted zone ID of the cluster endpoints.
     */
    hostedZoneId: string | undefined;
    /**
     * Whether the cluster has instances in multiple AZs.
     */
    multiAZ: boolean | undefined;
    /**
     * Log types exported to CloudWatch Logs.
     */
    enabledCloudwatchLogsExports: string[];
    /**
     * Whether cluster tags are copied to snapshots.
     */
    copyTagsToSnapshot: boolean | undefined;
    /**
     * Time the cluster was created (ISO 8601).
     */
    clusterCreateTime: string | undefined;
    /**
     * Serverless v2 platform version.
     */
    serverlessV2PlatformVersion: string | undefined;
    /**
     * Enhanced-monitoring granularity in seconds.
     */
    monitoringInterval: number | undefined;
    /**
     * Whether Performance Insights is enabled.
     */
    performanceInsightsEnabled: boolean | undefined;
    /**
     * Instance class for Multi-AZ DB clusters.
     */
    dbClusterInstanceClass: string | undefined;
    /**
     * Storage type (e.g. `aurora`, `aurora-iopt1`).
     */
    storageType: string | undefined;
    /**
     * Provisioned IOPS (Multi-AZ DB clusters).
     */
    iops: number | undefined;
    /**
     * Network type (`IPV4` or `DUAL`).
     */
    networkType: string | undefined;
    /**
     * Custom endpoint ARNs associated with the cluster.
     */
    customEndpoints: string[];
    /**
     * Tags on the cluster.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Aurora DB cluster.
 *
 * `DBCluster` owns the writer and reader endpoints, cluster-wide networking,
 * and Data API enablement. It can bootstrap master credentials directly or by
 * reading a Secrets Manager secret that contains `username` and `password`.
 *
 * It exposes the full backup, maintenance, monitoring, performance-insights,
 * encryption, scaling, and log-export surface of `createDBCluster` /
 * `modifyDBCluster`. Mutable fields are reconciled in place against the
 * observed cloud state; immutable fields (`engine`, `databaseName`,
 * `dbSubnetGroupName`, `storageEncrypted`, `kmsKeyId`, `engineMode`,
 * `globalClusterIdentifier`, `availabilityZones`, `engineLifecycleSupport`)
 * force a replacement.
 * @resource
 * @section Serverless v2 Cluster
 * @example Aurora Postgres serverless-v2
 * ```typescript
 * const cluster = yield* DBCluster("Cluster", {
 *   engine: "aurora-postgresql",
 *   engineMode: "provisioned",
 *   serverlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
 *   manageMasterUserPassword: true,
 *   masterUsername: "alchemy",
 *   backupRetentionPeriod: "7 days",
 *   deletionProtection: false,
 * });
 * ```
 *
 * @section Logs & Monitoring
 * @example Export logs and enable Performance Insights
 * ```typescript
 * const cluster = yield* DBCluster("Cluster", {
 *   engine: "aurora-postgresql",
 *   enableCloudwatchLogsExports: ["postgresql"],
 *   enablePerformanceInsights: true,
 *   monitoringInterval: "60 seconds",
 *   monitoringRoleArn: monitoringRole.roleArn,
 * });
 * ```
 */
export const DBCluster = Resource<DBCluster>("AWS.RDS.DBCluster");

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

const resolveMasterCredentials = (props: DBClusterProps) =>
  Effect.gen(function* () {
    if (props.masterUserSecretArn) {
      const value = yield* secretsmanager.getSecretValue({
        SecretId: props.masterUserSecretArn,
      });
      const secretString = value.SecretString
        ? typeof value.SecretString === "string"
          ? value.SecretString
          : Redacted.value(value.SecretString)
        : undefined;
      const secret = secretString
        ? (JSON.parse(secretString) as {
            username?: string;
            password?: string;
          })
        : {};
      return {
        MasterUsername: props.masterUsername ?? secret.username,
        MasterUserPassword: props.masterUserPassword ?? secret.password,
      };
    }

    return {
      MasterUsername: props.masterUsername,
      MasterUserPassword: props.masterUserPassword,
    };
  });

const toAttrs = ({
  cluster,
  tags,
}: {
  cluster: rds.DBCluster;
  tags: Record<string, string>;
}): DBCluster["Attributes"] => ({
  dbClusterIdentifier: cluster.DBClusterIdentifier ?? "",
  dbClusterArn: cluster.DBClusterArn ?? "",
  dbSubnetGroupName: cluster.DBSubnetGroup,
  endpoint: cluster.Endpoint,
  readerEndpoint: cluster.ReaderEndpoint,
  port: cluster.Port,
  engine: cluster.Engine ?? "",
  engineVersion: cluster.EngineVersion,
  status: cluster.Status,
  databaseName: cluster.DatabaseName,
  masterUsername: cluster.MasterUsername,
  masterUserSecretArn: cluster.MasterUserSecret?.SecretArn,
  vpcSecurityGroupIds: (cluster.VpcSecurityGroups ?? []).flatMap((group) =>
    group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
  ),
  httpEndpointEnabled: cluster.HttpEndpointEnabled,
  allocatedStorage: cluster.AllocatedStorage,
  backupRetentionPeriod: cluster.BackupRetentionPeriod,
  preferredBackupWindow: cluster.PreferredBackupWindow,
  preferredMaintenanceWindow: cluster.PreferredMaintenanceWindow,
  storageEncrypted: cluster.StorageEncrypted,
  kmsKeyId: cluster.KmsKeyId,
  deletionProtection: cluster.DeletionProtection,
  iamDatabaseAuthenticationEnabled: cluster.IAMDatabaseAuthenticationEnabled,
  engineMode: cluster.EngineMode,
  dbClusterMembers: (cluster.DBClusterMembers ?? []).map((member) => ({
    dbInstanceIdentifier: member.DBInstanceIdentifier,
    isClusterWriter: member.IsClusterWriter,
    promotionTier: member.PromotionTier,
  })),
  dbClusterResourceId: cluster.DbClusterResourceId,
  hostedZoneId: cluster.HostedZoneId,
  multiAZ: cluster.MultiAZ,
  enabledCloudwatchLogsExports: cluster.EnabledCloudwatchLogsExports ?? [],
  copyTagsToSnapshot: cluster.CopyTagsToSnapshot,
  clusterCreateTime: cluster.ClusterCreateTime?.toISOString(),
  serverlessV2PlatformVersion: cluster.ServerlessV2PlatformVersion,
  monitoringInterval: cluster.MonitoringInterval,
  performanceInsightsEnabled: cluster.PerformanceInsightsEnabled,
  dbClusterInstanceClass: cluster.DBClusterInstanceClass,
  storageType: cluster.StorageType,
  iops: cluster.Iops,
  networkType: cluster.NetworkType,
  customEndpoints: cluster.CustomEndpoints ?? [],
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

export const DBClusterProvider = () =>
  Provider.effect(
    DBCluster,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBClusterProps) =>
        props.dbClusterIdentifier
          ? Effect.succeed(props.dbClusterIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readCluster = Effect.fn(function* (clusterId: string) {
        const response = yield* rds
          .describeDBClusters({
            DBClusterIdentifier: clusterId,
          })
          .pipe(
            Effect.catchTag("DBClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBClusters?.[0];
      });

      // Bounded readiness wait. Gate on cluster `Status === "available"` so a
      // follow-on `modifyDBCluster` doesn't hit `InvalidDBClusterStateFault`.
      // Budgets ~10 min (60 * 10s) for slow provisioning. `requireAvailable:
      // false` only waits for the ARN to appear.
      const waitForCluster = Effect.fn(function* (
        clusterId: string,
        { requireAvailable = true }: { requireAvailable?: boolean } = {},
      ) {
        const readinessPolicy = Schedule.max([
          Schedule.fixed("10 seconds"),
          Schedule.recurs(60),
        ]);
        return yield* readCluster(clusterId).pipe(
          Effect.flatMap((cluster) => {
            if (!cluster?.DBClusterArn) {
              return Effect.fail(
                new Error(`DB cluster '${clusterId}' not found`),
              );
            }
            if (requireAvailable && cluster.Status !== "available") {
              return Effect.fail(
                new Error(
                  `DB cluster '${clusterId}' not available (status: ${cluster.Status})`,
                ),
              );
            }
            return Effect.succeed(cluster);
          }),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      return {
        stables: ["dbClusterArn", "dbClusterIdentifier"],
        // AWS account/region collection (pattern a): exhaustively paginate
        // `describeDBClusters` and map each cluster to the exact `read`
        // Attributes shape. Tags come inline on `DBCluster.TagList`, so no
        // per-item `listTagsForResource` hydration is needed (matching `read`).
        list: () =>
          Effect.gen(function* () {
            return yield* rds.describeDBClusters.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.DBClusters ?? []).map((cluster) =>
                    toAttrs({
                      cluster,
                      tags: toTagRecord(cluster.TagList),
                    }),
                  ),
                ),
              ),
            );
          }),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toIdentifier(id, olds ?? ({} as DBClusterProps))) !==
            (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
          // Immutable props — any change forces a fresh cluster.
          if (
            olds !== undefined &&
            (olds.engine !== news.engine ||
              olds.databaseName !== news.databaseName ||
              olds.dbSubnetGroupName !== news.dbSubnetGroupName ||
              olds.storageEncrypted !== news.storageEncrypted ||
              olds.kmsKeyId !== news.kmsKeyId ||
              olds.engineMode !== news.engineMode ||
              olds.globalClusterIdentifier !== news.globalClusterIdentifier ||
              olds.engineLifecycleSupport !== news.engineLifecycleSupport ||
              JSON.stringify(olds.availabilityZones ?? []) !==
                JSON.stringify(news.availabilityZones ?? []))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbClusterIdentifier ??
            (yield* toIdentifier(
              id,
              olds ?? ({ engine: "" } as DBClusterProps),
            ));
          const cluster = yield* readCluster(identifier);
          if (!cluster?.DBClusterArn) {
            return undefined;
          }
          return toAttrs({
            cluster,
            tags: toTagRecord(cluster.TagList),
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.dbClusterIdentifier ?? (yield* toIdentifier(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const credentials = yield* resolveMasterCredentials(news);
          // Duration props → the exact wire units the RDS API expects.
          const backupRetentionDays = toWireDays(news.backupRetentionPeriod);
          const backtrackWindowSeconds = toWireSeconds(news.backtrackWindow);
          const monitoringIntervalSeconds = toWireSeconds(
            news.monitoringInterval,
          );
          const performanceInsightsRetentionDays = toWireDays(
            news.performanceInsightsRetentionPeriod,
          );

          // Observe — fetch live cluster state. We never trust `output`
          // blindly: the cluster may have been deleted out-of-band, or this
          // may be a first-time reconcile after adoption.
          let observed = yield* readCluster(identifier);

          // Ensure — create the cluster if it's missing. Tolerate
          // `DBClusterAlreadyExistsFault` as a race with a peer reconciler
          // (e.g. retry after state-persistence failure).
          if (!observed?.DBClusterArn) {
            yield* rds
              .createDBCluster({
                DBClusterIdentifier: identifier,
                Engine: news.engine,
                EngineVersion: news.engineVersion,
                DatabaseName: news.databaseName,
                DBSubnetGroupName: news.dbSubnetGroupName,
                DBClusterParameterGroupName: news.dbClusterParameterGroupName,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                Port: news.port,
                AvailabilityZones: news.availabilityZones,
                BackupRetentionPeriod: backupRetentionDays,
                PreferredBackupWindow: news.preferredBackupWindow,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                BacktrackWindow: backtrackWindowSeconds,
                OptionGroupName: news.optionGroupName,
                EnableCloudwatchLogsExports: news.enableCloudwatchLogsExports,
                EnableIAMDatabaseAuthentication:
                  news.enableIAMDatabaseAuthentication,
                EnableHttpEndpoint: news.enableHttpEndpoint,
                EngineMode: news.engineMode,
                ScalingConfiguration: news.scalingConfiguration,
                ServerlessV2ScalingConfiguration:
                  news.serverlessV2ScalingConfiguration,
                AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade,
                MonitoringInterval: monitoringIntervalSeconds,
                MonitoringRoleArn: news.monitoringRoleArn,
                EnablePerformanceInsights: news.enablePerformanceInsights,
                PerformanceInsightsKMSKeyId: news.performanceInsightsKMSKeyId,
                PerformanceInsightsRetentionPeriod:
                  performanceInsightsRetentionDays,
                NetworkType: news.networkType,
                CACertificateIdentifier: news.caCertificateIdentifier,
                MasterUserSecretKmsKeyId: news.masterUserSecretKmsKeyId,
                EnableGlobalWriteForwarding: news.enableGlobalWriteForwarding,
                EnableLocalWriteForwarding: news.enableLocalWriteForwarding,
                GlobalClusterIdentifier: news.globalClusterIdentifier,
                DBClusterInstanceClass: news.dbClusterInstanceClass,
                AllocatedStorage: news.allocatedStorage,
                StorageType: news.storageType,
                Iops: news.iops,
                PubliclyAccessible: news.publiclyAccessible,
                EngineLifecycleSupport: news.engineLifecycleSupport,
                CopyTagsToSnapshot: news.copyTagsToSnapshot,
                DeletionProtection: news.deletionProtection,
                StorageEncrypted: news.storageEncrypted,
                KmsKeyId: news.kmsKeyId,
                ManageMasterUserPassword: news.manageMasterUserPassword,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
                ...credentials,
              })
              .pipe(
                Effect.catchTag(
                  "DBClusterAlreadyExistsFault",
                  () => Effect.void,
                ),
              );

            observed = yield* waitForCluster(identifier);
          } else {
            // Wait for the cluster to settle before any modify so the call
            // doesn't hit `InvalidDBClusterStateFault`.
            observed = yield* waitForCluster(identifier);

            // syncCoreSettings — single `modifyDBCluster` carrying scalar
            // in-place fields, only emitting a field when the desired value
            // differs from the observed cloud state.
            const core: rds.ModifyDBClusterMessage = {
              DBClusterIdentifier: identifier,
              ApplyImmediately: true,
            };
            let coreDirty = false;
            const setIf = <K extends keyof rds.ModifyDBClusterMessage>(
              key: K,
              desired: rds.ModifyDBClusterMessage[K] | undefined,
              observedValue: unknown,
            ) => {
              if (desired !== undefined && desired !== observedValue) {
                core[key] = desired;
                coreDirty = true;
              }
            };
            setIf("EngineVersion", news.engineVersion, observed.EngineVersion);
            setIf("Port", news.port, observed.Port);
            setIf("BackupRetentionPeriod", backupRetentionDays, observed.BackupRetentionPeriod); // prettier-ignore
            setIf("PreferredBackupWindow", news.preferredBackupWindow, observed.PreferredBackupWindow); // prettier-ignore
            setIf("PreferredMaintenanceWindow", news.preferredMaintenanceWindow, observed.PreferredMaintenanceWindow); // prettier-ignore
            setIf("BacktrackWindow", backtrackWindowSeconds, observed.BacktrackWindow); // prettier-ignore
            setIf("DeletionProtection", news.deletionProtection, observed.DeletionProtection); // prettier-ignore
            setIf("CopyTagsToSnapshot", news.copyTagsToSnapshot, observed.CopyTagsToSnapshot); // prettier-ignore
            setIf("EnableIAMDatabaseAuthentication", news.enableIAMDatabaseAuthentication, observed.IAMDatabaseAuthenticationEnabled); // prettier-ignore
            setIf("EnableHttpEndpoint", news.enableHttpEndpoint, observed.HttpEndpointEnabled); // prettier-ignore
            setIf("AutoMinorVersionUpgrade", news.autoMinorVersionUpgrade, observed.AutoMinorVersionUpgrade); // prettier-ignore
            setIf("MonitoringInterval", monitoringIntervalSeconds, observed.MonitoringInterval); // prettier-ignore
            setIf("MonitoringRoleArn", news.monitoringRoleArn, observed.MonitoringRoleArn); // prettier-ignore
            setIf("EnablePerformanceInsights", news.enablePerformanceInsights, observed.PerformanceInsightsEnabled); // prettier-ignore
            setIf("PerformanceInsightsKMSKeyId", news.performanceInsightsKMSKeyId, observed.PerformanceInsightsKMSKeyId); // prettier-ignore
            setIf("PerformanceInsightsRetentionPeriod", performanceInsightsRetentionDays, observed.PerformanceInsightsRetentionPeriod); // prettier-ignore
            setIf("NetworkType", news.networkType, observed.NetworkType);
            setIf("DBClusterInstanceClass", news.dbClusterInstanceClass, observed.DBClusterInstanceClass); // prettier-ignore
            setIf("AllocatedStorage", news.allocatedStorage, observed.AllocatedStorage); // prettier-ignore
            setIf("StorageType", news.storageType, observed.StorageType);
            setIf("Iops", news.iops, observed.Iops);
            setIf("OptionGroupName", news.optionGroupName, undefined);
            setIf("DBClusterParameterGroupName", news.dbClusterParameterGroupName, observed.DBClusterParameterGroup); // prettier-ignore
            setIf("EnableGlobalWriteForwarding", news.enableGlobalWriteForwarding, undefined); // prettier-ignore
            setIf("EnableLocalWriteForwarding", news.enableLocalWriteForwarding, undefined); // prettier-ignore
            setIf("CACertificateIdentifier", news.caCertificateIdentifier, undefined); // prettier-ignore
            if (news.scalingConfiguration !== undefined) {
              core.ScalingConfiguration = news.scalingConfiguration;
              coreDirty = true;
            }
            if (news.serverlessV2ScalingConfiguration !== undefined) {
              core.ServerlessV2ScalingConfiguration =
                news.serverlessV2ScalingConfiguration;
              coreDirty = true;
            }
            if (news.vpcSecurityGroupIds !== undefined) {
              core.VpcSecurityGroupIds = news.vpcSecurityGroupIds;
              coreDirty = true;
            }
            if (news.allowMajorVersionUpgrade) {
              core.AllowMajorVersionUpgrade = true;
            }
            // syncMasterPassword — rotation or explicit password update.
            if (
              news.manageMasterUserPassword &&
              news.rotateMasterUserPassword
            ) {
              core.RotateMasterUserPassword = true;
              coreDirty = true;
            } else if (credentials.MasterUserPassword !== undefined) {
              core.MasterUserPassword = credentials.MasterUserPassword;
              coreDirty = true;
            }
            if (coreDirty) {
              yield* rds.modifyDBCluster(core);
              observed = yield* waitForCluster(identifier);
            }

            // syncCloudwatchLogsExports — delta-shaped; separate call.
            const logDelta = logExportDelta(
              observed.EnabledCloudwatchLogsExports,
              news.enableCloudwatchLogsExports,
            );
            if (logDelta) {
              yield* rds.modifyDBCluster({
                DBClusterIdentifier: identifier,
                CloudwatchLogsExportConfiguration: logDelta,
                ApplyImmediately: true,
              });
              observed = yield* waitForCluster(identifier);
            }
          }

          const dbClusterArn = observed.DBClusterArn ?? "";

          // Sync tags — diff observed cloud tags against desired so the
          // reconciler converges regardless of what was on the resource
          // before (initial create, adoption, or drift).
          const observedTags = toTagRecord(observed.TagList);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbClusterArn) {
            yield* rds.addTagsToResource({
              ResourceName: dbClusterArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbClusterArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: dbClusterArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbClusterArn || identifier);
          return toAttrs({ cluster: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBCluster({
              DBClusterIdentifier: output.dbClusterIdentifier,
              SkipFinalSnapshot: true,
            })
            .pipe(Effect.catchTag("DBClusterNotFoundFault", () => Effect.void));
          // Block until the cluster is fully gone. RDS deletion is async; if we
          // return while it is still `deleting`, a dependent (e.g. a
          // DBSubnetGroup or VPC) is torn down next and AWS rejects it with
          // `InvalidDBSubnetGroupStateFault: ... still using it`.
          yield* Effect.repeat(
            rds
              .describeDBClusters({
                DBClusterIdentifier: output.dbClusterIdentifier,
              })
              .pipe(
                Effect.as(true),
                Effect.catchTag("DBClusterNotFoundFault", () =>
                  Effect.succeed(false),
                ),
              ),
            {
              schedule: Schedule.max([
                Schedule.fixed("15 seconds"),
                Schedule.recurs(40),
              ]),
              until: (exists) => exists === false,
            },
          ).pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );
