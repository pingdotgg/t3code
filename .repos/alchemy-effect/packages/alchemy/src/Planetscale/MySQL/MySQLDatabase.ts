import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import * as planetscale from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hashImports, hashMigrations } from "../../SQL/SqlFile.ts";
import { recordsEqual } from "../../Util/equal.ts";
import type { BaseDatabaseAttributes, BaseDatabaseProps } from "../Database.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_MIGRATIONS_TABLE,
  PlanetscaleConflict,
  waitForBranchReady,
  waitForDatabaseReady,
} from "../Util.ts";
import {
  ensureMySQLProductionBranchClusterSize,
  observeDefaultKeyspaceReplicas,
  type MySQLClusterSize,
} from "./MySQLClusterSize.ts";
import { runMySQLImports, runMySQLMigrations } from "./MySQLMigrations.ts";

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
   * Desired total number of replicas for the database's default keyspace.
   * Each cluster size includes a fixed number of replicas (2 for
   * production `PS_*` sizes); higher values add extra replicas. Changes
   * are reconciled in place via PlanetScale's keyspace resize lifecycle —
   * never by replacing the database.
   * @see https://planetscale.com/docs/vitess/sharding/keyspaces
   */
  replicas?: number;

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
  /**
   * Observed total replica count of the default keyspace on the default
   * branch, or `undefined` while the keyspace is still provisioning.
   */
  replicas: number | undefined;

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

/** @resource */
export const MySQLDatabase = Resource<MySQLDatabase>(
  "Planetscale.MySQLDatabase",
);

export const MySQLDatabaseProvider = () =>
  Provider.succeed(MySQLDatabase, {
    stables: ["id", "organization", "region"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      if (
        news.region?.slug !== undefined &&
        output?.region?.slug !== undefined &&
        news.region.slug !== output.region.slug
      ) {
        return { action: "replace" } as const;
      }
      // Replicas reconcile in place via a keyspace resize — never a
      // replacement. Diff against the observed keyspace replica count so
      // an adopted database whose live state already matches plans no-op.
      if (
        news.replicas !== undefined &&
        news.replicas !== (output?.replicas ?? olds.replicas)
      ) {
        return { action: "update" } as const;
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
        const newHashes = yield* hashImports(news.importFiles, yield* rootDir);
        if (!recordsEqual(newHashes, output?.importHashes ?? {})) {
          return { action: "update" } as const;
        }
      }
      // Otherwise allow the engine to apply the default update logic.
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { organization } = yield* yield* Credentials;
      const databaseName =
        output?.name ?? (yield* createDatabaseName(id, olds?.name));
      return yield* planetscale
        .getDatabase({
          organization,
          database: databaseName,
        })
        .pipe(
          Effect.flatMap(
            Effect.fn(function* (data) {
              if (data.kind !== "mysql") {
                return yield* Effect.fail(
                  new PlanetscaleConflict({
                    message:
                      `Planetscale database "${data.name}" has kind "${data.kind}" but this resource ` +
                      `is a MySQLDatabase. Use Planetscale.${data.kind === "postgresql" ? "PostgresDatabase" : data.kind}() instead, ` +
                      `or delete the existing database and retry.`,
                  }),
                );
              }
              // Observe the default keyspace's live replica configuration
              // so adopted databases diff against reality.
              const replicas = yield* observeDefaultKeyspaceReplicas(
                organization,
                data.name,
                data.default_branch ?? "main",
              );
              return {
                id: data.id,
                name: data.name,
                organization,
                state: data.state,
                defaultBranch: data.default_branch ?? "main",
                replicas,
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
              };
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const { organization } = yield* yield* Credentials;
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
      let observed = yield* planetscale
        .getDatabase({
          organization,
          database: observedName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

      // Ensure — if missing, create.
      if (!observed) {
        yield* session.note("Creating database...");
        // Note: the API rejects the `replicas` param for mysql databases;
        // replicas are converged below via the keyspace resize lifecycle.
        observed = yield* planetscale.createDatabase({
          organization,
          name: newName,
          region: news.region?.slug,
          kind: "mysql",
          cluster_size: clusterSize,
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
        const branchExists = yield* planetscale
          .getBranch({
            organization,
            database: observed.name,
            branch: news.defaultBranch,
          })
          .pipe(
            Effect.map(() => true),
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
          );
        if (!branchExists) {
          yield* planetscale.createBranch({
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
      const updated = yield* planetscale.updateDatabaseSettings({
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

      // Sync cluster size and replicas on the active default branch —
      // both converge in place via PlanetScale's keyspace resize
      // lifecycle, diffed against the observed default keyspace.
      const branch = news.defaultBranch ?? updated.default_branch ?? "main";
      const keyspace = yield* ensureMySQLProductionBranchClusterSize(
        organization,
        updated.name,
        branch,
        news.clusterSize,
        news.replicas,
      );

      const migrationTarget = {
        organization,
        database: updated.name,
        branch,
      };
      if (news.migrationsDir || news.importFiles?.length) {
        yield* waitForBranchReady(organization, updated.name, branch, session);
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
            yield* rootDir,
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
        clusterSize,
        replicas: keyspace.replicas,
        migrationsDir: news.migrationsDir,
        migrationsTable: news.migrationsDir ? migrationsTable : undefined,
        migrationsHashes,
        importHashes,
        requireApprovalForDeploy: updated.require_approval_for_deploy ?? false,
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
      yield* planetscale
        .deleteDatabase({
          organization: output.organization,
          database: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const { organization } = yield* yield* Credentials;

      return yield* planetscale.listDatabases.pages({ organization }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            page.data
              .filter((db) => db.kind === "mysql")
              .map((data): MySQLDatabase["Attributes"] => ({
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
                migrationsDir: undefined,
                migrationsTable: undefined,
                migrationsHashes: {},
                importHashes: {},
                clusterSize: "",
                replicas: undefined,
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
              })),
          ),
        ),
      );
    }),
  });

const createDatabaseName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }))
    );
  });

const rootDir = Effect.sync(() => process.cwd());
