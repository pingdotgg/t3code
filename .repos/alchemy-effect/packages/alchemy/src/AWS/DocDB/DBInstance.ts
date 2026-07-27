import * as docdb from "@distilled.cloud/aws/docdb";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBInstanceProps {
  /**
   * Instance identifier. If omitted, Alchemy generates one.
   */
  dbInstanceIdentifier?: string;
  /**
   * DocumentDB cluster the instance belongs to. Required — every DocumentDB
   * instance is a cluster member. Immutable — forces replacement.
   */
  dbClusterIdentifier: string;
  /**
   * Instance class such as `db.r6g.large` or `db.t3.medium`. In-place modify.
   */
  dbInstanceClass: string;
  /**
   * Database engine. DocumentDB only supports `docdb`.
   * Changing the engine forces replacement.
   * @default "docdb"
   */
  engine?: string;
  /**
   * Availability zone. Immutable — forces replacement.
   */
  availabilityZone?: string;
  /**
   * Weekly maintenance window, e.g. `Mon:00:00-Mon:03:00`. In-place modify.
   */
  preferredMaintenanceWindow?: string;
  /**
   * Auto minor version upgrades. In-place modify.
   */
  autoMinorVersionUpgrade?: boolean;
  /**
   * Promotion tier inside the cluster (0-15). In-place modify.
   */
  promotionTier?: number;
  /**
   * Enable Performance Insights. In-place modify.
   */
  enablePerformanceInsights?: boolean;
  /**
   * KMS key for Performance Insights. In-place modify.
   */
  performanceInsightsKMSKeyId?: string;
  /**
   * CA certificate identifier. In-place modify.
   */
  caCertificateIdentifier?: string;
  /**
   * Copy tags to snapshots. In-place modify.
   */
  copyTagsToSnapshot?: boolean;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBInstance extends Resource<
  "AWS.DocDB.DBInstance",
  DBInstanceProps,
  {
    /** The instance identifier (unique per account/region). */
    dbInstanceIdentifier: string;
    /** The ARN of the instance. */
    dbInstanceArn: string;
    /** The cluster this instance belongs to. */
    dbClusterIdentifier: string | undefined;
    /** The instance endpoint hostname. */
    endpointAddress: string | undefined;
    /** The port the instance accepts connections on. */
    endpointPort: number | undefined;
    /** The compute class of the instance, e.g. `db.t3.medium`. */
    dbInstanceClass: string | undefined;
    /** The database engine (`docdb`). */
    engine: string | undefined;
    /** The engine version running on the instance. */
    engineVersion: string | undefined;
    /** The current status of the instance, e.g. `available`. */
    status: string | undefined;
    /** The failover promotion tier of the instance. */
    promotionTier: number | undefined;
    /** Whether the instance is publicly accessible. */
    publiclyAccessible: boolean | undefined;
    /** The DB subnet group the instance is deployed into. */
    dbSubnetGroupName: string | undefined;
    /** The Availability Zone the instance runs in. */
    availabilityZone: string | undefined;
    /** The weekly window during which maintenance can occur. */
    preferredMaintenanceWindow: string | undefined;
    /** Number of days automated backups are retained (cluster-managed). */
    backupRetentionPeriod: number | undefined;
    /** The KMS key used for storage encryption. */
    kmsKeyId: string | undefined;
    /** Whether storage is encrypted at rest. */
    storageEncrypted: boolean | undefined;
    /** The CA certificate identifier used by the instance. */
    caCertificateIdentifier: string | undefined;
    /** Whether Performance Insights is enabled. */
    performanceInsightsEnabled: boolean | undefined;
    /** The log types exported to CloudWatch Logs. */
    enabledCloudwatchLogsExports: string[];
    /** The immutable region-unique resource ID of the instance. */
    dbiResourceId: string | undefined;
    /** Whether minor engine upgrades apply automatically. */
    autoMinorVersionUpgrade: boolean | undefined;
    /** Whether instance tags are copied to snapshots. */
    copyTagsToSnapshot: boolean | undefined;
    /** The tags attached to the instance. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon DocumentDB instance — a compute member of a DocumentDB
 * {@link DBCluster}. Storage, backup, and endpoints are managed at the cluster
 * level; the instance contributes CPU/RAM and can serve as a writer or reader.
 * Provisioning takes several minutes.
 *
 * Mutable fields (`dbInstanceClass`, `promotionTier`, maintenance window,
 * monitoring) are reconciled in place; immutable fields (`engine`,
 * `dbClusterIdentifier`, `availabilityZone`) force a replacement.
 * @resource
 * @section Adding an Instance
 * @example A DocumentDB writer instance
 * ```typescript
 * const writer = yield* DBInstance("Writer", {
 *   dbClusterIdentifier: cluster.dbClusterIdentifier,
 *   dbInstanceClass: "db.t3.medium",
 * });
 * ```
 */
export const DBInstance = Resource<DBInstance>("AWS.DocDB.DBInstance");

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
  instance,
  tags,
}: {
  instance: docdb.DBInstance;
  tags: Record<string, string>;
}): DBInstance["Attributes"] => ({
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
  availabilityZone: instance.AvailabilityZone,
  preferredMaintenanceWindow: instance.PreferredMaintenanceWindow,
  backupRetentionPeriod: instance.BackupRetentionPeriod,
  kmsKeyId: instance.KmsKeyId,
  storageEncrypted: instance.StorageEncrypted,
  caCertificateIdentifier: instance.CACertificateIdentifier,
  performanceInsightsEnabled: instance.PerformanceInsightsEnabled,
  enabledCloudwatchLogsExports: instance.EnabledCloudwatchLogsExports ?? [],
  dbiResourceId: instance.DbiResourceId,
  autoMinorVersionUpgrade: instance.AutoMinorVersionUpgrade,
  copyTagsToSnapshot: instance.CopyTagsToSnapshot,
  tags,
});

