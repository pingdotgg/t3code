import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensurePostgresProductionBranchClusterSize,
  toPostgresClusterSku,
  type PostgresClusterSize,
} from "./PostgresClusterSize.ts";
import type { BaseDatabaseAttributes, BaseDatabaseProps } from "../Database.ts";
import {
  runPostgresImports,
  runPostgresMigrations,
} from "./PostgresMigrations.ts";
import { hashImports, hashMigrations } from "../../Sql/SqlFile.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_MIGRATIONS_TABLE,
  PlanetscaleConflict,
  recordsEqual,
  waitForBranchReady,
  waitForDatabaseReady,
} from "../Util.ts";

/**
 * Properties for creating or updating a PostgreSQL PlanetScale database.
 */
export interface PostgresDatabaseProps extends BaseDatabaseProps {
  /**
   * The PostgreSQL database cluster size. Required.
   * Short sizes are expanded using the target region and architecture.
   * @see https://planetscale.com/docs/postgres/pricing
   */
  clusterSize: PostgresClusterSize;

  /**
   * PostgreSQL major version. Defaults to the latest available major
   * version.
   */
  majorVersion?: string;

  /**
   * CPU architecture. Cannot be changed after creation.
   * @default "x86"
   */
  arch?: "x86" | "arm";
}

/**
 * Output attributes of a deployed PostgreSQL PlanetScale database.
 */
export interface PostgresDatabaseAttributes extends BaseDatabaseAttributes {
  /** Engine kind discriminator. */
  kind: "postgresql";
  /** PostgreSQL CPU architecture. */
  arch: "x86" | "arm";
}

/**
 * A PostgreSQL PlanetScale database. For MySQL, use {@link MySQLDatabase}
 * instead.
 *
 * @section Creating a PostgreSQL Database
 * @example Basic PostgreSQL database
 * ```typescript
 * const db = yield* Planetscale.PostgresDatabase("MyDb", {
 *   clusterSize: "PS_10",
 * });
 * ```
 *
 * @section Migrations and seed data
 * @example Apply migrations and seed files
 * ```typescript
 * const db = yield* Planetscale.PostgresDatabase("MyDb", {
 *   clusterSize: "PS_10",
 *   migrationsDir: "./migrations/postgres",
 *   importFiles: ["./seed/postgres.sql"],
 * });
 * ```
 *
 * @section Adoption
 * @example Adopting an existing database
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const db = yield* Planetscale.PostgresDatabase("Existing", {
 *   name: "existing-db",
 *   clusterSize: "PS_10",
 * }).pipe(adopt());
 * ```
 */
export type PostgresDatabase = Resource<
  "Planetscale.PostgresDatabase",
  PostgresDatabaseProps,
  PostgresDatabaseAttributes,
  never,
  Providers
>;

export const PostgresDatabase = Resource<PostgresDatabase>(
  "Planetscale.PostgresDatabase",
);

const createDatabaseName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }))
    );
  });

