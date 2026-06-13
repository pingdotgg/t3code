import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as Effect from "effect/Effect";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { listSqlFiles, readSqlFile } from "../../Sql/SqlFile.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { cloneD1Database } from "./D1Clone.ts";
import { importD1Database } from "./D1Import.ts";
import { applyMigrations } from "./D1Migrations.ts";

export const isD1Database = (value: unknown): value is D1Database =>
  typeof value === "object" && (value as any)?.Type === "Cloudflare.D1Database";

export type Jurisdiction = "default" | "eu" | "fedramp";
export type PrimaryLocationHint =
  | "wnam"
  | "enam"
  | "weur"
  | "eeur"
  | "apac"
  | "oc";

const DEFAULT_MIGRATIONS_TABLE = "d1_migrations";

export type CloneSource =
  | D1Database
  | { databaseId: string }
  | { name: string };

export type DatabaseProps = {
  /**
   * Name of the database. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Region in which the primary copy of the data is stored. Cannot be
   * changed after creation — updating this property triggers a replacement.
   *
   * - `wnam` — Western North America
   * - `enam` — Eastern North America
   * - `weur` — Western Europe
   * - `eeur` — Eastern Europe
   * - `apac` — Asia Pacific
   * - `oc`   — Oceania
   */
  primaryLocationHint?: PrimaryLocationHint;
  /**
   * Read replication configuration. The only mutable property after
   * creation; toggling `mode` triggers an in-place update.
   *
   * @default { mode: "disabled" }
   */
  readReplication?: {
    mode: "auto" | "disabled";
  };
  /**
   * Jurisdiction in which the database data is guaranteed to be stored.
   * Cannot be changed after creation.
   *
   * @default "default"
   */
  jurisdiction?: Jurisdiction;
  /**
   * Directory containing `.sql` migration files. Files are sorted by their
   * numeric prefix (e.g. `0001_init.sql`, `0002_add_users.sql`) and applied
   * in order. Pending migrations are detected on each deploy and applied as
   * part of `update`. Equivalent to wrangler's `migrations_dir`.
   */
  migrationsDir?: string;
  /**
   * Name of the table used to track applied migrations. Useful for
   * compatibility with frameworks that expect a specific name (e.g.
   * `drizzle_migrations`).
   *
   * The table schema is the wrangler-compatible
   * `(id TEXT PRIMARY KEY, name TEXT, applied_at TEXT)`. A pre-existing
   * legacy 2-column table is migrated in place.
   *
   * @default "d1_migrations"
   */
  migrationsTable?: string;
  /**
   * Paths to additional `.sql` files to import after migrations are
   * applied. Each file is uploaded via Cloudflare's D1 import API and
   * hashed; only files whose contents change are re-imported on subsequent
   * deploys.
   *
   * @see https://developers.cloudflare.com/d1/best-practices/import-export-data/
   */
  importFiles?: string[];
  /**
   * Clone data from an existing database during creation by exporting the
   * source and importing it into the new database. Only applied during the
   * `create` phase.
   *
   * Accepts:
   * - another `D1Database` resource (uses its `databaseId`)
   * - `{ databaseId }` — clone by explicit UUID
   * - `{ name }` — look up the source by name and clone it
   */
  clone?: CloneSource;
};

export type D1Database = Resource<
  "Cloudflare.D1Database",
  DatabaseProps,
  {
    databaseId: string;
    databaseName: string;
    jurisdiction: Jurisdiction;
    readReplication: { mode: "auto" | "disabled" } | undefined;
    accountId: string;
    migrationsDir: string | undefined;
    migrationsTable: string | undefined;
    migrationsHashes: Record<string, string>;
    importHashes: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Cloudflare D1 serverless SQL database built on SQLite.
 *
 * D1 is a serverless relational database that runs at the edge. Create a
 * database as a resource, then bind it to a Worker to run SQL queries.
 *
 * @section Creating a Database
 * @example Basic database
 * ```typescript
 * const db = yield* Cloudflare.D1Database("my-db");
 * ```
 *
 * @example Database with location hint
 * The primary copy of the data is stored in the chosen region; reads can be
 * served closer to users when read replication is enabled.
 * ```typescript
 * const db = yield* Cloudflare.D1Database("my-db", {
 *   primaryLocationHint: "wnam",
 * });
 * ```
 *
 * @example Database with read replication
 * Read replication is the only mutable property after creation — toggling it
 * triggers an update rather than a replacement.
 * ```typescript
 * const db = yield* Cloudflare.D1Database("my-db", {
 *   readReplication: { mode: "auto" },
 * });
 * ```
 *
 * @example Database in a specific jurisdiction
 * ```typescript
 * const db = yield* Cloudflare.D1Database("my-db", {
 *   jurisdiction: "eu",
 * });
 * ```
 *
 * @section Migrations
 * Point `migrationsDir` at a folder of `.sql` files. Files are sorted by
 * numeric prefix (e.g. `0001_`, `0002_`) and applied in order. Already-applied
 * migrations are skipped on subsequent deploys; new files are detected
 * automatically and applied as part of the next update.
 *
 * Migration tracking uses the wrangler-compatible
 * `(id TEXT PRIMARY KEY, name TEXT, applied_at TEXT)` schema. The resource
 * also detects and upgrades a legacy 2-column tracking table in place if one
 * already exists.
 *
 * @example Apply migrations from a directory
 * ```typescript
 * const db = yield* Cloudflare.D1Database("my-db", {
 *   migrationsDir: "./migrations",
 * });
 * ```
 *
 * @example Custom migrations table (e.g. for Drizzle)
 * ```typescript
 * const db = yield* Cloudflare.D1Database("my-db", {
 *   migrationsDir: "./migrations",
 *   migrationsTable: "drizzle_migrations",
 * });
 * ```
 *
 * @section Importing SQL
 * Use `importFiles` to seed the database with raw `.sql` files via Cloudflare's
 * D1 import API. Each file is hashed; only files whose contents change are
 * re-imported on subsequent deploys.
 *
 * @example Seed a database with SQL files
 * ```typescript
 * const db = yield* Cloudflare.D1Database("my-db", {
 *   importFiles: ["./seed/users.sql", "./seed/posts.sql"],
 * });
 * ```
 *
 * @section Cloning a Database
 * `clone` performs a full export → import from a source database during
 * creation. It accepts a `D1Database` resource, a `{ databaseId }`, or a
 * `{ name }` to look up by name.
 *
 * @example Clone by passing the source resource directly
 * ```typescript
 * const source = yield* Cloudflare.D1Database("source-db");
 * const cloned = yield* Cloudflare.D1Database("cloned-db", {
 *   clone: source,
 * });
 * ```
 *
 * @example Clone by databaseId
 * ```typescript
 * const cloned = yield* Cloudflare.D1Database("cloned-db", {
 *   clone: { databaseId: "abcdef12-3456-7890-abcd-ef1234567890" },
 * });
 * ```
 *
 * @example Clone by name
 * ```typescript
 * const cloned = yield* Cloudflare.D1Database("cloned-db", {
 *   clone: { name: "source-db" },
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Using D1 inside a Worker
 * ```typescript
 * const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 * // Run a query
 * const results = yield* db.prepare("SELECT * FROM users WHERE id = ?")
 *   .bind(userId)
 *   .all();
 *
 * // Execute a mutation
 * yield* db.prepare("INSERT INTO users (id, name) VALUES (?, ?)")
 *   .bind(newId, name)
 *   .run();
 * ```
 *
 * @see https://developers.cloudflare.com/d1/
 */
export const D1Database = Resource<D1Database>("Cloudflare.D1Database");

export const DatabaseProvider = () =>
  Provider.effect(
    D1Database,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createDb = yield* d1.createDatabase;
      const getDb = yield* d1.getDatabase;
      const patchDb = yield* d1.patchDatabase;
      const deleteDb = yield* d1.deleteDatabase;
      const listDbs = yield* d1.listDatabases;
      // rootDir for resolving relative `importFiles` paths
      const rootDir = process.cwd();

      const createDatabaseName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return name ?? (yield* createPhysicalName({ id }));
        });

      return {
        stables: ["databaseId", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const name = yield* createDatabaseName(id, news.name);
          const oldName = output?.databaseName
            ? output.databaseName
            : yield* createDatabaseName(id, olds.name);
          const oldJurisdiction =
            output?.jurisdiction ?? olds.jurisdiction ?? "default";
          if (
            oldName !== name ||
            oldJurisdiction !== (news.jurisdiction ?? "default") ||
            (olds.primaryLocationHint !== news.primaryLocationHint &&
              news.primaryLocationHint !== undefined)
          ) {
            return { action: "replace" } as const;
          }
          const oldReplicationMode =
            output?.readReplication?.mode ??
            olds.readReplication?.mode ??
            "disabled";
          const newReplicationMode = news.readReplication?.mode ?? "disabled";
          if (oldReplicationMode !== newReplicationMode) {
            return { action: "update" } as const;
          }
          // Detect migration/import file drift.
          if (news.migrationsDir) {
            const newHashes = yield* hashMigrations(news.migrationsDir);
            const oldHashes = output?.migrationsHashes ?? {};
            if (!recordsEqual(newHashes, oldHashes)) {
              return { action: "update" } as const;
            }
            if (
              (news.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE) !==
              (output?.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE)
            ) {
              return { action: "update" } as const;
            }
          } else if (
            output?.migrationsHashes &&
            Object.keys(output.migrationsHashes).length > 0
          ) {
            // migrationsDir was removed but state still tracks migrations: nothing
            // to do remotely (we never un-apply), but no diff needed either.
          }
          if (news.importFiles?.length) {
            const newHashes = yield* hashImports(news.importFiles, rootDir);
            const oldHashes = output?.importHashes ?? {};
            if (!recordsEqual(newHashes, oldHashes)) {
              return { action: "update" } as const;
            }
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          if (output?.databaseId) {
            return yield* getDb({
              accountId: output.accountId,
              databaseId: output.databaseId,
            }).pipe(
              Effect.map((db) => ({
                databaseId: db.uuid ?? output.databaseId,
                databaseName: db.name ?? output.databaseName,
                jurisdiction: output.jurisdiction,
                // Distilled widened generated string enums to open unions.
                readReplication: (db.readReplication ?? undefined) as
                  | { mode: "auto" | "disabled" }
                  | undefined,
                accountId: output.accountId,
                migrationsDir: output.migrationsDir,
                migrationsTable: output.migrationsTable,
                migrationsHashes: output.migrationsHashes,
                importHashes: output.importHashes,
              })),
              Effect.catchTag("DatabaseNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          const name = yield* createDatabaseName(id, olds?.name);
          const dbs = yield* listDbs({ accountId, name });
          const match = dbs.result.find((db) => db.name === name);
          if (match) {
            return {
              databaseId: match.uuid!,
              databaseName: match.name ?? name,
              jurisdiction: (olds?.jurisdiction ?? "default") as Jurisdiction,
              readReplication: olds?.readReplication,
              accountId,
              migrationsDir: olds?.migrationsDir,
              migrationsTable: olds?.migrationsTable,
              migrationsHashes: {},
              importHashes: {},
            };
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const name = yield* createDatabaseName(id, news.name);
          const jurisdiction = news.jurisdiction ?? "default";
          const acct = output?.accountId ?? accountId;

          // Observe — re-fetch the cached database; fall back to a name
          // lookup so we recover from out-of-band deletes or partial
          // state-persistence failures (the create call may have written
          // the database but lost the result before persist).
          let observed:
            | {
                uuid?: string | null;
                name?: string | null;
                // Distilled widened generated string enums to open unions.
                readReplication?: { mode: string } | null;
              }
            | undefined;
          if (output?.databaseId) {
            observed = yield* getDb({
              accountId: acct,
              databaseId: output.databaseId,
            }).pipe(
              Effect.catchTag("DatabaseNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          if (!observed) {
            const dbs = yield* listDbs({ accountId: acct, name });
            observed = dbs.result.find((db) => db.name === name);
          }

          // Ensure — create if missing. Cloudflare returns
          // `InvalidProperty` when a database with the same name already
          // exists; we tolerate the race by re-listing to find it.
          let databaseId: string;
          let databaseName: string;
          const isFirstCreation = !observed;
          if (!observed) {
            const db = yield* createDb({
              accountId: acct,
              name,
              jurisdiction:
                jurisdiction !== "default" ? jurisdiction : undefined,
              primaryLocationHint: news.primaryLocationHint,
            }).pipe(
              Effect.catchTag("InvalidProperty", () =>
                Effect.gen(function* () {
                  const dbs = yield* listDbs({ accountId: acct, name });
                  const match = dbs.result.find((db) => db.name === name);
                  if (match) {
                    return match;
                  }
                  return yield* Effect.die(
                    `Database with name "${name}" already exists but could not be found`,
                  );
                }),
              ),
            );
            databaseId = db.uuid!;
            databaseName = db.name ?? name;
          } else {
            databaseId = observed.uuid ?? output!.databaseId;
            databaseName = observed.name ?? name;
          }

          // Sync read replication — the only mutable property on the
          // database resource itself. Always patch with the desired mode
          // so adoption converges drifted state.
          const desiredReplicationMode =
            news.readReplication?.mode ?? "disabled";
          const observedReplicationMode =
            observed?.readReplication?.mode ?? "disabled";
          if (
            isFirstCreation
              ? desiredReplicationMode !== "disabled"
              : observedReplicationMode !== desiredReplicationMode
          ) {
            const updated = yield* patchDb({
              accountId: acct,
              databaseId,
              readReplication: { mode: desiredReplicationMode },
            });
            databaseId = updated.uuid ?? databaseId;
            databaseName = updated.name ?? databaseName;
          }

          // Clone is a one-shot seed performed only on first creation.
          // Re-running it on an existing database would clobber data.
          if (isFirstCreation && news.clone) {
            const sourceId = yield* resolveCloneSource(
              news.clone,
              acct,
              listDbs,
            );
            yield* cloneD1Database({
              accountId: acct,
              sourceDatabaseId: sourceId,
              targetDatabaseId: databaseId,
            });
          }

          // Sync migrations — `applyMigrations` is itself idempotent (it
          // skips already-applied entries), so this works for both first
          // create and ongoing updates.
          const migrationsTable =
            news.migrationsTable ??
            output?.migrationsTable ??
            DEFAULT_MIGRATIONS_TABLE;
          const migrationsHashes = news.migrationsDir
            ? yield* runMigrations(
                acct,
                databaseId,
                news.migrationsDir,
                migrationsTable,
              )
            : isFirstCreation
              ? {}
              : (output?.migrationsHashes ?? {});

          // Sync imports — `runImports` skips files whose hash matches
          // previously-imported state. On first create the previous map
          // is empty so all listed files import.
          const importHashes = news.importFiles?.length
            ? yield* runImports(
                acct,
                databaseId,
                news.importFiles,
                rootDir,
                output?.importHashes ?? {},
              )
            : {};

          return {
            databaseId,
            databaseName,
            jurisdiction: (output?.jurisdiction ??
              jurisdiction) as Jurisdiction,
            readReplication: news.readReplication,
            accountId: acct,
            migrationsDir: news.migrationsDir,
            migrationsTable: news.migrationsDir ? migrationsTable : undefined,
            migrationsHashes,
            importHashes,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteDb({
            accountId: output.accountId,
            databaseId: output.databaseId,
          }).pipe(Effect.catchTag("DatabaseNotFound", () => Effect.void));
        }),
      };
    }),
  );

/**
 * Resolve a clone source spec into a concrete database UUID. Looks up by
 * name through `listDatabases` when only a name is provided.
 */
const resolveCloneSource = (
  source: CloneSource,
  accountId: string,
  listDbs: (input: {
    accountId: string;
    name?: string;
  }) => Effect.Effect<d1.ListDatabasesResponse, d1.ListDatabasesError, never>,
) =>
  Effect.gen(function* () {
    if ("databaseId" in source && source.databaseId) {
      // At lifecycle time, Output<string> attributes have resolved to strings.
      return source.databaseId as unknown as string;
    }
    if ("name" in source && source.name) {
      const name = source.name as unknown as string;
      const dbs = yield* listDbs({ accountId, name });
      const match = dbs.result.find((db) => db.name === name);
      if (!match?.uuid) {
        return yield* Effect.die(
          `Source database "${name}" not found for cloning`,
        );
      }
      return match.uuid;
    }
    return yield* Effect.die(
      "Invalid clone source: must provide databaseId or name",
    );
  });

/**
 * Read all migration files from `migrationsDir`, run pending migrations,
 * and return the per-file content hashes for state tracking.
 */
const runMigrations = (
  accountId: string,
  databaseId: string,
  migrationsDir: string,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const files = yield* listSqlFiles(migrationsDir);
    if (files.length > 0) {
      yield* applyMigrations({
        accountId,
        databaseId,
        migrationsTable,
        migrationsFiles: files,
      });
    }
    const hashes: Record<string, string> = {};
    for (const file of files) hashes[file.id] = file.hash;
    return hashes;
  });

/**
 * Read each `importFiles` entry and run it through the D1 import flow,
 * skipping files whose hash matches the previously-imported hash.
 */
const runImports = (
  accountId: string,
  databaseId: string,
  importFiles: ReadonlyArray<string>,
  rootDir: string,
  previous: Record<string, string>,
) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = { ...previous };
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      if (previous[filePath] === file.hash) {
        hashes[filePath] = file.hash;
        continue;
      }
      yield* importD1Database({
        accountId,
        databaseId,
        sqlData: file.sql,
        filename: file.id,
      });
      hashes[filePath] = file.hash;
    }
    // Drop entries for files no longer listed.
    const tracked = new Set(importFiles);
    for (const key of Object.keys(hashes)) {
      if (!tracked.has(key)) delete hashes[key];
    }
    return hashes;
  });

/**
 * Hash all `.sql` files in `migrationsDir` without applying them; used by
 * `diff` to detect drift relative to previously-applied state.
 */
const hashMigrations = (migrationsDir: string) =>
  listSqlFiles(migrationsDir).pipe(
    Effect.map((files) => {
      const hashes: Record<string, string> = {};
      for (const file of files) hashes[file.id] = file.hash;
      return hashes;
    }),
  );

const hashImports = (importFiles: ReadonlyArray<string>, rootDir: string) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = {};
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      hashes[filePath] = file.hash;
    }
    return hashes;
  });

const recordsEqual = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};