export const DBInstanceProvider = () =>
  Provider.effect(
    DBInstance,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBInstanceProps) =>
        props.dbInstanceIdentifier
          ? Effect.succeed(props.dbInstanceIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readInstance = Effect.fn(function* (instanceId: string) {
        const response = yield* docdb
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

      const readTags = Effect.fn(function* (arn: string | undefined) {
        if (!arn) return {} as Record<string, string>;
        const response = yield* docdb
          .listTagsForResource({ ResourceName: arn })
          .pipe(
            Effect.catchTag("DBInstanceNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return toTagRecord(response?.TagList);
      });

      // Bounded readiness wait. Gate on `DBInstanceStatus === "available"` so a
      // follow-on `modifyDBInstance` doesn't hit `InvalidDBInstanceStateFault`.
      // Budgets ~10 min (60 * 10s) for slow provisioning.
      const waitForInstance = Effect.fn(function* (instanceId: string) {
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
            const status = instance.DBInstanceStatus;
            if (
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
        // AWS account/region collection: `describeDBInstances` is paginated
        // (items: "DBInstances"). DocumentDB does not surface tags inline, so
        // we emit an empty tag map rather than a per-item `listTagsForResource`
        // fan-out. `DBInstanceNotFoundFault` is in the op's typed error union;
        // treat a stray one as "nothing to list".
        list: () =>
          docdb.describeDBInstances.pages({}).pipe(
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
                  .map((instance) => toAttrs({ instance, tags: {} })),
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
            ((olds.engine ?? "docdb") !== (news.engine ?? "docdb") ||
              olds.dbClusterIdentifier !== news.dbClusterIdentifier ||
              olds.availabilityZone !== news.availabilityZone)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbInstanceIdentifier ??
            (yield* toIdentifier(
              id,
              olds ??
                ({
                  dbClusterIdentifier: "",
                  dbInstanceClass: "",
                } as DBInstanceProps),
            ));
          const instance = yield* readInstance(identifier);
          if (!instance?.DBInstanceArn) {
            return undefined;
          }
          const tags = yield* readTags(instance.DBInstanceArn);
          return toAttrs({ instance, tags });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.dbInstanceIdentifier ?? (yield* toIdentifier(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live instance state.
          let observed = yield* readInstance(identifier);

          // Ensure — create if missing. Tolerate
          // `DBInstanceAlreadyExistsFault` as a race with a peer reconciler.
          if (!observed?.DBInstanceArn) {
            yield* docdb
              .createDBInstance({
                DBInstanceIdentifier: identifier,
                DBClusterIdentifier: news.dbClusterIdentifier,
                DBInstanceClass: news.dbInstanceClass,
                Engine: news.engine ?? "docdb",
                AvailabilityZone: news.availabilityZone,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade,
                PromotionTier: news.promotionTier,
                EnablePerformanceInsights: news.enablePerformanceInsights,
                PerformanceInsightsKMSKeyId: news.performanceInsightsKMSKeyId,
                CACertificateIdentifier: news.caCertificateIdentifier,
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
            // from the observed cloud state.
            const core: docdb.ModifyDBInstanceMessage = {
              DBInstanceIdentifier: identifier,
              ApplyImmediately: true,
            };
            let coreDirty = false;
            const setIf = <K extends keyof docdb.ModifyDBInstanceMessage>(
              key: K,
              desired: docdb.ModifyDBInstanceMessage[K] | undefined,
              observedValue: unknown,
            ) => {
              if (desired !== undefined && desired !== observedValue) {
                core[key] = desired;
                coreDirty = true;
              }
            };
            setIf("DBInstanceClass", news.dbInstanceClass, observed.DBInstanceClass); // prettier-ignore
            setIf("PreferredMaintenanceWindow", news.preferredMaintenanceWindow, observed.PreferredMaintenanceWindow); // prettier-ignore
            setIf("AutoMinorVersionUpgrade", news.autoMinorVersionUpgrade, observed.AutoMinorVersionUpgrade); // prettier-ignore
            setIf("PromotionTier", news.promotionTier, observed.PromotionTier);
            setIf("EnablePerformanceInsights", news.enablePerformanceInsights, observed.PerformanceInsightsEnabled); // prettier-ignore
            setIf("PerformanceInsightsKMSKeyId", news.performanceInsightsKMSKeyId, observed.PerformanceInsightsKMSKeyId); // prettier-ignore
            setIf("CACertificateIdentifier", news.caCertificateIdentifier, observed.CACertificateIdentifier); // prettier-ignore
            setIf("CopyTagsToSnapshot", news.copyTagsToSnapshot, observed.CopyTagsToSnapshot); // prettier-ignore
            if (coreDirty) {
              yield* docdb.modifyDBInstance(core);
              observed = yield* waitForInstance(identifier);
            }
          }

          const dbInstanceArn = observed.DBInstanceArn ?? "";

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = yield* readTags(dbInstanceArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbInstanceArn) {
            yield* docdb.addTagsToResource({
              ResourceName: dbInstanceArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbInstanceArn) {
            yield* docdb.removeTagsFromResource({
              ResourceName: dbInstanceArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbInstanceArn || identifier);
          return toAttrs({ instance: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* docdb
            .deleteDBInstance({
              DBInstanceIdentifier: output.dbInstanceIdentifier,
            })
            .pipe(
              Effect.catchTag("DBInstanceNotFoundFault", () => Effect.void),
            );
          // Block until the instance is fully gone so a dependent cluster or
          // subnet group is not torn down while DocumentDB still references it.
          yield* Effect.repeat(
            docdb
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
                Schedule.recurs(40),
              ]),
              until: (exists) => exists === false,
            },
          ).pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );
