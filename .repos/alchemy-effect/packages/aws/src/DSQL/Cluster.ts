import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  stampedOf,
  type MigrationsInput,
} from "@alchemy.run/sql/Migrations";
import * as dsql from "@distilled.cloud/aws/dsql";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, diffTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { runDsqlMigrations } from "./Migrations.ts";
import { validateDsqlMigrations } from "./MigrationSql.ts";

export class DSQLClusterNotReady extends Data.TaggedError("DSQLClusterNotReady")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ClusterProps {
  /**
   * SQL migrations directory, `{ dir, table? }`, or a Drizzle.Schema output.
   * Applied as admin using the deploy identity (requires dsql:DbConnectAdmin
   * and the optional `pg` peer). Files are checked before cluster mutation.
   * DDL runs one statement at a time; completed statements survive retries.
   * CREATE INDEX is adapted to ASYNC and awaited. Explicit transaction
   * control and serial columns are rejected. Use UUIDs or bigint identity
   * columns with an explicit CACHE. Applied migration files are immutable.
   */
  migrations?: MigrationsInput;
  /**
   * Enables deletion protection. While enabled the cluster cannot be deleted;
   * the provider automatically disables it during delete so `stack.destroy()`
   * always succeeds.
   * @default false
   */
  deletionProtectionEnabled?: boolean;
  /**
   * ARN of a customer-managed KMS key used to encrypt the cluster at rest.
   * Changing the key replaces the cluster.
   * @default an AWS-owned key
   */
  kmsEncryptionKey?: string;
  /**
   * User-defined tags for the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.DSQL.Cluster",
  ClusterProps,
  {
    /** Directory used by the current migration configuration. */
    migrationsDir: string | undefined;
    /** Applied-migrations bookkeeping table. */
    migrationsTable: string | undefined;
    /** SHA256 hashes used to detect migration file changes during plan. */
    migrationsHashes: Record<string, string>;
    /** The unique cluster identifier assigned by DSQL. */
    clusterId: string;
    /** The ARN of the cluster. */
    clusterArn: string;
    /** The current status of the cluster, e.g. `ACTIVE`. */
    status: string;
    /**
     * The public cluster endpoint hostname, e.g.
     * `<clusterId>.dsql.<region>.on.aws`. Connect with a Postgres wire client
     * using an IAM-generated auth token as the password.
     */
    endpoint: string;
    /** Whether deletion protection is enabled on the cluster. */
    deletionProtectionEnabled: boolean;
  },
  never,
  Providers
> {}