export const PostgresDatabaseProvider = () =>
  Provider.effect(
    PostgresDatabase,
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
            news.region?.slug &&
            output?.region?.slug &&
            news.region.slug !== output.region.slug
          ) {
            return { action: "replace" } as const;
          }

          if (news.replicas !== olds.replicas) {
            return { action: "replace" } as const;
          }

          const oldArch = output?.arch ?? olds.arch ?? "x86";
          if (news.arch && news.arch !== oldArch) {
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

          const data = yield* getDb({
            organization,
            database: databaseName,
          }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

          if (!data) return undefined;

          if (data.kind !== "postgresql") {
            return yield* Effect.fail(
              new PlanetscaleConflict({
                message:
                  `Planetscale database "${data.name}" has kind "${data.kind}" but this resource ` +
                  `is a PostgresDatabase. Use Planetscale.${data.kind === "mysql" ? "MySQLDatabase" : data.kind}() instead, ` +
                  `or delete the existing database and retry.`,
              }),
            );
          }

          const defaultBranch = data.default_branch ?? "main";

          // Observe `arch` and `clusterSize` from the default branch rather
          // than echoing input.
          const branch = yield* getBr({
            organization,
            database: data.name,
            branch: defaultBranch,
          }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

          const arch: "x86" | "arm" =
            branch!.cluster_architecture === "aarch64" ? "arm" : "x86";
          const clusterSize = branch!.cluster_name;

          return {
            id: data.id,
            name: data.name,
            organization,
            state: data.state,
            defaultBranch,
            plan: data.plan ?? "hobby",
            createdAt: data.created_at,
            updatedAt: data.updated_at,
            htmlUrl: data.html_url,
            region: { slug: data.region.slug },
            migrationsDir: output?.migrationsDir ?? olds?.migrationsDir,
            migrationsTable: output?.migrationsTable ?? olds?.migrationsTable,
            migrationsHashes: output?.migrationsHashes ?? {},
            importHashes: output?.importHashes ?? {},
            kind: "postgresql" as const,
            clusterSize,
            arch,
            requireApprovalForDeploy: data.require_approval_for_deploy ?? false,
            restrictBranchRegion: data.restrict_branch_region ?? false,
            productionBranchWebConsole:
              data.production_branch_web_console ?? false,
          };
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { organization } = yield* Credentials;
          const newName = yield* createDatabaseName(id, news.name);
          const clusterSize = toPostgresClusterSku({
            size: news.clusterSize,
            arch: news.arch,
            region: news.region?.slug,
          });

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
              kind: "postgresql",
              cluster_size: clusterSize,
              replicas: news.replicas,
              major_version: news.majorVersion,
            });
          }

          // Wait for the database to finish provisioning before any
          // downstream sync runs. PlanetScale reports `state: "pending"`
          // for a while after createDatabase returns, during which branch
          // operations on this database (including our own settings PATCH)
          // race against the provisioning fiber.
          yield* waitForDatabaseReady(organization, observed.name, session);

          if (observed.kind !== "postgresql") {
            return yield* Effect.fail(
              new PlanetscaleConflict({
                message:
                  `Planetscale database "${observed.name}" has kind "${observed.kind}" but this resource ` +
                  `is a PostgresDatabase. Use Planetscale.${observed.kind === "mysql" ? "MySQLDatabase" : observed.kind}() instead, ` +
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
              });
            }
          }

          // Sync settings — `updateSettings` is upsert-shaped, so we can
          // call it with the full desired payload on every reconcile.
          // Folds the rename in via `new_name` so we don't pay for a
          // separate PATCH.
          const updated = yield* updateSettings({
            organization,
            database: observed.name,
            new_name: newName !== observed.name ? newName : undefined,
            require_approval_for_deploy: news.requireApprovalForDeploy,
            restrict_branch_region: news.restrictBranchRegion,
            production_branch_web_console: news.productionBranchWebConsole,
            default_branch: news.defaultBranch,
          });

          // Sync cluster size on the active default branch.
          const branch = news.defaultBranch ?? updated.default_branch ?? "main";
          yield* ensurePostgresProductionBranchClusterSize(
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
            ? yield* runPostgresMigrations(
                migrationTarget,
                news.migrationsDir,
                migrationsTable,
              )
            : (output?.migrationsHashes ?? {});
          const importHashes = news.importFiles?.length
            ? yield* runPostgresImports(
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
            kind: "postgresql" as const,
            clusterSize: clusterSize,
            migrationsDir: news.migrationsDir,
            migrationsTable: news.migrationsDir ? migrationsTable : undefined,
            migrationsHashes,
            importHashes,
            arch: news.arch ?? output?.arch ?? "x86",
            requireApprovalForDeploy:
              updated.require_approval_for_deploy ?? false,
            restrictBranchRegion: updated.restrict_branch_region ?? false,
            productionBranchWebConsole:
              updated.production_branch_web_console ?? false,
          } satisfies PostgresDatabaseAttributes;
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
