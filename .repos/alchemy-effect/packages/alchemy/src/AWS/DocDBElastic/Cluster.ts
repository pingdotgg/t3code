import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

export interface ClusterProps {
  /**
   * Name of the elastic cluster. If omitted, a deterministic physical name
   * is generated. Changing the name replaces the cluster.
   */
  clusterName?: string;
  /**
   * Name of the administrator account for the elastic cluster. Changing the
   * admin user name replaces the cluster.
   */
  adminUserName: string;
  /**
   * Password for the administrator account. Must be 8-100 printable ASCII
   * characters (no `/`, `"` or `@`). The cloud never reports the current
   * password, so password rotation is detected by comparing against the
   * previously deployed value.
   */
  adminUserPassword: Redacted.Redacted<string>;
  /**
   * Authentication type — `"PLAIN_TEXT"` (the password is the literal
   * credential) or `"SECRET_ARN"` (the password is a Secrets Manager ARN).
   * @default "PLAIN_TEXT"
   */
  authType?: string;
  /**
   * Capacity of each shard in vCPUs. Valid values: 2, 4, 8, 16, 32, 64.
   * Updated in place.
   * @default 2
   */
  shardCapacity?: number;
  /**
   * Number of shards in the cluster (1-32). Updated in place.
   * @default 1
   */
  shardCount?: number;
  /**
   * Number of replica instances per shard (1-16).
   * @default 1
   */
  shardInstanceCount?: number;
  /**
   * VPC security groups that control network access to the cluster
   * endpoint.
   * @default the VPC's default security group
   */
  vpcSecurityGroupIds?: string[];
  /**
   * VPC subnet IDs the cluster spans. Must cover at least two Availability
   * Zones (three for production workloads).
   * @default the default VPC's subnets
   */
  subnetIds?: string[];
  /**
   * Customer-managed KMS key for encryption at rest. Changing the key
   * replaces the cluster.
   * @default AWS-owned key
   */
  kmsKeyId?: string;
  /**
   * Weekly maintenance window, e.g. `"sun:23:00-mon:01:30"` (UTC).
   */
  preferredMaintenanceWindow?: string;
  /**
   * How long automatic snapshots are retained, e.g. `"7 days"` or
   * `Duration.days(7)`. Rounded to whole days (1-35) on the wire.
   */
  backupRetentionPeriod?: Duration.Input;
  /**
   * Daily window (UTC, `HH:MM-HH:MM`) when automatic snapshots are taken.
   */
  preferredBackupWindow?: string;
  /**
   * User-defined tags for the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.DocDBElastic.Cluster",
  ClusterProps,
  {
    /** The name of the elastic cluster. */
    clusterName: string;
    /** The ARN of the elastic cluster. */
    clusterArn: string;
    /** The current status of the cluster, e.g. `ACTIVE`. */
    status: string;
    /** The MongoDB-compatible connection endpoint. */
    clusterEndpoint: string | undefined;
    /** The administrator username. */
    adminUserName: string;
    /** The authentication type (`PLAIN_TEXT` or `SECRET_ARN`). */
    authType: string;
    /** vCPU capacity of each shard (2, 4, 8, 16, 32, or 64). */
    shardCapacity: number;
    /** Number of shards in the cluster. */
    shardCount: number;
    /** Number of replica instances per shard. */
    shardInstanceCount: number | undefined;
    /** The VPC security groups attached to the cluster. */
    vpcSecurityGroupIds: string[];
    /** The subnets the cluster is deployed into. */
    subnetIds: string[];
    /** The KMS key used for encryption at rest. */
    kmsKeyId: string;
    /** The weekly window during which maintenance can occur. */
    preferredMaintenanceWindow: string;
    /** Number of days automated backups are retained. */
    backupRetentionPeriod: number | undefined;
    /** The daily window during which automated backups run. */
    preferredBackupWindow: string | undefined;
    /** The tags attached to the cluster. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon DocumentDB elastic cluster — a MongoDB-compatible, sharded
 * document database that scales workloads to millions of reads/writes per
 * second without managing instances.
 *
 * Elastic clusters take roughly 8-10 minutes to provision and bill per
 * shard-vCPU-hour while they exist. They are reachable only from inside a
 * VPC. Destroy clusters you are not using.
 * @resource
 * @section Creating a Cluster
 * @example Minimal Elastic Cluster
 * ```typescript
 * const cluster = yield* Cluster("Documents", {
 *   adminUserName: "admin",
 *   adminUserPassword: Redacted.make("super-secret-password"),
 *   shardCapacity: 2,
 *   shardCount: 1,
 * });
 * ```
 *
 * @example Cluster Pinned to Specific Subnets
 * ```typescript
 * const cluster = yield* Cluster("Documents", {
 *   adminUserName: "admin",
 *   adminUserPassword: Redacted.make("super-secret-password"),
 *   shardCapacity: 2,
 *   shardCount: 1,
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   vpcSecurityGroupIds: [securityGroup.securityGroupId],
 *   backupRetentionPeriod: "1 day",
 * });
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.DocDBElastic.Cluster");

const DEFAULT_AUTH_TYPE = "PLAIN_TEXT";
const DEFAULT_SHARD_CAPACITY = 2;
const DEFAULT_SHARD_COUNT = 1;

/** True when two string sets are equal ignoring order and duplicates. */
const sameStringSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...new Set(a ?? [])].sort();
  const right = [...new Set(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ClusterProps>) =>
        props.clusterName
          ? Effect.succeed(props.clusterName)
          : createPhysicalName({ id, maxLength: 50, lowercase: true });

      const getByArn = Effect.fn(function* (arn: string) {
        const response = yield* docdbelastic
          .getCluster({ clusterArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.cluster;
      });

      // Elastic clusters are addressed by ARN (which embeds a server-side
      // UUID), so a name-based lookup scans the paginated list.
      const findByName = Effect.fn(function* (name: string) {
        const matches = yield* docdbelastic.listClusters.items({}).pipe(
          Stream.filter((cluster) => cluster.clusterName === name),
          Stream.take(1),
          Stream.runCollect,
        );
        const summary = Array.from(matches)[0];
        if (summary === undefined) return undefined;
        return yield* getByArn(summary.clusterArn);
      });

      const readCluster = Effect.fn(function* (
        name: string,
        arn: string | undefined,
      ) {
        if (arn !== undefined) {
          const cluster = yield* getByArn(arn);
          if (cluster !== undefined) return cluster;
        }
        return yield* findByName(name);
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* docdbelastic
          .listTagsForResource({ resourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return toTagRecord(response?.tags);
      });

      // Bounded readiness wait. Elastic cluster provisioning/modification
      // typically completes in 8-10 minutes; budget ~20 min (80 * 15s).
      const waitForActive = Effect.fn(function* (
        name: string,
        arn: string | undefined,
      ) {
        const policy = Schedule.max([
          Schedule.fixed("15 seconds"),
          Schedule.recurs(80),
        ]);
        return yield* readCluster(name, arn).pipe(
          Effect.flatMap((cluster) => {
            if (cluster === undefined) {
              return Effect.fail(
                new Error(`Elastic cluster '${name}' not found`),
              );
            }
            if (cluster.status !== "ACTIVE") {
              return Effect.fail(
                new Error(
                  `Elastic cluster '${name}' not active (status: ${cluster.status})`,
                ),
              );
            }
            return Effect.succeed(cluster);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      const toAttrs = Effect.fn(function* (cluster: docdbelastic.Cluster) {
        return {
          clusterName: cluster.clusterName,
          clusterArn: cluster.clusterArn,
          status: cluster.status,
          clusterEndpoint: cluster.clusterEndpoint,
          adminUserName: cluster.adminUserName,
          authType: cluster.authType,
          shardCapacity: cluster.shardCapacity,
          shardCount: cluster.shardCount,
          shardInstanceCount: cluster.shardInstanceCount,
          vpcSecurityGroupIds: [...cluster.vpcSecurityGroupIds],
          subnetIds: [...cluster.subnetIds],
          kmsKeyId: cluster.kmsKeyId,
          preferredMaintenanceWindow: cluster.preferredMaintenanceWindow,
          backupRetentionPeriod: cluster.backupRetentionPeriod,
          preferredBackupWindow: cluster.preferredBackupWindow,
          tags: yield* readTags(cluster.clusterArn),
        };
      });

      return {
        stables: ["clusterName", "clusterArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news;
          const o = olds;
          if (n === undefined || o === undefined) return undefined;
          if ((yield* toName(id, o)) !== (yield* toName(id, n))) {
            return { action: "replace" } as const;
          }
          // Create-only properties force a replacement.
          if (n.adminUserName !== o.adminUserName) {
            return { action: "replace" } as const;
          }
          if ((n.kmsKeyId ?? undefined) !== (o.kmsKeyId ?? undefined)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.clusterName ??
            (yield* toName(
              id,
              olds ?? {
                adminUserName: "",
                adminUserPassword: Redacted.make(""),
              },
            ));
          const cluster = yield* readCluster(name, output?.clusterArn);
          if (cluster === undefined) return undefined;
          const attrs = yield* toAttrs(cluster);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const props = news!;
          const name = output?.clusterName ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // 1. Observe — cloud state is authoritative; output is only an
          // ARN cache.
          let observed = yield* readCluster(name, output?.clusterArn);
          let created = false;

          // 2. Ensure — create if missing; tolerate a create race
          // (ConflictException) by re-reading.
          if (observed === undefined) {
            const response = yield* docdbelastic
              .createCluster({
                clusterName: name,
                adminUserName: props.adminUserName,
                adminUserPassword: props.adminUserPassword,
                authType: props.authType ?? DEFAULT_AUTH_TYPE,
                shardCapacity: props.shardCapacity ?? DEFAULT_SHARD_CAPACITY,
                shardCount: props.shardCount ?? DEFAULT_SHARD_COUNT,
                shardInstanceCount: props.shardInstanceCount,
                vpcSecurityGroupIds: props.vpcSecurityGroupIds,
                subnetIds: props.subnetIds,
                kmsKeyId: props.kmsKeyId,
                preferredMaintenanceWindow: props.preferredMaintenanceWindow,
                backupRetentionPeriod: toWireDays(props.backupRetentionPeriod),
                preferredBackupWindow: props.preferredBackupWindow,
                tags: desiredTags,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            observed = response?.cluster ?? (yield* findByName(name));
            created = true;
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(`Elastic cluster '${name}' not found after create`),
            );
          }
          const arn = observed.clusterArn;

          // Provisioning and in-flight modifications both surface as a
          // non-ACTIVE status; wait (bounded) so update calls do not hit
          // ConflictException.
          observed = yield* waitForActive(name, arn);

          // 3. Sync — compute the update delta from OBSERVED state.
          const update: docdbelastic.UpdateClusterInput = { clusterArn: arn };
          let mutated = false;
          if (
            props.shardCapacity !== undefined &&
            props.shardCapacity !== observed.shardCapacity
          ) {
            update.shardCapacity = props.shardCapacity;
            mutated = true;
          }
          if (
            props.shardCount !== undefined &&
            props.shardCount !== observed.shardCount
          ) {
            update.shardCount = props.shardCount;
            mutated = true;
          }
          if (
            props.shardInstanceCount !== undefined &&
            props.shardInstanceCount !== observed.shardInstanceCount
          ) {
            update.shardInstanceCount = props.shardInstanceCount;
            mutated = true;
          }
          if (
            props.vpcSecurityGroupIds !== undefined &&
            !sameStringSet(
              props.vpcSecurityGroupIds,
              observed.vpcSecurityGroupIds,
            )
          ) {
            update.vpcSecurityGroupIds = props.vpcSecurityGroupIds;
            mutated = true;
          }
          if (
            props.subnetIds !== undefined &&
            !sameStringSet(props.subnetIds, observed.subnetIds)
          ) {
            update.subnetIds = props.subnetIds;
            mutated = true;
          }
          if (
            props.preferredMaintenanceWindow !== undefined &&
            props.preferredMaintenanceWindow !==
              observed.preferredMaintenanceWindow
          ) {
            update.preferredMaintenanceWindow =
              props.preferredMaintenanceWindow;
            mutated = true;
          }
          const desiredRetentionDays = toWireDays(props.backupRetentionPeriod);
          if (
            desiredRetentionDays !== undefined &&
            desiredRetentionDays !== observed.backupRetentionPeriod
          ) {
            update.backupRetentionPeriod = desiredRetentionDays;
            mutated = true;
          }
          if (
            props.preferredBackupWindow !== undefined &&
            props.preferredBackupWindow !== observed.preferredBackupWindow
          ) {
            update.preferredBackupWindow = props.preferredBackupWindow;
            mutated = true;
          }
          if ((props.authType ?? DEFAULT_AUTH_TYPE) !== observed.authType) {
            update.authType = props.authType ?? DEFAULT_AUTH_TYPE;
            update.adminUserPassword = props.adminUserPassword;
            mutated = true;
          } else if (
            // The cloud never reports the password; the previously deployed
            // value is the only diff baseline (skipped right after create —
            // the password was just applied).
            !created &&
            olds !== undefined &&
            Redacted.value(props.adminUserPassword) !==
              Redacted.value(olds.adminUserPassword)
          ) {
            update.adminUserPassword = props.adminUserPassword;
            mutated = true;
          }
          if (mutated) {
            yield* docdbelastic.updateCluster(update);
            observed = yield* waitForActive(name, arn);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readTags(arn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* docdbelastic.tagResource({
              resourceArn: arn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value]),
              ),
            });
          }
          if (removed.length > 0) {
            yield* docdbelastic.untagResource({
              resourceArn: arn,
              tagKeys: removed,
            });
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A cluster mid-create/modify rejects deletion with
          // ConflictException — retry (bounded) while it settles. A cluster
          // already deleting (or gone) is success.
          const observed = yield* getByArn(output.clusterArn);
          if (observed === undefined || observed.status === "DELETING") {
            return;
          }
          yield* docdbelastic
            .deleteCluster({ clusterArn: output.clusterArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("15 seconds"),
                  Schedule.recurs(60),
                ]),
              }),
            );
        }),

        list: () =>
          docdbelastic.listClusters.items({}).pipe(
            Stream.runCollect,
            Effect.flatMap((summaries) =>
              Effect.forEach(
                Array.from(summaries),
                (summary) =>
                  getByArn(summary.clusterArn).pipe(
                    Effect.flatMap((cluster) =>
                      cluster === undefined
                        ? Effect.succeed(undefined)
                        : toAttrs(cluster),
                    ),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((attrs) =>
              attrs.filter((a): a is NonNullable<typeof a> => a !== undefined),
            ),
          ),
      };
    }),
  );
