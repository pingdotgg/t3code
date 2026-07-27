import * as neptune from "@distilled.cloud/aws/neptune";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface DBInstanceProps {
  /**
   * Instance identifier. If omitted, Alchemy generates one.
   */
  dbInstanceIdentifier?: string;
  /**
   * Neptune cluster the instance belongs to. Required — every Neptune
   * instance is a cluster member. Immutable — forces replacement.
   */
  dbClusterIdentifier: string;
  /**
   * Instance class such as `db.r6g.large`, `db.t4g.medium`, or
   * `db.serverless` (requires the cluster to have a
   * `serverlessV2ScalingConfiguration`). In-place modify.
   */
  dbInstanceClass: string;
  /**
   * Database engine. Neptune only supports `neptune`.
   * Changing the engine forces replacement.
   * @default "neptune"
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
   * DB (instance-level) parameter group name. In-place modify.
   */
  dbParameterGroupName?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBInstance extends Resource<
  "AWS.Neptune.DBInstance",
  DBInstanceProps,
  {
    /** Identifier of the instance. */
    dbInstanceIdentifier: string;
    /** ARN of the instance. */
    dbInstanceArn: string;
    /** Identifier of the cluster the instance belongs to. */
    dbClusterIdentifier: string | undefined;
    /** Instance endpoint host name. */
    endpointAddress: string | undefined;
    /** Port the instance listens on. */
    endpointPort: number | undefined;
    /** Compute class of the instance (e.g. `db.r5.large`, `db.serverless`). */
    dbInstanceClass: string | undefined;
    /** Database engine (`neptune`). */
    engine: string | undefined;
    /** Running engine version. */
    engineVersion: string | undefined;
    /** Current lifecycle status (e.g. `creating`, `available`). */
    status: string | undefined;
    /** Failover promotion priority of the instance. */
    promotionTier: number | undefined;
    /** Name of the subnet group the instance is placed in. */
    dbSubnetGroupName: string | undefined;
    /** Availability Zone the instance runs in. */
    availabilityZone: string | undefined;
    /** Weekly window during which maintenance may occur. */
    preferredMaintenanceWindow: string | undefined;
    /** Whether storage is encrypted at rest. */
    storageEncrypted: boolean | undefined;
    /** KMS key encrypting the instance's storage. */
    kmsKeyId: string | undefined;
    /** Immutable, region-unique identifier of the instance. */
    dbiResourceId: string | undefined;
    /** Whether minor engine upgrades are applied automatically. */
    autoMinorVersionUpgrade: boolean | undefined;
    /** Tags on the instance (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Neptune instance — a compute member of a Neptune
 * {@link DBCluster}. Storage, backup, and endpoints are managed at the
 * cluster level; the instance contributes CPU/RAM and can serve as a writer
 * or reader. Provisioning takes several minutes.
 *
 * Mutable fields (`dbInstanceClass`, `promotionTier`, maintenance window)
 * are reconciled in place; immutable fields (`engine`,
 * `dbClusterIdentifier`, `availabilityZone`) force a replacement.
 * @resource
 * @section Adding an Instance
 * @example A Neptune writer instance
 * ```typescript
 * const writer = yield* DBInstance("Writer", {
 *   dbClusterIdentifier: cluster.dbClusterIdentifier,
 *   dbInstanceClass: "db.t4g.medium",
 * });
 * ```
 *
 * @example A serverless instance
 * ```typescript
 * const writer = yield* DBInstance("Writer", {
 *   dbClusterIdentifier: cluster.dbClusterIdentifier,
 *   dbInstanceClass: "db.serverless",
 * });
 * ```
 */
export const DBInstance = Resource<DBInstance>("AWS.Neptune.DBInstance");

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
  instance: neptune.DBInstance;
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
  dbSubnetGroupName: instance.DBSubnetGroup?.DBSubnetGroupName,
  availabilityZone: instance.AvailabilityZone,
  preferredMaintenanceWindow: instance.PreferredMaintenanceWindow,
  storageEncrypted: instance.StorageEncrypted,
  kmsKeyId: instance.KmsKeyId,
  dbiResourceId: instance.DbiResourceId,
  autoMinorVersionUpgrade: instance.AutoMinorVersionUpgrade,
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
        const response = yield* neptune
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
        const response = yield* neptune
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
        // AWS account/region collection: the RDS-family control plane serves
        // instances for every engine, so filter to `engine = neptune`. Tags
        // are not surfaced inline — emit an empty tag map rather than a
        // per-item `listTagsForResource` fan-out.
        list: () =>
          neptune.describeDBInstances
            .pages({ Filters: [{ Name: "engine", Values: ["neptune"] }] })
            .pipe(
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
            ((olds.engine ?? "neptune") !== (news.engine ?? "neptune") ||
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
            yield* neptune
              .createDBInstance({
                DBInstanceIdentifier: identifier,
                DBClusterIdentifier: news.dbClusterIdentifier,
                DBInstanceClass: news.dbInstanceClass,
                Engine: news.engine ?? "neptune",
                AvailabilityZone: news.availabilityZone,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade,
                PromotionTier: news.promotionTier,
                DBParameterGroupName: news.dbParameterGroupName,
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
            const core: neptune.ModifyDBInstanceMessage = {
              DBInstanceIdentifier: identifier,
              ApplyImmediately: true,
            };
            let coreDirty = false;
            const setIf = <K extends keyof neptune.ModifyDBInstanceMessage>(
              key: K,
              desired: neptune.ModifyDBInstanceMessage[K] | undefined,
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
            setIf("DBParameterGroupName", news.dbParameterGroupName, observed.DBParameterGroups?.[0]?.DBParameterGroupName); // prettier-ignore
            if (coreDirty) {
              yield* neptune.modifyDBInstance(core);
              observed = yield* waitForInstance(identifier);
            }
          }

          const dbInstanceArn = observed.DBInstanceArn ?? "";

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = yield* readTags(dbInstanceArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbInstanceArn) {
            yield* neptune.addTagsToResource({
              ResourceName: dbInstanceArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbInstanceArn) {
            yield* neptune.removeTagsFromResource({
              ResourceName: dbInstanceArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbInstanceArn || identifier);
          return toAttrs({ instance: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* neptune
            .deleteDBInstance({
              DBInstanceIdentifier: output.dbInstanceIdentifier,
              SkipFinalSnapshot: true,
            })
            .pipe(
              Effect.catchTag("DBInstanceNotFoundFault", () => Effect.void),
            );
          // Block until the instance is fully gone so a dependent cluster or
          // subnet group is not torn down while Neptune still references it.
          yield* Effect.repeat(
            neptune
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
