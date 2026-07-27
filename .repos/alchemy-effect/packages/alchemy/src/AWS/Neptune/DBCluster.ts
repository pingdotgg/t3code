import * as neptune from "@distilled.cloud/aws/neptune";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

export interface ServerlessV2ScalingConfiguration {
  /**
   * Minimum Neptune Capacity Units (NCUs), e.g. `1`.
   */
  minCapacity?: number;
  /**
   * Maximum Neptune Capacity Units (NCUs), e.g. `2.5`.
   */
  maxCapacity?: number;
}

export interface DBClusterProps {
  /**
   * Cluster identifier. If omitted, Alchemy generates one.
   */
  dbClusterIdentifier?: string;
  /**
   * Database engine. Neptune only supports `neptune`.
   * Changing it forces replacement.
   * @default "neptune"
   */
  engine?: string;
  /**
   * Optional engine version, e.g. `1.4.5.0`. Changed in place via
   * `modifyDBCluster` (may require `allowMajorVersionUpgrade`).
   */
  engineVersion?: string;
  /**
   * Subnet group the cluster is placed into. Neptune is VPC-only, so this
   * is effectively required. Immutable — forces replacement.
   */
  dbSubnetGroupName?: string;
  /**
   * Cluster parameter group name. In-place modify.
   */
  dbClusterParameterGroupName?: string;
  /**
   * Security groups attached to the cluster. In-place modify.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Listener port.
   * @default 8182
   */
  port?: number;
  /**
   * Availability zones for cluster placement. Immutable — forces replacement.
   */
  availabilityZones?: string[];
  /**
   * Backup retention period (1-35 days, e.g. `"7 days"` or
   * `Duration.days(7)`). Sent to the API in whole days. In-place modify.
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
   * Log types to export to CloudWatch Logs (`audit`, `slowquery`). Diffed
   * against observed state and applied via the delta-shaped
   * `CloudwatchLogsExportConfiguration` on modify.
   */
  enableCloudwatchLogsExports?: string[];
  /**
   * Enable IAM database authentication (SigV4-signed data-plane requests).
   * In-place modify.
   */
  enableIAMDatabaseAuthentication?: boolean;
  /**
   * Serverless v2 (NCU-based) scaling configuration. Required when using
   * `db.serverless` instances. In-place modify.
   */
  serverlessV2ScalingConfiguration?: ServerlessV2ScalingConfiguration;
  /**
   * Block accidental deletion. In-place modify.
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
   * Storage type, `standard` | `iopt1`. In-place modify.
   */
  storageType?: string;
  /**
   * Copy tags to snapshots. In-place modify.
   */
  copyTagsToSnapshot?: boolean;
  /**
   * Join this cluster to a Neptune global database. Immutable on create.
   */
  globalClusterIdentifier?: string;
  /**
   * Allow a major engine-version upgrade during a modify. Modify-only flag.
   */
  allowMajorVersionUpgrade?: boolean;
  /**
   * IAM roles to associate with the cluster — e.g. an S3 read role for the
   * Neptune bulk loader, or a SageMaker role for Neptune ML (set
   * `featureName` where the feature requires it). Reconciled in place by
   * diffing the observed cloud associations against this list via
   * `addRoleToDBCluster`/`removeRoleFromDBCluster`.
   */
  associatedRoles?: Array<{
    /** ARN of the IAM role to associate. */
    roleArn: string;
    /** Neptune feature the role is scoped to (omit for the default). */
    featureName?: string;
  }>;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBCluster extends Resource<
  "AWS.Neptune.DBCluster",
  DBClusterProps,
  {
    /** Identifier of the cluster. */
    dbClusterIdentifier: string;
    /** ARN of the cluster. */
    dbClusterArn: string;
    /** Name of the subnet group the cluster is placed in. */
    dbSubnetGroupName: string | undefined;
    /** Name of the attached cluster parameter group. */
    dbClusterParameterGroupName: string | undefined;
    /** Writer (cluster) endpoint host name. */
    endpoint: string | undefined;
    /** Load-balanced reader endpoint host name. */
    readerEndpoint: string | undefined;
    /** Port the cluster listens on (default 8182). */
    port: number | undefined;
    /** Database engine (`neptune`). */
    engine: string;
    /** Running engine version. */
    engineVersion: string | undefined;
    /** Current lifecycle status (e.g. `creating`, `available`). */
    status: string | undefined;
    /** IDs of the VPC security groups attached to the cluster. */
    vpcSecurityGroupIds: string[];
    /** Automated backup retention period, in days. */
    backupRetentionPeriod: number | undefined;
    /** Daily window during which automated backups are taken. */
    preferredBackupWindow: string | undefined;
    /** Weekly window during which maintenance may occur. */
    preferredMaintenanceWindow: string | undefined;
    /** Whether storage is encrypted at rest. */
    storageEncrypted: boolean | undefined;
    /** KMS key encrypting the cluster's storage. */
    kmsKeyId: string | undefined;
    /** Whether deletion protection is enabled. */
    deletionProtection: boolean | undefined;
    /** Whether IAM database authentication is enabled. */
    iamDatabaseAuthenticationEnabled: boolean | undefined;
    /** IAM roles associated with the cluster (bulk loader, Neptune ML). */
    associatedRoles: Array<{
      /** ARN of the associated IAM role. */
      roleArn: string | undefined;
      /** Neptune feature the role is scoped to. */
      featureName: string | undefined;
      /** Association status (`ACTIVE`, `PENDING`, `INVALID`). */
      status: string | undefined;
    }>;
    /** Serverless v2 (NCU) scaling range, if configured. */
    serverlessV2ScalingConfiguration:
      | { minCapacity: number | undefined; maxCapacity: number | undefined }
      | undefined;
    /** Instances that are members of the cluster. */
    dbClusterMembers: Array<{
      /** Identifier of the member instance. */
      dbInstanceIdentifier: string | undefined;
      /** Whether the member is the cluster's writer. */
      isClusterWriter: boolean | undefined;
      /** Failover promotion priority of the member. */
      promotionTier: number | undefined;
    }>;
    /** Immutable, region-unique identifier of the cluster. */
    dbClusterResourceId: string | undefined;
    /** Route 53 hosted zone id of the cluster endpoints. */
    hostedZoneId: string | undefined;
    /** Whether the cluster has instances in multiple Availability Zones. */
    multiAZ: boolean | undefined;
    /** Log types exported to CloudWatch Logs (e.g. `audit`). */
    enabledCloudwatchLogsExports: string[];
    /** Creation time of the cluster (ISO 8601). */
    clusterCreateTime: string | undefined;
    /** Storage type (`standard` or `iopt1`). */
    storageType: string | undefined;
    /** Whether cluster tags are copied to snapshots. */
    copyTagsToSnapshot: boolean | undefined;
    /** Tags on the cluster (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Neptune graph database cluster.
 *
 * `DBCluster` owns the writer and reader endpoints and cluster-wide
 * networking; compute is added via {@link DBInstance}. Neptune serves
 * Gremlin, openCypher, and SPARQL over the cluster endpoint (default port
 * 8182) and is reachable only from inside the VPC. Provisioning a cluster
 * plus its first instance takes ~10 minutes.
 *
 * Mutable fields are reconciled in place against the observed cloud state;
 * immutable fields (`engine`, `dbSubnetGroupName`, `storageEncrypted`,
 * `kmsKeyId`, `globalClusterIdentifier`, `availabilityZones`) force a
 * replacement.
 * @resource
 * @section Creating a Cluster
 * @example Neptune cluster with IAM auth
 * ```typescript
 * const cluster = yield* DBCluster("Graph", {
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 *   vpcSecurityGroupIds: [sg.groupId],
 *   enableIAMDatabaseAuthentication: true,
 *   backupRetentionPeriod: "1 day",
 *   deletionProtection: false,
 * });
 * ```
 *
 * @section Serverless
 * @example Serverless v2 cluster (pair with a `db.serverless` instance)
 * ```typescript
 * const cluster = yield* DBCluster("Graph", {
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 *   serverlessV2ScalingConfiguration: {
 *     minCapacity: 1,
 *     maxCapacity: 2.5,
 *   },
 * });
 * ```
 */
export const DBCluster = Resource<DBCluster>("AWS.Neptune.DBCluster");

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

const toAttrs = ({
  cluster,
  tags,
}: {
  cluster: neptune.DBCluster;
  tags: Record<string, string>;
}): DBCluster["Attributes"] => ({
  dbClusterIdentifier: cluster.DBClusterIdentifier ?? "",
  dbClusterArn: cluster.DBClusterArn ?? "",
  dbSubnetGroupName: cluster.DBSubnetGroup,
  dbClusterParameterGroupName: cluster.DBClusterParameterGroup,
  endpoint: cluster.Endpoint,
  readerEndpoint: cluster.ReaderEndpoint,
  port: cluster.Port,
  engine: cluster.Engine ?? "neptune",
  engineVersion: cluster.EngineVersion,
  status: cluster.Status,
  vpcSecurityGroupIds: (cluster.VpcSecurityGroups ?? []).flatMap((group) =>
    group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
  ),
  backupRetentionPeriod: cluster.BackupRetentionPeriod,
  preferredBackupWindow: cluster.PreferredBackupWindow,
  preferredMaintenanceWindow: cluster.PreferredMaintenanceWindow,
  storageEncrypted: cluster.StorageEncrypted,
  kmsKeyId: cluster.KmsKeyId,
  deletionProtection: cluster.DeletionProtection,
  iamDatabaseAuthenticationEnabled: cluster.IAMDatabaseAuthenticationEnabled,
  associatedRoles: (cluster.AssociatedRoles ?? []).map((role) => ({
    roleArn: role.RoleArn,
    featureName: role.FeatureName,
    status: role.Status,
  })),
  serverlessV2ScalingConfiguration: cluster.ServerlessV2ScalingConfiguration
    ? {
        minCapacity: cluster.ServerlessV2ScalingConfiguration.MinCapacity,
        maxCapacity: cluster.ServerlessV2ScalingConfiguration.MaxCapacity,
      }
    : undefined,
  dbClusterMembers: (cluster.DBClusterMembers ?? []).map((member) => ({
    dbInstanceIdentifier: member.DBInstanceIdentifier,
    isClusterWriter: member.IsClusterWriter,
    promotionTier: member.PromotionTier,
  })),
  dbClusterResourceId: cluster.DbClusterResourceId,
  hostedZoneId: cluster.HostedZoneId,
  multiAZ: cluster.MultiAZ,
  enabledCloudwatchLogsExports: cluster.EnabledCloudwatchLogsExports ?? [],
  clusterCreateTime: cluster.ClusterCreateTime?.toISOString(),
  storageType: cluster.StorageType,
  copyTagsToSnapshot: cluster.CopyTagsToSnapshot,
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
): neptune.CloudwatchLogsExportConfiguration | undefined => {
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
        const response = yield* neptune
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

      const readTags = Effect.fn(function* (arn: string | undefined) {
        if (!arn) return {} as Record<string, string>;
        const response = yield* neptune
          .listTagsForResource({ ResourceName: arn })
          .pipe(
            Effect.catchTag("DBClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return toTagRecord(response?.TagList);
      });

      // Bounded readiness wait. Gate on cluster `Status === "available"` so a
      // follow-on `modifyDBCluster` doesn't hit `InvalidDBClusterStateFault`.
      // Budgets ~10 min (60 * 10s) for slow provisioning.
      const waitForCluster = Effect.fn(function* (clusterId: string) {
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
            if (cluster.Status !== "available") {
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
        // AWS account/region collection: the RDS-family control plane serves
        // clusters for every engine (RDS, DocumentDB, Neptune), so filter to
        // `engine = neptune`. Tags are not surfaced inline — mirror
        // `DBSubnetGroup.list` and emit an empty tag map rather than a
        // per-item `listTagsForResource` fan-out.
        list: () =>
          neptune.describeDBClusters
            .pages({ Filters: [{ Name: "engine", Values: ["neptune"] }] })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.DBClusters ?? []).map((cluster) =>
                    toAttrs({ cluster, tags: {} }),
                  ),
                ),
              ),
            ),
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
            ((olds.engine ?? "neptune") !== (news.engine ?? "neptune") ||
              olds.dbSubnetGroupName !== news.dbSubnetGroupName ||
              olds.storageEncrypted !== news.storageEncrypted ||
              olds.kmsKeyId !== news.kmsKeyId ||
              olds.globalClusterIdentifier !== news.globalClusterIdentifier ||
              JSON.stringify(olds.availabilityZones ?? []) !==
                JSON.stringify(news.availabilityZones ?? []))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbClusterIdentifier ??
            (yield* toIdentifier(id, olds ?? ({} as DBClusterProps)));
          const cluster = yield* readCluster(identifier);
          if (!cluster?.DBClusterArn) {
            return undefined;
          }
          const tags = yield* readTags(cluster.DBClusterArn);
          return toAttrs({ cluster, tags });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.dbClusterIdentifier ?? (yield* toIdentifier(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          // The wire field is whole days.
          const backupRetentionDays = toWireDays(news.backupRetentionPeriod);

          // Observe — fetch live cluster state.
          let observed = yield* readCluster(identifier);

          // Ensure — create the cluster if it's missing. Tolerate
          // `DBClusterAlreadyExistsFault` as a race with a peer reconciler.
          if (!observed?.DBClusterArn) {
            yield* neptune
              .createDBCluster({
                DBClusterIdentifier: identifier,
                Engine: news.engine ?? "neptune",
                EngineVersion: news.engineVersion,
                DBSubnetGroupName: news.dbSubnetGroupName,
                DBClusterParameterGroupName: news.dbClusterParameterGroupName,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                Port: news.port,
                AvailabilityZones: news.availabilityZones,
                BackupRetentionPeriod: backupRetentionDays,
                PreferredBackupWindow: news.preferredBackupWindow,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                EnableCloudwatchLogsExports: news.enableCloudwatchLogsExports,
                EnableIAMDatabaseAuthentication:
                  news.enableIAMDatabaseAuthentication,
                ServerlessV2ScalingConfiguration:
                  news.serverlessV2ScalingConfiguration
                    ? {
                        MinCapacity:
                          news.serverlessV2ScalingConfiguration.minCapacity,
                        MaxCapacity:
                          news.serverlessV2ScalingConfiguration.maxCapacity,
                      }
                    : undefined,
                DeletionProtection: news.deletionProtection,
                StorageEncrypted: news.storageEncrypted,
                KmsKeyId: news.kmsKeyId,
                StorageType: news.storageType,
                CopyTagsToSnapshot: news.copyTagsToSnapshot,
                GlobalClusterIdentifier: news.globalClusterIdentifier,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
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
            const core: neptune.ModifyDBClusterMessage = {
              DBClusterIdentifier: identifier,
              ApplyImmediately: true,
            };
            let coreDirty = false;
            const setIf = <K extends keyof neptune.ModifyDBClusterMessage>(
              key: K,
              desired: neptune.ModifyDBClusterMessage[K] | undefined,
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
            setIf("DeletionProtection", news.deletionProtection, observed.DeletionProtection); // prettier-ignore
            setIf("StorageType", news.storageType, observed.StorageType);
            setIf("CopyTagsToSnapshot", news.copyTagsToSnapshot, observed.CopyTagsToSnapshot); // prettier-ignore
            setIf("EnableIAMDatabaseAuthentication", news.enableIAMDatabaseAuthentication, observed.IAMDatabaseAuthenticationEnabled); // prettier-ignore
            setIf("DBClusterParameterGroupName", news.dbClusterParameterGroupName, observed.DBClusterParameterGroup); // prettier-ignore
            if (news.vpcSecurityGroupIds !== undefined) {
              const observedGroups = (observed.VpcSecurityGroups ?? [])
                .flatMap((g) =>
                  g.VpcSecurityGroupId ? [g.VpcSecurityGroupId] : [],
                )
                .sort();
              if (
                JSON.stringify(observedGroups) !==
                JSON.stringify([...news.vpcSecurityGroupIds].sort())
              ) {
                core.VpcSecurityGroupIds = news.vpcSecurityGroupIds;
                coreDirty = true;
              }
            }
            if (news.serverlessV2ScalingConfiguration !== undefined) {
              const observedScaling = observed.ServerlessV2ScalingConfiguration;
              if (
                observedScaling?.MinCapacity !==
                  news.serverlessV2ScalingConfiguration.minCapacity ||
                observedScaling?.MaxCapacity !==
                  news.serverlessV2ScalingConfiguration.maxCapacity
              ) {
                core.ServerlessV2ScalingConfiguration = {
                  MinCapacity:
                    news.serverlessV2ScalingConfiguration.minCapacity,
                  MaxCapacity:
                    news.serverlessV2ScalingConfiguration.maxCapacity,
                };
                coreDirty = true;
              }
            }
            if (news.allowMajorVersionUpgrade) {
              core.AllowMajorVersionUpgrade = true;
            }
            if (coreDirty) {
              yield* neptune.modifyDBCluster(core);
              observed = yield* waitForCluster(identifier);
            }

            // syncCloudwatchLogsExports — delta-shaped; separate call.
            const logDelta = logExportDelta(
              observed.EnabledCloudwatchLogsExports,
              news.enableCloudwatchLogsExports,
            );
            if (logDelta) {
              yield* neptune.modifyDBCluster({
                DBClusterIdentifier: identifier,
                CloudwatchLogsExportConfiguration: logDelta,
                ApplyImmediately: true,
              });
              observed = yield* waitForCluster(identifier);
            }
          }

          // Sync associated IAM roles — diff observed cloud associations
          // against desired. Only runs when the prop is set, so clusters
          // that don't manage roles through Alchemy are left untouched.
          if (news.associatedRoles !== undefined) {
            const roleKey = (
              roleArn: string | undefined,
              featureName: string | undefined,
            ) => `${roleArn ?? ""}|${featureName ?? ""}`;
            const observedRoles = observed.AssociatedRoles ?? [];
            const observedKeys = new Set(
              observedRoles.map((role) =>
                roleKey(role.RoleArn, role.FeatureName),
              ),
            );
            const desiredKeys = new Set(
              news.associatedRoles.map((role) =>
                roleKey(role.roleArn, role.featureName),
              ),
            );
            for (const role of news.associatedRoles) {
              if (!observedKeys.has(roleKey(role.roleArn, role.featureName))) {
                yield* neptune
                  .addRoleToDBCluster({
                    DBClusterIdentifier: identifier,
                    RoleArn: role.roleArn,
                    FeatureName: role.featureName,
                  })
                  .pipe(
                    Effect.catchTag(
                      "DBClusterRoleAlreadyExistsFault",
                      () => Effect.void,
                    ),
                  );
              }
            }
            for (const role of observedRoles) {
              if (
                role.RoleArn !== undefined &&
                !desiredKeys.has(roleKey(role.RoleArn, role.FeatureName))
              ) {
                yield* neptune
                  .removeRoleFromDBCluster({
                    DBClusterIdentifier: identifier,
                    RoleArn: role.RoleArn,
                    FeatureName: role.FeatureName,
                  })
                  .pipe(
                    Effect.catchTag(
                      "DBClusterRoleNotFoundFault",
                      () => Effect.void,
                    ),
                  );
              }
            }
            // Re-observe so the returned attributes carry the fresh
            // associations.
            observed = (yield* readCluster(identifier)) ?? observed;
          }

          const dbClusterArn = observed.DBClusterArn ?? "";

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = yield* readTags(dbClusterArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbClusterArn) {
            yield* neptune.addTagsToResource({
              ResourceName: dbClusterArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbClusterArn) {
            yield* neptune.removeTagsFromResource({
              ResourceName: dbClusterArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbClusterArn || identifier);
          return toAttrs({ cluster: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* neptune
            .deleteDBCluster({
              DBClusterIdentifier: output.dbClusterIdentifier,
              SkipFinalSnapshot: true,
            })
            .pipe(Effect.catchTag("DBClusterNotFoundFault", () => Effect.void));
          // Block until the cluster is fully gone. Neptune deletion is async;
          // if we return while it is still `deleting`, a dependent
          // (DBSubnetGroup or VPC) is torn down next and AWS rejects it.
          yield* Effect.repeat(
            neptune
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
