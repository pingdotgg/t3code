import * as SqliteDoClient from "@effect/sql-sqlite-do/SqliteClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import * as SQLiteDoDrizzle from "drizzle-orm/effect-sqlite-do";
import { migrate } from "drizzle-orm/effect-sqlite-do/migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DurableObjectState } from "../Cloudflare/Workers/DurableObjectState.ts";

/**
 * Migrations for {@link DurableObject} — the shape of the `migrations.js`
 * bundle `drizzle-kit generate` emits for `driver: "durable-sqlite"`
 * (each migration's `.sql` file imported as a text module).
 */
export interface DurableObjectMigrations {
  readonly migrations: Record<string, string>;
  readonly migrationsTable?: string | undefined;
}

export interface DurableObjectConfig<
  TRelations extends AnyRelations = EmptyRelations,
> extends Omit<
  SQLiteDoDrizzle.EffectDrizzleSQLiteDoConfig<TRelations>,
  "storage"
> {
  /**
   * Migrations to apply before the db is returned — pass the default
   * export of drizzle-kit's generated `migrations.js` directly.
   */
  readonly migrations?: DurableObjectMigrations | undefined;
}

/**
 * Open a Drizzle database over the current Durable Object's SQLite
 * storage using the `drizzle-orm/effect-sqlite-do` integration (driven by
 * `@effect/sql-sqlite-do`'s `SqliteClient`), applying drizzle-kit's
 * generated migrations first when provided.
 *
 * Every query is an Effect with a typed error channel — drizzle's
 * `EffectDrizzleQueryError` (query + params + cause, wrapping the
 * underlying effect-sql `SqlError`) — so failures are handled with
 * `Effect.catchTag` instead of leaking as defects. Transactions add
 * `SqlError` to the union. Opening the db itself never fails: a
 * migration that cannot apply dies, since the instance is unusable
 * without its schema.
 *
 * Yield it in the object's inner (instance) Effect — it runs when the
 * instance activates, before any request reaches its methods:
 *
 * ```typescript
 * // schema.ts
 * import { defineRelations } from "drizzle-orm";
 * import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
 *
 * export const users = sqliteTable("users", {
 *   id: integer("id").primaryKey({ autoIncrement: true }),
 *   name: text("name").notNull(),
 * });
 *
 * export const posts = sqliteTable("posts", {
 *   id: integer("id").primaryKey({ autoIncrement: true }),
 *   userId: integer("user_id").notNull().references(() => users.id),
 *   title: text("title").notNull(),
 * });
 *
 * export const relations = defineRelations({ users, posts }, (t) => ({
 *   users: { posts: t.many.posts() },
 *   posts: { author: t.one.users({ from: t.posts.userId, to: t.users.id }) },
 * }));
 * ```
 *
 * ```typescript
 * import * as Drizzle from "alchemy/Drizzle/Cloudflare";
 * import migrations from "./drizzle/migrations.js";
 * import { posts, relations, users } from "./schema.ts";
 *
 * export class Users extends Cloudflare.DurableObject<Users>()(
 *   "Users",
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const db = yield* Drizzle.DurableObject({ migrations, relations });
 *
 *       return {
 *         addUser: (name: string) => db.insert(users).values({ name }),
 *         listUsers: () => db.select().from(users),
 *         listUsersWithPosts: () =>
 *           db.query.users.findMany({ with: { posts: true } }),
 *         // typed error handling per operation:
 *         tryAddUser: (name: string) =>
 *           db
 *             .insert(users)
 *             .values({ name })
 *             .pipe(
 *               Effect.catchTag("EffectDrizzleQueryError", () =>
 *                 Effect.succeed(undefined),
 *               ),
 *             ),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 */
export const DurableObject = Effect.fn("Drizzle.DurableObject")(function* <
  TRelations extends AnyRelations = EmptyRelations,
>(config?: DurableObjectConfig<TRelations>) {
  const state = yield* DurableObjectState;
  const storage = state.raw.storage;
  const { migrations, ...drizzleConfig } = config ?? {};
  // Built on the ambient (instance) Scope — the client wraps the DO's
  // local SQLite storage, so there is no disposable resource behind it.
  const services = yield* Layer.build(SqliteDoClient.layer({ storage }));
  const db = yield* SQLiteDoDrizzle.makeWithDefaults({
    ...(drizzleConfig as Omit<
      SQLiteDoDrizzle.EffectDrizzleSQLiteDoConfig<TRelations>,
      "storage"
    >),
    storage,
  }).pipe(Effect.provideContext(services));
  if (migrations !== undefined) {
    // A migration that cannot apply leaves the instance unusable — there
    // is no meaningful recovery at init, so it dies rather than forcing
    // every caller to handle (or orDie) an error channel.
    yield* migrate(db, {
      migrations: migrations.migrations,
      ...(migrations.migrationsTable !== undefined
        ? { migrationsTable: migrations.migrationsTable }
        : {}),
    }).pipe(Effect.orDie);
  }
  return db;
});
