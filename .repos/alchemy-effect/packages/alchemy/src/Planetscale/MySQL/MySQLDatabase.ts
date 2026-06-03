import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { BaseDatabaseAttributes, BaseDatabaseProps } from "../Database.ts";
import { runMySQLImports, runMySQLMigrations } from "./MySQLMigrations.ts";
import { hashImports, hashMigrations } from "../../Sql/SqlFile.ts";
import {
  ensureMySQLProductionBranchClusterSize,
  type MySQLClusterSize,
} from "./MySQLClusterSize.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_MIGRATIONS_TABLE,
  PlanetscaleConflict,
  recordsEqual,
  waitForBranchReady,
  waitForDatabaseReady,
} from "../Util.ts";

/**
 * Properties for creating or updating a MySQL PlanetScale database.
 */
export interface MySQLDatabaseProps extends BaseDatabaseProps {
  /**
   * The MySQL database cluster size. Required.
   * @see https://planetscale.com/docs/concepts/cluster-size
   */
  clusterSize: MySQLClusterSize;

  /**
   * Whether to copy migration data to new branches and in deploy requests.
   */
  automaticMigrations?: boolean;

  /**
   * Migration framework to use on the database.
   */
  migrationFramework?: string;

  /**
   * Name of the migration table.
   */
  migrationTableName?: string;

  /**
   * Whether data branching is allowed on the database.
   */
  allowDataBranching?: boolean;

  /**
   * Whether foreign key constraints are allowed on the database.
   */
  allowForeignKeyConstraints?: boolean;

  /**
   * Whether full queries should be collected from the database.
   */
  insightsRawQueries?: boolean;
}

/**
 * Output attributes of a deployed MySQL PlanetScale database.
 */
export interface MySQLDatabaseAttributes extends BaseDatabaseAttributes {
  /** Engine kind discriminator. */
  kind: "mysql";

  /**
   * Whether to copy migration data to new branches and in deploy requests.
   */
  automaticMigrations: boolean;

  /**
   * Migration framework to use on the database.
   */
  migrationFramework?: string;

  /**
   * Name of the migration table.
   */
  migrationTableName?: string;

  /**
   * Whether data branching is allowed on the database.
   */
  allowDataBranching: boolean;

  /**
   * Whether foreign key constraints are allowed on the database.
   */
  allowForeignKeyConstraints: boolean;

  /**
   * Whether full queries should be collected from the database.
   */
  insightsRawQueries: boolean;
}

/**
 * A MySQL PlanetScale database (powered by Vitess). For PostgreSQL use
 * {@link PostgresDatabase} instead.
 *
 * @section Creating a MySQL Database
 * @example Basic MySQL database
 * ```typescript
 * const db = yield* Planetscale.MySQLDatabase("MyDb", {
 *   clusterSize: "PS_10",
 * });
 * ```
 *
 * @example MySQL with Vitess migration tooling
 * ```typescript
 * const db = yield* Planetscale.MySQLDatabase("MyDb", {
 *   clusterSize: "PS_10",
 *   automaticMigrations: true,
 *   migrationFramework: "rails",
 *   migrationTableName: "schema_migrations",
 *   allowDataBranching: true,
 * });
 * ```
 *
 * @section Migrations and seed data
 * @example Apply migrations and seed files
 * ```typescript
 * const db = yield* Planetscale.MySQLDatabase("MyDb", {
 *   clusterSize: "PS_10",
 *   migrationsDir: "./migrations/mysql",
 *   importFiles: ["./seed/mysql.sql"],
 * });
 * ```
 *
 * @section Adoption
 * @example Adopting an existing database
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const db = yield* Planetscale.MySQLDatabase("Existing", {
 *   name: "existing-db",
 *   clusterSize: "PS_10",
 * }).pipe(adopt());
 * ```
 */
export type MySQLDatabase = Resource<
  "Planetscale.MySQLDatabase",
  MySQLDatabaseProps,
  MySQLDatabaseAttributes,
  never,
  Providers
>;

export const MySQLDatabase = Resource<MySQLDatabase>(
  "Planetscale.MySQLDatabase",
);

const createDatabaseName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }))
    );
  });

export const MySQLDatabaseProvider = () =>
  Provider.effect(
    MySQLDatabase,
    Effect.gen(function* () {
      const rootDir = yield* Effect.sync(() => process.cwd());
      const createDb = yield* ops.createDatabase;
      const getDb = yield* ops.getDatabase;
      const updateSettings = yield* ops.updateDatabaseSettings;
      const deleteDb = yield* ops.deleteDatabase;
      const getBr = yield* ops.getBranch;
      const createBr = yield* ops.createBranch;

      return {
        stables: ["id", "organization", "kind", "region"],

        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news)) return undefined;

          if (
            news.region?.slug !== undefined &&
            output?.region?.slug !== undefined &&
            news.region.slug !== output.region.slug
          ) {
            return { action: "replace" } as const;
          }
          if (news.replicas !== olds.replicas) {
            return { action: "replace" } as const;
          }
          if (news.migrationsDir) {
            const newHashes = yield* hashMigrations(news.migrationsDir);
            if (!recordsEqual(newHashes, output?.migrationsHashes ?? {})) {
              return { action: "update" } as const;
            }
            if (
              (news.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE) !==
              (output?.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE)
            ) {
              return { action: "update" } as const;
            }
          }
          if (news.importFiles?.length) {
            const newHashes = yield* hashImports(news.importFiles, rootDir);
            if (!recordsEqual(newHashes, output?.importHashes ?? {})) {
              return { action: "update" } as const;
            }
          }
          // Otherwise allow the engine to apply the default update logic.
          return undefined;
        }),

        read: Effect.fn(function* ({ id, output, olds }) {
          const { organization } = yield* Credentials;
          const databaseName =
            output?.name ?? (yield* createDatabaseName(id, olds?.name));
          return yield* getDb({
            organization,
            database: databaseName,
          }).pipe(
            Effect.flatMap((data) => {
              if (data.kind !== "mysql") {
                return Effect.fail(
                  new PlanetscaleConflict({
                    message:
                      `Planetscale database "${data.name}" has kind "${data.kind}" but this resource ` +
                      `is a MySQLDatabase. Use Planetscale.${data.kind === "postgresql" ? "PostgresDatabase" : data.kind}() instead, ` +
                      `or delete the existing database and retry.`,
                  }),
                );
              }
              return Effect.succeed({
                id: data.id,
                name: data.name,
                organization,
                state: data.state,
                defaultBranch: data.default_branch ?? "main",
                plan: data.plan ?? "hobby",
                createdAt: data.created_at,
                updatedAt: data.updated_at,
                htmlUrl: data.html_url,
                region: { slug: data.region.slug },
                migrationsDir: output?.migrationsDir ?? olds?.migrationsDir,
                migrationsTable:
                  output?.migrationsTable ?? olds?.migrationsTable,
                migrationsHashes: output?.migrationsHashes ?? {},
                importHashes: output?.importHashes ?? {},
                kind: "mysql" as const,
                clusterSize: output?.clusterSize ?? "",
                requireApprovalForDeploy:
                  data.require_approval_for_deploy ?? false,
                restrictBranchRegion: data.restrict_branch_region ?? false,
                insightsRawQueries: data.insights_raw_queries ?? false,
                productionBranchWebConsole:
                  data.production_branch_web_console ?? false,
                automaticMigrations: data.automatic_migrations ?? false,
                migrationFramework: data.migration_framework ?? undefined,
                migrationTableName: data.migration_table_name ?? undefined,
                allowDataBranching: data.allow_data_branching ?? false,
                allowForeignKeyConstraints: data.foreign_keys_enabled ?? false,
              });
            }),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { organization } = yield* Credentials;
          const newName = yield* createDatabaseName(id, news.name);
          const clusterSize = news.clusterSize;

          // Observe — read live state under either the cached name (rename
          // / refresh) or the freshly-derived name (greenfield). Observing
          // unconditionally absorbs the race between `read` and `reconcile`
          // — if a foreign actor (or a previously-failed-to-persist
          // create) produced a database under the desired name in the
          // meantime, we'll find it here and skip the duplicate create.
          // Adoption routing has already been gated by `read` returning
          // `Unowned`, so by the time we reach reconcile any observed
          // database is fair game.
          const observedName = output?.name ?? newName;
          let observed = yield* getDb({
            organization,
            database: observedName,
          }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

          // Ensure — if missing, create.
          if (!observed) {
            yield* session.note("Creating database...");
            observed = yield* createDb({
              organization,
              name: newName,
              region: news.region?.slug,
              kind: "mysql",
              cluster_size: clusterSize,
              replicas: news.replicas,
            });
          }

          // Wait for the database to finish provisioning before any
          // downstream sync runs. PlanetScale reports `state: "pending"`
          // for a while after createDatabase returns, during which branch
          // operations on this database (including our own settings PATCH)
          // race against the provisioning fiber.
          yield* waitForDatabaseReady(organization, observed.name, session);

          if (observed.kind !== "mysql") {
            return yield* Effect.fail(
              new PlanetscaleConflict({
                message:
                  `Planetscale database "${observed.name}" has kind "${observed.kind}" but this resource ` +
                  `is a MySQLDatabase. Use Planetscale.${observed.kind === "postgresql" ? "PostgresDatabase" : observed.kind}() instead, ` +
                  `or delete the existing database and retry.`,
              }),
            );
          }

          // Sync — ensure a non-`main` default branch exists before
          // referencing it via `default_branch`. The branch is created
          // empty (no cluster size yet); we'll size it below.
          if (news.defaultBranch && news.defaultBranch !== "main") {
            yield* waitForDatabaseReady(organization, observed.name, session);
            const branchExists = yield* getBr({
              organization,
              database: observed.name,
              branch: news.defaultBranch,
            }).pipe(
              Effect.map(() => true),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
            );
            if (!branchExists) {
              yield* createBr({
                organization,
                database: observed.name,
                name: news.defaultBranch,
                parent_branch: "main",
                // create branch with cluster size to skip resizing when promoting the branch
                cluster_size: clusterSize,
              });
            }
          }

          // Sync settings — `updateSettings` is upsert-shaped, so we can
          // call it with the full desired payload on every reconcile.
          const updated = yield* updateSettings({
            organization,
            database: observed.name,
            new_name: newName !== observed.name ? newName : undefined,
            automatic_migrations: news.automaticMigrations,
            migration_framework: news.migrationFramework,
            migration_table_name: news.migrationTableName,
            allow_foreign_key_constraints: news.allowForeignKeyConstraints,
            allow_data_branching: news.allowDataBranching,
            require_approval_for_deploy: news.requireApprovalForDeploy,
            restrict_branch_region: news.restrictBranchRegion,
            insights_raw_queries: news.insightsRawQueries,
            production_branch_web_console: news.productionBranchWebConsole,
            default_branch: news.defaultBranch,
          });

          // Sync cluster size on the active default branch.
          const branch = news.defaultBranch ?? updated.default_branch ?? "main";
          yield* ensureMySQLProductionBranchClusterSize(
            organization,
            updated.name,
            branch,
            news.clusterSize,
          );

          const migrationTarget = {
            organization,
            database: updated.name,
            branch,
          };
          if (news.migrationsDir || news.importFiles?.length) {
            yield* waitForBranchReady(
              organization,
              updated.name,
              branch,
              session,
            );
          }
          const migrationsTable =
            news.migrationsTable ??
            output?.migrationsTable ??
            DEFAULT_MIGRATIONS_TABLE;
          const migrationsHashes = news.migrationsDir
            ? yield* runMySQLMigrations(
                migrationTarget,
                news.migrationsDir,
                migrationsTable,
              )
            : (output?.migrationsHashes ?? {});
          const importHashes = news.importFiles?.length
            ? yield* runMySQLImports(
                migrationTarget,
                news.importFiles,
                rootDir,
                output?.importHashes ?? {},
              )
            : {};

          return {
            id: updated.id,
            name: updated.name,
            organization,
            state: updated.state,
            defaultBranch: updated.default_branch ?? branch,
            plan: updated.plan ?? output?.plan ?? "hobby",
            createdAt: updated.created_at,
            updatedAt: updated.updated_at,
            htmlUrl: updated.html_url,
            region: { slug: updated.region.slug },
            kind: "mysql" as const,
            clusterSize,
            migrationsDir: news.migrationsDir,
            migrationsTable: news.migrationsDir ? migrationsTable : undefined,
            migrationsHashes,
            importHashes,
            requireApprovalForDeploy:
              updated.require_approval_for_deploy ?? false,
            restrictBranchRegion: updated.restrict_branch_region ?? false,
            insightsRawQueries: updated.insights_raw_queries ?? false,
            productionBranchWebConsole:
              updated.production_branch_web_console ?? false,
            automaticMigrations: updated.automatic_migrations ?? false,
            migrationFramework: updated.migration_framework ?? undefined,
            migrationTableName: updated.migration_table_name ?? undefined,
            allowDataBranching: updated.allow_data_branching ?? false,
            allowForeignKeyConstraints: updated.foreign_keys_enabled ?? false,
          } satisfies MySQLDatabaseAttributes;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteDb({
            organization: output.organization,
            database: output.name,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
