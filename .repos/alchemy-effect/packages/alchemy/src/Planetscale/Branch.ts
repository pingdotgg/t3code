import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import type { ResourceClass, ResourceLike } from "../Resource.ts";
import { hashImports, hashMigrations } from "../Sql/SqlFile.ts";
import { ensureMySQLProductionBranchClusterSize } from "./MySQL/MySQLClusterSize.ts";
import {
  ensurePostgresProductionBranchClusterSize,
  toPostgresClusterSku,
} from "./Postgres/PostgresClusterSize.ts";
import {
  DEFAULT_MIGRATIONS_TABLE,
  PlanetscaleConflict,
  isKnownError,
  recordsEqual,
  waitForBranchReady,
} from "./Util.ts";

/**
 * Props shared between {@link MySQLBranch} and {@link PostgresBranch}. The
 * `database` and `parentBranch` fields are typed by each engine's resource.
 */
export interface BaseBranchProps {
  /**
   * Branch name. If omitted, a name is generated from the stack/stage/id.
   */
  name?: string;

  /**
   * If provided, restores the backup's schema and data to the new branch.
   * Ignored if the branch already exists.
   */
  backupId?: string;

  /**
   * If provided, restores the last successful backup's schema and data.
   * Ignored if the branch already exists.
   */
  seedData?: "last_successful_backup";

  /**
   * Whether safe migrations are enabled on the branch.
   */
  safeMigrations?: boolean;

  /**
   * Region in which to create the branch. Defaults to the database's
   * region. The actual region is validated on adopt/update.
   */
  region?: { slug: string };

  /**
   * Directory containing `.sql` migration files. Files are sorted by numeric
   * prefix (for example `0001_init.sql`) and applied in order against this
   * branch.
   */
  migrationsDir?: string;

  /**
   * Name of the table used to track applied migrations.
   * @default "__alchemy_migrations"
   */
  migrationsTable?: string;

  /**
   * Paths to additional `.sql` files to apply after migrations. Each file is
   * hashed; only files whose contents change are re-applied on later deploys.
   */
  importFiles?: string[];
}

/**
 * Attributes shared between {@link MySQLBranch} and {@link PostgresBranch}.
 */
export interface BaseBranchAttributes {
  /** The branch name. */
  name: string;
  /** The PlanetScale organization slug. */
  organization: string;
  /** The database name. */
  database: string;
  /** The parent branch name. */
  parentBranch: string;
  /** Whether this is a production branch. */
  production: boolean;
  /** Time at which the branch was created (ISO 8601). */
  createdAt: string;
  /** Time at which the branch was last updated (ISO 8601). */
  updatedAt: string;
  /** HTML URL for accessing the branch in the dashboard. */
  htmlUrl: string;
  /** The region of the branch as reported by PlanetScale. */
  region: { slug: string };
  /** Directory containing migration files, if configured. */
  migrationsDir: string | undefined;
  /** Table used to track applied migrations, if configured. */
  migrationsTable: string | undefined;
  /** Content hashes for the last applied migration files. */
  migrationsHashes: Record<string, string>;
  /** Content hashes for the last applied import files. */
  importHashes: Record<string, string>;
}

// Runtime-resolved Database/Branch references. `news.database` can be a
// plain string OR (after resolution) the Database resource's attributes —
// which contain plain values for `name` / `organization`. The static
// Database type has those fields as `Output<...>`, so we cast through a
// structural shape here.
type DatabaseRef = string | { name: string; organization?: string };
type BranchRef = string | { name: string };

const resolveDatabase = (
  database: unknown,
): { name: string; organization?: string } => {
  const ref = database as DatabaseRef | undefined;
  if (!ref) return { name: "" };
  return typeof ref === "string"
    ? { name: ref }
    : { name: ref.name, organization: ref.organization };
};

const resolveParent = (parent: unknown): string => {
  const ref = parent as BranchRef | undefined;
  return !ref ? "main" : typeof ref === "string" ? ref : ref.name;
};

const createBranchName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }))
    );
  });

/**
 * Shape of the engine-specific migration runners used by
 * {@link makeBranchProvider}. MySQL and Postgres each supply their own
 * implementations in their respective `*Migrations.ts` modules.
 */
export interface BranchMigrationRunners {
  runMigrations: (
    target: { organization: string; database: string; branch: string },
    migrationsDir: string,
    migrationsTable: string,
  ) => Effect.Effect<Record<string, string>, any, any>;
  runImports: (
    target: { organization: string; database: string; branch: string },
    importFiles: string[],
    rootDir: string,
    previousHashes: Record<string, string>,
  ) => Effect.Effect<Record<string, string>, any, any>;
}

