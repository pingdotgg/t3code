import type { RuntimeServices } from "@alchemy.run/cloudflare-runtime/core";
import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  runMigrations,
  stampedOf,
  type MigrationsInput,
} from "@alchemy.run/sql/Migrations";
import { applySqlImports, hashImports, splitSqliteStatements } from "@alchemy.run/sql/SqlFile";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as RpcProvider from "alchemy/Local/RpcProvider";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { isResourceOfType, Resource } from "alchemy/Resource";
import { recordsEqual } from "alchemy/Util/equal";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { localAccountId } from "../LocalAccount.ts";
import { generateLocalId, LOCAL_PROVIDERS_URL, localRuntimeServices } from "../LocalRuntime.ts";
import type { Providers } from "../Providers.ts";
import { makeD1MigrationExecutor } from "./ApplyMigrations.ts";
import { cloneDatabase } from "./CloneDatabase.ts";
import { importD1Database } from "./ImportDatabase.ts";
import { withLocalD1Executor, withLocalD1Query } from "./LocalD1Gateway.ts";

export const isDatabase = (value: unknown): value is Database =>
  isResourceOfType(value, "Cloudflare.D1Database");

export type Jurisdiction = "default" | "eu" | "fedramp";
export type PrimaryLocationHint = "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc";

export type CloneSource = Database | { databaseId: string } | { name: string };

export type DatabaseProps = {
  /**
   * Name of the database. If omitted, a unique name will be generated.
   *
   * D1 names are unique per account. When an explicit name is kept across a
   * replacement (e.g. `primaryLocationHint` or `jurisdiction` changes), the
   * existing database and its data are deleted before the new one is created.
   * Generated names get a new name on replacement, so the new database is
   * created first.
   *
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
  readReplication?: { mode: "auto" | "disabled" };
  /**
   * Jurisdiction in which the database data is guaranteed to be stored.
   * Cannot be changed after creation.
   *
   * @default "default"
   */
  jurisdiction?: Jurisdiction;
  /**
   * SQL migrations to apply on deploy. Accepts a directory path, a
   * `Drizzle.Schema` resource, or a `{ dir, table? }` object.
   *
   * Bookkeeping always lives in Alchemy's `__alchemy_migrations` table. A
   * database previously migrated with `drizzle-kit migrate` or
   * `wrangler d1 migrations apply` is adopted by a ONE-WAY conversion on
   * first deploy: the old tool's applied history is copied into Alchemy's
   * table (validated against the local files) and the old table is left
   * frozen — never written, never dropped. From then on Alchemy owns the
   * migration state.
   *
   * Pending migrations are detected on each deploy and applied in order as
   * part of `update`.
   */
  migrations?: MigrationsInput;
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

export type Database = Resource<
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
 * ### Creating a Database
 * **Example:** Basic database
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db");
 * ```
 *
 * **Example:** Database with location hint
 * The primary copy of the data is stored in the chosen region; reads can be
 * served closer to users when read replication is enabled.
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   primaryLocationHint: "wnam",
 * });
 * ```
 *
 * **Example:** Database with read replication
 * Read replication is the only mutable property after creation — toggling it
 * triggers an update rather than a replacement.
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   readReplication: { mode: "auto" },
 * });
 * ```
 *
 * **Example:** Database in a specific jurisdiction
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   jurisdiction: "eu",
 * });
 * ```
 *
 * ### Migrations
 * Point `migrations` at a folder of migration files. Already-applied
 * migrations are skipped on subsequent deploys; new files are detected
 * automatically and applied as part of the next update.
 *
 * Bookkeeping always lives in Alchemy's `__alchemy_migrations` table —
 * one format, owned by Alchemy. A database previously migrated with
 * drizzle-kit, Prisma, or wrangler is adopted by a one-way conversion on
 * first deploy: the old tool's applied history is copied into Alchemy's
 * table and the old table is left frozen (never written, never dropped).
 * No baselining required. Legacy Alchemy tracking tables are detected by
 * column shape and upgraded in place.
 *
 * **Example:** Apply migrations from a directory
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   migrations: "./migrations",
 * });
 * ```
 *
 * **Example:** Drizzle migrations (adopts an existing drizzle-kit-migrated database)
 * ```typescript
 * const schema = yield* Drizzle.Schema("app-schema", {
 *   schema: "./src/schema.ts",
 *   dialect: "sqlite",
 * });
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   migrations: schema,
 * });
 * ```
 *
 * **Example:** Custom bookkeeping table name
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   migrations: { dir: "./migrations", table: "my_migrations" },
 * });
 * ```
 *
 * ### Importing SQL
 * Use `importFiles` to seed the database with raw `.sql` files via Cloudflare's
 * D1 import API. Each file is hashed; only files whose contents change are
 * re-imported on subsequent deploys.
 *
 * **Example:** Seed a database with SQL files
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   importFiles: ["./seed/users.sql", "./seed/posts.sql"],
 * });
 * ```
 *
 * ### Cloning a Database
 * `clone` performs a full export → import from a source database during
 * creation. It accepts a `D1Database` resource, a `{ databaseId }`, or a
 * `{ name }` to look up by name.
 *
 * **Example:** Clone by passing the source resource directly
 * ```typescript
 * const source = yield* Cloudflare.D1.Database("source-db");
 * const cloned = yield* Cloudflare.D1.Database("cloned-db", {
 *   clone: source,
 * });
 * ```
 *
 * **Example:** Clone by databaseId
 * ```typescript
 * const cloned = yield* Cloudflare.D1.Database("cloned-db", {
 *   clone: { databaseId: "abcdef12-3456-7890-abcd-ef1234567890" },
 * });
 * ```
 *
 * **Example:** Clone by name
 * ```typescript
 * const cloned = yield* Cloudflare.D1.Database("cloned-db", {
 *   clone: { name: "source-db" },
 * });
 * ```
 *
 * ### Binding to a Worker
 * **Example:** Using D1 inside a Worker
 * ```typescript
 * const db = yield* Cloudflare.D1.QueryDatabase(MyDatabase);
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
 *
 * @resource
 * @product D1
 * @category Storage & Databases
 */
