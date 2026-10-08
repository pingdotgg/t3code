import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { ALCHEMY_DEFAULT_TABLE } from "../../SQL/Migrations/AlchemyFormat.ts";
import {
  MigrationError,
  type MigrationHistoryConflictError,
} from "../../SQL/Migrations/Format.ts";
import type { DurableObjectState } from "./DurableObjectState.ts";
import { applySqlMigrations } from "./SqlMigrationsApply.ts";
import {
  SqlMigrationsRuntime,
  type SqlMigrationSnapshot,
  type SqlMigrationsExport,
} from "./SqlMigrationsRuntime.ts";
import { Worker } from "./Worker.ts";

export type { SqlMigrationSnapshot } from "./SqlMigrationsRuntime.ts";

/** Captured SQL migrations with a runtime-only application method. */
export interface SqlMigrations extends SqlMigrationSnapshot {
  /**
   * Apply pending files to the current Durable Object's SQLite database.
   * Call in the inner instance Effect before returning public methods.
   * Each file and its history row commit atomically; applied files are skipped.
   * Requires runtime context, which is also available in request handlers.
   */
  readonly apply: () => Effect.Effect<
    void,
    MigrationError | MigrationHistoryConflictError,
    DurableObjectState | RuntimeContext
  >;
}

/** A migrations directory, optionally with a custom bookkeeping table. */
export type SqlMigrationsInput =
  | string
  | {
      /** Directory relative to the directory where Alchemy runs. */
      readonly dir: string;
      /** Applied-migrations table. Defaults to `__alchemy_migrations`. */
      readonly table?: string;
    };

/**
 * Read SQL migrations during construction and carry them into a Durable
 * Object without importing `.sql` files or generated `migrations.js`.
 *
 * Files are ordered and hashed using Alchemy's shared SQL migration format.
 * Flat SQL files and modern drizzle-kit migration directories are supported.
 * Paths are relative to the directory where Alchemy runs, not this module.
 * The records are embedded in the Worker JavaScript bundle, so they do not
 * consume environment-variable bindings. The runtime never reads the directory.
 * Missing directories and unsupported layouts fail construction.
 *
 * ### Drizzle Durable Objects
 * **Example:** Capture SQL in the outer Effect and migrate on activation
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Drizzle from "alchemy/Drizzle/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { relations, users } from "./schema.ts";
 *
 * export class Users extends Cloudflare.DurableObject<Users>()(
 *   "Users",
 *   Effect.gen(function* () {
 *     const migrations = yield* Cloudflare.SqlMigrations("./drizzle");
 *     return Effect.gen(function* () {
 *       const db = yield* Drizzle.DurableObject({ migrations, relations });
 *       return { list: () => db.select().from(users) };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * ### Apply Migrations Without Drizzle
 * **Example:** Migrate before exposing the object's methods
 * ```typescript
 * Effect.gen(function* () {
 *   const migrations = yield* Cloudflare.SqlMigrations("./drizzle");
 *   return Effect.gen(function* () {
 *     yield* migrations.apply().pipe(Effect.orDie);
 *     return {};
 *   });
 * });
 * ```
 *
 * `apply()` requires `RuntimeContext` and the current Durable Object state.
 * Each pending file and its `__alchemy_migrations` row commit atomically.
 * A failed file rolls back; successfully applied earlier files stay committed.
 * Existing modern Drizzle history is adopted without replaying applied SQL.
 *
 * ### Custom Bookkeeping Table
 * **Example:** Use the same table on every activation
 * ```typescript
 * const migrations = yield* Cloudflare.SqlMigrations({
 *   dir: "./drizzle",
 *   table: "app_migrations",
 * });
 * ```
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export const SqlMigrations = Effect.fn("Cloudflare.SqlMigrations")(function* (
  input: SqlMigrationsInput,
) {
  const { dir, table = ALCHEMY_DEFAULT_TABLE } =
    typeof input === "string" ? { dir: input } : input;
  const key = `alchemy:sql-migrations:${JSON.stringify([dir, table])}`;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const { readMigrationRecords } = yield* Effect.promise(
      () => import("../../SQL/Migrations/Records.ts"),
    );
    const snapshot: SqlMigrationSnapshot = {
      _tag: "Cloudflare.SqlMigrations",
      table,
      records: yield* readMigrationRecords(dir).pipe(Effect.orDie),
    };
    yield* (yield* Worker).export(key, {
      kind: "sqlMigrations",
      snapshot,
    } satisfies SqlMigrationsExport);
    return makeSqlMigrations(snapshot);
  }
  const bundles = yield* Effect.serviceOption(SqlMigrationsRuntime);
  const snapshot = Option.isSome(bundles) ? bundles.value[key] : undefined;
  if (snapshot === undefined) {
    return yield* Effect.die(
      new MigrationError({
        message: `SQL migrations for ${dir} were not captured during construction. Call SqlMigrations in the outer Durable Object Effect.`,
      }),
    );
  }
  return makeSqlMigrations(snapshot);
});

const makeSqlMigrations = (snapshot: SqlMigrationSnapshot): SqlMigrations => ({
  ...snapshot,
  apply: () => applySqlMigrations(snapshot),
});