/**
 * Build a branch provider for a specific PlanetScale engine. The
 * caller supplies the typed `Resource` token and the engine's migration
 * runners; everything else (observe / ensure / sync / delete) is shared.
 */
export const makeBranchProvider = <R extends ResourceLike>(opts: {
  resource: ResourceClass<R>;
  expectedKind: "mysql" | "postgresql";
  engineLabel: string;
  runners: BranchMigrationRunners;
}) =>
  Provider.effect(
    opts.resource,
    Effect.gen(function* () {
      const rootDir = yield* Effect.sync(() => process.cwd());
      const createBranch = yield* ops.createBranch;
      const getBranch = yield* ops.getBranch;
      const updateBranch = yield* ops.updateBranch;
      const deleteBranch = yield* ops.deleteBranch;
      const promoteBranch = yield* ops.promoteBranch;
      const demoteBranch = yield* ops.demoteBranch;
      const enableSafe = yield* ops.enableSafeMigrations;
      const disableSafe = yield* ops.disableSafeMigrations;
      const { runMigrations, runImports } = opts.runners;

      return {
        stables: ["organization", "database"],

        diff: Effect.fn(function* ({ news, olds, output }: any) {
          if (!isResolved(news)) return undefined;

          const newDb = resolveDatabase(news.database).name;
          const oldDbRef = output?.database ?? olds.database;
          if (oldDbRef) {
            const oldDb = resolveDatabase(oldDbRef).name;
            if (newDb !== oldDb) {
              return { action: "replace" } as const;
            }
          }

          const newParent = resolveParent(news.parentBranch);
          const oldParent =
            output?.parentBranch ?? resolveParent(olds.parentBranch);
          if (newParent !== oldParent) {
            return { action: "replace" } as const;
          }

          if (
            news.region?.slug &&
            output?.region?.slug &&
            news.region.slug !== output.region.slug
          ) {
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

          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }: any) {
          // If we have neither a cached output nor a usable `olds.database`
          // there's no way to identify which branch to refresh — most often
          // this is destroy of a partially-created resource whose props
          // never got fully persisted. Return `undefined` so the engine
          // treats it as already-gone and drops the state entry.
          if (!output && !olds?.database) {
            return undefined;
          }
          const dbInfo = output
            ? { name: output.database, organization: output.organization }
            : resolveDatabase(olds.database);
          const { organization: envOrg } = yield* Credentials;
          const organization =
            output?.organization ?? dbInfo.organization ?? envOrg;
          const databaseName = output?.database ?? dbInfo.name;
          const branchName =
            output?.name ?? (yield* createBranchName(id, olds.name));

          return yield* getBranch({
            organization,
            database: databaseName,
            branch: branchName,
          }).pipe(
            Effect.map((data) => {
              const attrs = {
                name: data.name,
                organization,
                database: databaseName,
                parentBranch: data.parent_branch ?? "main",
                production: data.production,
                createdAt: data.created_at,
                updatedAt: data.updated_at,
                htmlUrl: data.html_url,
                region: { slug: data.region.slug },
                migrationsDir: output?.migrationsDir ?? olds?.migrationsDir,
                migrationsTable:
                  output?.migrationsTable ?? olds?.migrationsTable,
                migrationsHashes: output?.migrationsHashes ?? {},
                importHashes: output?.importHashes ?? {},
              } satisfies BaseBranchAttributes;

              return output ? attrs : Unowned(attrs);
            }),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }: any) {
          const { organization: envOrg } = yield* Credentials;
          const dbInfo = resolveDatabase(news.database);
          const organization =
            output?.organization ?? dbInfo.organization ?? envOrg;
          const databaseName = output?.database ?? dbInfo.name;
          const desiredBranchName = yield* createBranchName(id, news.name);
          const observedBranchName = output?.name ?? desiredBranchName;
          const parentBranchName = resolveParent(news.parentBranch);

          // If parentBranch is a plain string (an unmanaged branch reference),
          // wait for it to be ready before we touch the child branch. When it
          // is a Branch resource, Alchemy's resource graph already guarantees
          // readiness before this resource's inputs are resolved.
          if (news.parentBranch && typeof news.parentBranch === "string") {
            yield* waitForBranchReady(
              organization,
              databaseName,
              parentBranchName,
              session,
            );
          }

          // Observe — fetch the live branch state.
          let current = yield* getBranch({
            organization,
            database: databaseName,
            branch: observedBranchName,
          }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

          // Ensure — if missing, create. The parent must be ready before
          // the child can fork from it. PostgreSQL short cluster sizes need
          // to be expanded against the parent's region so the API call lands
          // with a valid sku.
          if (!current) {
            const parent = yield* waitForBranchReady(
              organization,
              databaseName,
              parentBranchName,
              session,
            );
            const parentClusterSize = news.clusterSize
              ? parent.kind === "postgresql"
                ? toPostgresClusterSku({
                    size: news.clusterSize,
                    region: parent.region.slug,
                  })
                : news.clusterSize
              : undefined;
            yield* session.note("Creating branch...");
            current = yield* createBranch({
              organization,
              database: databaseName,
              name: desiredBranchName,
              parent_branch: parentBranchName,
              backup_id: news.backupId,
              seed_data: news.seedData,
              region: news.region?.slug,
              cluster_size: parentClusterSize,
            });
          }

          if (current.kind !== opts.expectedKind) {
            return yield* Effect.fail(
              new PlanetscaleConflict({
                message:
                  `Planetscale branch "${current.name}" (database "${databaseName}") has kind ` +
                  `"${current.kind}" but this resource is a ${opts.engineLabel}. ` +
                  `Use the matching ${current.kind === "mysql" ? "MySQLBranch" : "PostgresBranch"} ` +
                  `resource instead.`,
              }),
            );
          }

          yield* waitForBranchReady(
            organization,
            databaseName,
            current.name,
            session,
          );

          // Sync name — branch names are mutable. Continue subsequent syncs
          // under the name returned by the API.
          if (current.name !== desiredBranchName) {
            current = yield* updateBranch({
              organization,
              database: databaseName,
              branch: current.name,
              new_name: desiredBranchName,
            });
          }

          const branchName = current.name;

          // Sync production status before branch settings that depend on it.
          // PlanetScale only supports explicit branch promotion/demotion for MySQL.
          if (opts.expectedKind === "mysql") {
            const desiredProduction = news.isProduction ?? false;
            if (current.production !== desiredProduction) {
              current = desiredProduction
                ? yield* promoteBranch({
                    organization,
                    database: databaseName,
                    branch: branchName,
                  })
                : yield* demoteBranch({
                    organization,
                    database: databaseName,
                    branch: branchName,
                  });
            }
          }

          // Sync safeMigrations — observed via `current.safe_migrations`,
          // skip the API call entirely on no-op.
          if (
            news.safeMigrations !== undefined &&
            current.safe_migrations !== news.safeMigrations
          ) {
            if (news.safeMigrations) {
              yield* enableSafe({
                organization,
                database: databaseName,
                branch: branchName,
              });
            } else {
              yield* disableSafe({
                organization,
                database: databaseName,
                branch: branchName,
              });
            }
          }

          // Sync clusterSize — only meaningful on production branches.
          if (news.clusterSize) {
            if (current.kind === "postgresql") {
              yield* ensurePostgresProductionBranchClusterSize(
                organization,
                databaseName,
                branchName,
                news.clusterSize,
              );
            } else {
              yield* ensureMySQLProductionBranchClusterSize(
                organization,
                databaseName,
                branchName,
                news.clusterSize,
              );
            }
          }

          // Re-read so the returned attributes reflect any mutation.
          const updated = yield* getBranch({
            organization,
            database: databaseName,
            branch: branchName,
          });

          const migrationTarget = {
            organization,
            database: databaseName,
            branch: updated.name,
          };

          const migrationsTable =
            news.migrationsTable ??
            output?.migrationsTable ??
            DEFAULT_MIGRATIONS_TABLE;
          const migrationsHashes = news.migrationsDir
            ? yield* runMigrations(
                migrationTarget,
                news.migrationsDir,
                migrationsTable,
              )
            : (output?.migrationsHashes ?? {});
          const importHashes = news.importFiles?.length
            ? yield* runImports(
                migrationTarget,
                news.importFiles,
                rootDir,
                output?.importHashes ?? {},
              )
            : {};

          return {
            name: updated.name,
            organization,
            database: databaseName,
            parentBranch: updated.parent_branch ?? parentBranchName,
            production: updated.production,
            createdAt: updated.created_at,
            updatedAt: updated.updated_at,
            htmlUrl: updated.html_url,
            region: { slug: updated.region.slug },
            migrationsDir: news.migrationsDir,
            migrationsTable: news.migrationsDir ? migrationsTable : undefined,
            migrationsHashes,
            importHashes,
          } satisfies BaseBranchAttributes;
        }),

        delete: Effect.fn(function* ({ output }: any) {
          // If `read` returned undefined (e.g. destroy of a partially-
          // created branch whose props never finished persisting), there
          // is nothing addressable to delete. Drop the state entry.
          if (!output) return;
          yield* deleteBranch({
            organization: output.organization,
            database: output.database,
            branch: output.name,
          }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchIf(
              isKnownError(
                "UnprocessableEntity",
                "The default branch cannot be deleted.",
              ),
              () => Effect.void,
            ),
          );
        }),
      } as any;
    }),
  );