/**
 * An Amazon Aurora DSQL cluster — a serverless, distributed SQL database with
 * active-active high availability and Postgres wire compatibility.
 *
 * Clusters are pay-per-use with no provisioned capacity, so they have
 * excellent test economics. Create is asynchronous (`CREATING` -> `ACTIVE`),
 * usually completing in under a minute; the provider waits for `ACTIVE`
 * (bounded) before returning.
 * ### Creating a Cluster
 * **Example:** Basic Cluster
 * ```typescript
 * const cluster = yield* Cluster("AppDb", {});
 * // connect to cluster.endpoint on port 5432 as user "admin"
 * ```
 *
 * **Example:** Cluster with Deletion Protection
 * ```typescript
 * const cluster = yield* Cluster("AppDb", {
 *   deletionProtectionEnabled: true,
 * });
 * ```
 *
 * **Example:** Cluster with a Customer-Managed KMS Key
 * ```typescript
 * const cluster = yield* Cluster("AppDb", {
 *   kmsEncryptionKey: key.keyArn,
 * });
 * ```
 *
 * ### Applying SQL migrations
 * **Example:** Drizzle-generated PostgreSQL migrations
 * ```typescript
 * const schema = yield* Drizzle.Schema("Schema", {
 *   schema: "./src/schema.ts",
 *   dialect: "postgres",
 * });
 * const cluster = yield* Cluster("Database", { migrations: schema.out });
 * ```
 *
 * **Example:** Hand-written SQL migrations
 * ```typescript
 * const cluster = yield* Cluster("Database", { migrations: "./migrations" });
 * ```
 *
 * ### Recovering an interrupted migration <!-- api-prose -->
 * DSQL cannot roll back a whole migration. Alchemy records completed statements
 * in `<migrationsTable>__progress` and serializes deploys with
 * `__alchemy_dsql_migration_lock`. Server-rejected statements can be retried;
 * a running index job is resumed on the next deploy. After a disconnect with
 * an uncertain outcome, inspect the indicated statement and database first.
 * With all migrators stopped, set the progress row to `ready`, advancing
 * `next_statement` only if that statement committed (it is zero-based), then
 * remove a stale lock row if one remains. Never clear progress blindly.
 *
 * Automatic conversion of a different tool's existing history is refused
 * because DSQL cannot atomically combine the table DDL and history copy.
 * Convert that history explicitly before adopting an already-migrated database.
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("AWS.DSQL.Cluster");

const activeStatuses = new Set(["ACTIVE", "IDLE"]);

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const endpointFor = (identifier: string, region: string) =>
        `${identifier}.dsql.${region}.on.aws`;

      const readCluster = Effect.fn(function* (identifier: string) {
        return yield* dsql
          .getCluster({ identifier })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* dsql
          .listTagsForResource({ resourceArn: arn })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
        return Object.fromEntries(
          Object.entries(response?.tags ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      });

      const findCluster = Effect.fn(function* (id: string, instanceId: string) {
        const summaries = yield* dsql.listClusters.items({}).pipe(Stream.runCollect);
        for (const summary of summaries) {
          const tags = yield* readTags(summary.arn);
          if (tags["alchemy::instance"] === instanceId && (yield* hasAlchemyTags(id, tags))) {
            return yield* readCluster(summary.identifier);
          }
        }
      });

      // Bound readiness to 50 seconds; a later deploy can resume provisioning.
      const waitForActive = Effect.fn(function* (identifier: string) {
        const policy = Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(10)]);
        return yield* readCluster(identifier).pipe(
          Effect.flatMap((cluster) => {
            if (cluster === undefined) {
              return Effect.fail(
                new DSQLClusterNotReady({ message: `DSQL cluster '${identifier}' not found` }),
              );
            }
            if (!activeStatuses.has(cluster.status)) {
              return Effect.fail(
                new DSQLClusterNotReady({
                  message: `DSQL cluster '${identifier}' not active (status: ${cluster.status})`,
                }),
              );
            }
            return Effect.succeed(cluster);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      const toAttrs = (
        cluster: dsql.GetClusterOutput | dsql.CreateClusterOutput,
        region: string,
      ): Cluster["Attributes"] => ({
        clusterId: cluster.identifier,
        clusterArn: cluster.arn,
        status: cluster.status,
        endpoint: cluster.endpoint ?? endpointFor(cluster.identifier, region),
        deletionProtectionEnabled: cluster.deletionProtectionEnabled,
        migrationsDir: undefined,
        migrationsTable: undefined,
        migrationsHashes: {},
      });

      return {
        stables: ["clusterId", "clusterArn", "endpoint"],

        diff: Effect.fn(function* ({ olds = {}, news, output }) {
          if (!isResolved(news)) return undefined;
          const input = migrationsInputOf(news);
          if (input) yield* validateDsqlMigrations(input, output?.migrationsHashes);
          // KMS key is create-only; changing it forces a replacement.
          if ((news.kmsEncryptionKey ?? undefined) !== (olds.kmsEncryptionKey ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (yield* diffMigrations({ news, output })) {
            return { action: "update" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, instanceId, output }) {
          const { region } = yield* AWSEnvironment.current;
          const cluster = output?.clusterId
            ? yield* readCluster(output.clusterId)
            : yield* findCluster(id, instanceId);
          if (cluster === undefined || cluster.status === "DELETED") {
            return undefined;
          }
          const tags = yield* readTags(cluster.arn);
          const attrs = {
            ...toAttrs(cluster, region),
            migrationsDir: output?.migrationsDir,
            migrationsTable: output?.migrationsTable,
            migrationsHashes: output?.migrationsHashes ?? {},
          };
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, instanceId, news = {}, output, session }) {
          const input = migrationsInputOf(news);
          if (input) yield* validateDsqlMigrations(input, output?.migrationsHashes);
          const { region } = yield* AWSEnvironment.current;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = {
            ...news.tags,
            ...internalTags,
            "alchemy::instance": instanceId,
          };

          // 1. Observe — cloud state is authoritative; output caches the id.
          let observed =
            output?.clusterId === undefined
              ? yield* findCluster(id, instanceId)
              : yield* readCluster(output.clusterId);

          // 2. Ensure — create if missing. DSQL assigns the identifier.
          let identifier = observed?.identifier ?? output?.clusterId;
          if (observed === undefined) {
            const created = yield* dsql.createCluster({
              clientToken: instanceId,
              deletionProtectionEnabled: news.deletionProtectionEnabled ?? false,
              kmsEncryptionKey: news.kmsEncryptionKey,
              tags: desiredTags,
            });
            identifier = created.identifier;
          }

          // Wait for ACTIVE so subsequent syncs do not hit ConflictException.
          const active = yield* waitForActive(identifier!);
          observed = active;

          // 3. Sync deletion protection against observed state.
          if (
            news.deletionProtectionEnabled !== undefined &&
            news.deletionProtectionEnabled !== observed.deletionProtectionEnabled
          ) {
            yield* dsql.updateCluster({
              identifier: identifier!,
              deletionProtectionEnabled: news.deletionProtectionEnabled,
            });
            observed = yield* waitForActive(identifier!);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readTags(observed.arn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* dsql.tagResource({
              resourceArn: observed.arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* dsql.untagResource({
              resourceArn: observed.arn,
              tagKeys: removed,
            });
          }

          yield* session.note(identifier!);
          const attrs = toAttrs(observed, region);
          const run = input
            ? yield* runDsqlMigrations({
                endpoint: attrs.endpoint,
                input,
                stamped: stampedOf(output),
              })
            : undefined;
          return { ...attrs, ...migrationsAttrs({ input, run, output }) };
        }),

        delete: Effect.fn(function* ({ output }) {
          const identifier = output.clusterId;
          const existing = yield* readCluster(identifier);
          if (existing === undefined) return;
          // Deletion protection blocks delete — disable it first.
          if (existing.deletionProtectionEnabled) {
            yield* dsql
              .updateCluster({
                identifier,
                deletionProtectionEnabled: false,
              })
              .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
          }
          yield* dsql.deleteCluster({ identifier }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            // A cluster still CREATING rejects delete with ConflictException;
            // retry briefly until it settles into a deletable state.
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(10)]),
            }),
          );
        }),

        list: () =>
          Effect.gen(function* () {
            const { region } = yield* AWSEnvironment.current;
            const summaries = yield* dsql.listClusters.items({}).pipe(
              Stream.runCollect,
              Effect.map((c) => Array.from(c)),
            );
            return yield* Effect.forEach(
              summaries,
              (summary) =>
                readCluster(summary.identifier).pipe(
                  Effect.map((cluster) =>
                    cluster === undefined || cluster.status === "DELETED"
                      ? undefined
                      : toAttrs(cluster, region),
                  ),
                ),
              { concurrency: 4 },
            ).pipe(
              Effect.map((attrs) =>
                attrs.filter((a): a is NonNullable<typeof a> => a !== undefined),
              ),
            );
          }),
      };
    }),
  );