export const Database = Resource<Database>("Cloudflare.D1Database");

/**
 * Keep the persisted replication shape when the live mode matches. An omitted
 * persisted configuration means disabled, as it does during reconcile.
 */
const resolveObservedD1ReadReplication = (
  observed: Database["Attributes"]["readReplication"],
  persisted: Database["Attributes"]["readReplication"],
): Database["Attributes"]["readReplication"] =>
  (observed?.mode ?? "disabled") === (persisted?.mode ?? "disabled") ? persisted : observed;

export const ProviderLive = () =>
  Provider.succeed(Database, {
    stables: ["databaseId", "accountId"],
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldName = output?.databaseName ?? (yield* createDatabaseName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      const oldJurisdiction = output?.jurisdiction ?? olds.jurisdiction ?? "default";
      if (
        oldName !== name ||
        oldJurisdiction !== (news.jurisdiction ?? "default") ||
        (olds.primaryLocationHint !== news.primaryLocationHint &&
          news.primaryLocationHint !== undefined)
      ) {
        // D1 names are unique per account, so a replacement that keeps an
        // explicit name cannot coexist with its predecessor: create-first
        // would adopt the existing database by name and garbage collection
        // would then delete it. Delete the old generation first instead.
        // Generated names change with the new instance id, so they stay
        // create-first.
        return news.name !== undefined && news.name === oldName
          ? ({ action: "replace", deleteFirst: true } as const)
          : ({ action: "replace" } as const);
      }
      const oldReplicationMode =
        output?.readReplication?.mode ?? olds.readReplication?.mode ?? "disabled";
      const newReplicationMode = news.readReplication?.mode ?? "disabled";
      if (oldReplicationMode !== newReplicationMode) {
        return { action: "update" } as const;
      }
      // Detect migration/import file drift.
      if (yield* diffMigrations({ news, output })) {
        return { action: "update" } as const;
      }
      if (news.importFiles?.length) {
        const newHashes = yield* hashImports(news.importFiles, yield* rootDir);
        const oldHashes = output?.importHashes ?? {};
        if (!recordsEqual(newHashes, oldHashes)) {
          return { action: "update" } as const;
        }
      }
      return undefined;
    }),
    // Account-scoped collection — D1 databases live under an account and the
    // distilled `listDatabases` op paginates them. Hydrate each row into the
    // same Attributes shape `read`'s name-lookup branch returns.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* d1.listDatabases.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .filter(
                (db): db is (typeof page.result)[number] & { uuid: string } => db.uuid != null,
              )
              .map((db) => ({
                databaseId: db.uuid,
                databaseName: db.name ?? db.uuid,
                jurisdiction: (db.jurisdiction ?? "default") as Jurisdiction,
                readReplication: undefined,
                accountId,
                migrationsDir: undefined,
                migrationsTable: undefined,
                migrationsHashes: {},
                importHashes: {},
              })),
          ),
        ),
      );
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output?.databaseId) {
        return yield* d1
          .getDatabase({ accountId: output.accountId, databaseId: output.databaseId })
          .pipe(
            Effect.map((db) => ({
              databaseId: db.uuid ?? output.databaseId,
              databaseName: db.name ?? output.databaseName,
              jurisdiction: output.jurisdiction,
              // Distilled widened generated string enums to open unions.
              readReplication: resolveObservedD1ReadReplication(
                (db.readReplication ?? undefined) as { mode: "auto" | "disabled" } | undefined,
                output.readReplication,
              ),
              accountId: output.accountId,
              migrationsDir: output.migrationsDir,
              migrationsTable: output.migrationsTable,
              migrationsHashes: output.migrationsHashes,
              importHashes: output.importHashes,
            })),
            Effect.catchTag("DatabaseNotFound", () => Effect.undefined),
          );
      }
      const name = yield* createDatabaseName(id, olds?.name);
      const match = yield* d1.listDatabases.items({ accountId, name }).pipe(
        Stream.filter((db) => db.name === name),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
      );
      if (match) {
        return {
          databaseId: match.uuid!,
          databaseName: match.name ?? name,
          jurisdiction: (olds?.jurisdiction ?? "default") as Jurisdiction,
          readReplication: olds?.readReplication,
          accountId,
          migrationsDir: (olds && migrationsInputOf(olds))?.dir,
          migrationsTable: (olds && migrationsInputOf(olds))?.table,
          migrationsHashes: {},
          importHashes: {},
        };
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
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
        observed = yield* d1
          .getDatabase({ accountId: acct, databaseId: output.databaseId })
          .pipe(Effect.catchTag("DatabaseNotFound", () => Effect.undefined));
      }
      if (!observed) {
        observed = yield* d1.listDatabases.items({ accountId: acct, name }).pipe(
          Stream.filter((db) => db.name === name),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
      }

      // Ensure — create if missing. Cloudflare returns
      // `InvalidProperty` when a database with the same name already
      // exists; we tolerate the race by re-listing to find it.
      let databaseId: string;
      let databaseName: string;
      const isFirstCreation = !observed;
      if (!observed) {
        const db = yield* d1
          .createDatabase({
            accountId: acct,
            name,
            jurisdiction: jurisdiction !== "default" ? jurisdiction : undefined,
            primaryLocationHint: news.primaryLocationHint,
          })
          .pipe(
            Effect.catchTag("InvalidProperty", () =>
              Effect.gen(function* () {
                const match = yield* d1.listDatabases.items({ accountId: acct, name }).pipe(
                  Stream.filter((db) => db.name === name),
                  Stream.runHead,
                  Effect.map(Option.getOrUndefined),
                );
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
      const desiredReplicationMode = news.readReplication?.mode ?? "disabled";
      const observedReplicationMode = observed?.readReplication?.mode ?? "disabled";
      if (
        isFirstCreation
          ? desiredReplicationMode !== "disabled"
          : observedReplicationMode !== desiredReplicationMode
      ) {
        const updated = yield* d1.patchDatabase({
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
        const sourceId = yield* resolveCloneSource(news.clone, acct);
        yield* cloneDatabase({
          accountId: acct,
          sourceDatabaseId: sourceId,
          targetDatabaseId: databaseId,
        });
      }

      // Sync migrations — the shared pipeline is idempotent
      // (already-applied entries are skipped), so this works for both
      // first create and ongoing updates. Foreign (drizzle/prisma/
      // wrangler) or legacy history is converted into
      // __alchemy_migrations on first contact.
      const migrationsInput = migrationsInputOf(news);
      const migrations = migrationsInput
        ? yield* runMigrations({
            input: migrationsInput,
            stamped: stampedOf(output),
            withExecutor: (apply) =>
              Effect.gen(function* () {
                const queryDb = yield* d1.queryDatabase;
                yield* apply(
                  makeD1MigrationExecutor((sql) => queryDb({ accountId: acct, databaseId, sql })),
                );
              }),
          })
        : undefined;

      const importHashes = yield* applySqlImports({
        importFiles: news.importFiles,
        rootDir: yield* rootDir,
        previous: output?.importHashes,
        apply: (file) =>
          importD1Database({
            accountId: acct,
            databaseId,
            sqlData: file.sql,
            filename: file.id,
          }).pipe(Effect.asVoid),
      });

      return {
        databaseId,
        databaseName,
        jurisdiction: (output?.jurisdiction ?? jurisdiction) as Jurisdiction,
        readReplication: news.readReplication,
        accountId: acct,
        // On first creation prior state is meaningless; otherwise removing
        // `migrations` keeps the stamp and hashes for a later re-add.
        ...migrationsAttrs({
          input: migrationsInput,
          run: migrations,
          output: isFirstCreation ? undefined : output,
        }),
        importHashes,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* d1
        .deleteDatabase({ accountId: output.accountId, databaseId: output.databaseId })
        .pipe(Effect.catchTag("DatabaseNotFound", () => Effect.void));
    }),
  });

/**
 * Local (dev) provider — the database is purely virtual: a `dev:` id keyed
 * into the local workerd D1 simulator (DO SQLite under `.alchemy/local/d1`).
 * `toRuntimeBinding` lowers a `d1` binding whose id is `dev:`-prefixed onto
 * the local D1 service.
 *
 * Migrations ARE applied locally: reconcile boots an ephemeral gateway
 * workerd (see `LocalD1Gateway.ts`) and drives the same executor-agnostic
 * migration flow the live provider uses, against the simulator's storage.
 *
 * RPC-backed: under `alchemy dev` (an `RpcProviderProxy` in context) the
 * whole lifecycle runs in the Cloudflare sidecar process — where
 * `localRuntimeServices()` is real and shared with the Worker/Queue/
 * Container local providers — instead of in the user's process where that
 * layer is gated empty (the root cause of #1007). In-process runs (no
 * proxy: `sidecar: false` tests, a plain deploy deleting a local-mode row)
 * build the provider directly with the un-gated runtime from the `dual`
 * registration.
 */
export const ProviderLocal = () =>
  RpcProvider.effect(
    Database,
    LOCAL_PROVIDERS_URL,
    Effect.gen(function* () {
      // The local runtime services (workerd `Runtime`, binding plugins) and
      // the HTTP client are resolved once at layer build and closed over —
      // lifecycle effects run with the engine's call-time context, which
      // doesn't include them.
      const runtimeContext = yield* Effect.context<RuntimeServices | HttpClient.HttpClient>();

      return {
        stables: ["accountId"],
        diff: Effect.fn(function* ({ news = {}, output }) {
          const accountId = yield* localAccountId;
          if (!output?.databaseId) return { action: "update" } as const;
          if (!isResolved(news)) return undefined;
          if (output.accountId !== accountId) {
            return { action: "replace" } as const;
          }
          // Detect migration/import file drift — same rules as the live
          // provider.
          if (yield* diffMigrations({ news, output })) {
            return { action: "update" } as const;
          }
          if (news.importFiles?.length) {
            const newHashes = yield* hashImports(news.importFiles, yield* rootDir);
            if (!recordsEqual(newHashes, output.importHashes ?? {})) {
              return { action: "update" } as const;
            }
          }
          // Fall through to the engine's default prop diff.
        }),
        read: Effect.fn(function* ({ output }) {
          // Purely virtual — the persisted state row is the source of truth.
          return output ?? undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const accountId = yield* localAccountId;
          const databaseId = output?.databaseId ?? generateLocalId();

          // Sync migrations — the shared pipeline, driven through the
          // ephemeral local gateway so the SAME bookkeeping applies
          // locally as in the cloud.
          const migrationsInput = migrationsInputOf(news);
          const migrations = migrationsInput
            ? yield* runMigrations({
                input: migrationsInput,
                stamped: stampedOf(output),
                withExecutor: (apply) =>
                  withLocalD1Executor(databaseId, (executor) =>
                    apply(makeD1MigrationExecutor(executor)),
                  ).pipe(Effect.provideContext(runtimeContext)),
              })
            : undefined;

          // Locally an import file is just multi-statement SQL, executed
          // through the same gateway.
          const importHashes = yield* applySqlImports({
            importFiles: news.importFiles,
            rootDir: yield* rootDir,
            previous: output?.importHashes,
            apply: (file) =>
              withLocalD1Query(databaseId, (query) => {
                // One statement per batch entry: the simulator's SQLite
                // rejects a whole file over its statement length limit.
                const batch = splitSqliteStatements(file.sql).map((sql) => ({ sql }));
                return batch.length > 0 ? query({ batch }) : Effect.void;
              }).pipe(Effect.asVoid, Effect.provideContext(runtimeContext)),
          });

          return {
            databaseId,
            databaseName: yield* createDatabaseName(id, news.name),
            jurisdiction: (news.jurisdiction ?? "default") as Jurisdiction,
            readReplication: news.readReplication,
            accountId: output?.accountId ?? accountId,
            ...migrationsAttrs({ input: migrationsInput, run: migrations, output }),
            importHashes,
          };
        }),
        delete: Effect.fn(function* () {
          // The simulator's on-disk data is keyed by the dev id; dropping
          // the state row is enough — orphaned data is reclaimed with
          // `.alchemy`.
        }),
      };
    }),
  );

export const DatabaseProvider = () =>
  ProviderLayer.dual(Database, {
    // The local provider's reconcile boots an ephemeral workerd gateway to
    // apply migrations, so it needs the shared local runtime layer. Under
    // `alchemy dev` the provider is an RPC stub (this gated layer is empty
    // and unused) and the provider group (`../Local.ts`) supplies the real
    // runtime; without the proxy the provider builds in-process and this
    // layer is real.
    local: () => ProviderLocal().pipe(Layer.provide(localRuntimeServices())),
    live: () => ProviderLive(),
  });

const createDatabaseName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

const rootDir = Effect.sync(() => process.cwd());

/**
 * Resolve a clone source spec into a concrete database UUID. Looks up by
 * name through `listDatabases` when only a name is provided.
 */
const resolveCloneSource = (source: CloneSource, accountId: string) =>
  Effect.gen(function* () {
    if ("databaseId" in source && source.databaseId) {
      // At lifecycle time, Output<string> attributes have resolved to strings.
      return source.databaseId as unknown as string;
    }
    if ("name" in source && source.name) {
      const name = source.name as unknown as string;
      const match = yield* d1.listDatabases.items({ accountId, name }).pipe(
        Stream.filter((db) => db.name === name),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
      );
      if (!match?.uuid) {
        return yield* Effect.die(`Source database "${name}" not found for cloning`);
      }
      return match.uuid;
    }
    return yield* Effect.die("Invalid clone source: must provide databaseId or name");
  });
