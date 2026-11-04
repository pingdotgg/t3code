import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { Database, type DatabaseInput, type Provider } from "./Database.ts";

type DrizzleDatabase = Parameters<typeof drizzleAdapter>[0];
type DrizzleDatabaseEffect = Effect.Effect<DrizzleDatabase, never, RuntimeContext | Scope.Scope>;

const isDatabaseEffect = (
  value: DrizzleDatabase | DrizzleDatabaseEffect,
): value is DrizzleDatabaseEffect => Effect.isEffect(value);

export interface DrizzleLayerConfig {
  /** The SQL dialect of the underlying drizzle database. */
  readonly provider: "pg" | "mysql" | "sqlite";
  /**
   * The drizzle schema containing the Better Auth tables (generate it with
   * `npx auth@1.7.5 generate`). When omitted, the adapter resolves tables
   * off the db instance's registered schema.
   */
  readonly schema?: Record<string, unknown>;
  /** @default false */
  readonly usePlural?: boolean;
  /** @default false (snake_case column names) */
  readonly camelCase?: boolean;
}

/**
 * Use an existing Drizzle database as Better Auth's storage via
 * better-auth's Relations v2 `drizzleAdapter`.
 *
 * Accepts a plain drizzle instance, or an Effect resolving to one for
 * databases that only materialize at runtime. NOTE: alchemy's own
 * `Drizzle.Postgres`/`Drizzle.D1` chainable proxies yield Effects rather
 * than thenables and cannot back the (promise-based) adapter — pass the
 * raw `drizzle(...)` instance instead.
 *
 * Schema management is yours: this layer has no automatic migration
 * support (`npx auth@1.7.5 generate` + your drizzle-kit flow own the
 * tables). Spread generated `authRelations` after your app's
 * `defineRelations` when constructing the db. The CLI configuration must
 * use `drizzleAdapter` from `@better-auth/drizzle-adapter/relations-v2`.
 * Run `npx auth@1.7.5 generate --config ./auth.cli.ts`.
 * Passing `--adapter drizzle` selects the CLI's legacy Relations v1 generator.
 *
 * ### Bringing your own Drizzle db
 * **Example:** Postgres drizzle instance with generated auth relations
 * ```typescript
 * import { BetterAuth } from "@alchemy.run/better-auth";
 * import { Drizzle } from "@alchemy.run/better-auth/Drizzle";
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import * as schema from "./auth-schema.ts";
 * import { relations } from "./app-schema.ts";
 *
 * const db = drizzle({
 *   client: pool,
 *   relations: { ...relations, ...schema.authRelations },
 * });
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   // ...
 * }).pipe(Effect.provide(Drizzle(db, { provider: "pg", schema })))
 * ```
 *
 * @layer
 * @provides BetterAuth.Database
 * @peer drizzle-orm
 * @peer @better-auth/drizzle-adapter
 * @product Drizzle
 */
export const Drizzle = (
  db: DrizzleDatabase | DrizzleDatabaseEffect,
  config: DrizzleLayerConfig,
): Layer.Layer<Database> =>
  Layer.sync(Database, () => ({
    provider: (config.provider === "pg" ? "postgres" : config.provider) as Provider,
    runtime: Effect.gen(function* () {
      const database = isDatabaseEffect(db) ? yield* db : db;
      return drizzleAdapter(database, {
        provider: config.provider,
        ...(config.schema !== undefined ? { schema: config.schema } : {}),
        ...(config.usePlural !== undefined ? { usePlural: config.usePlural } : {}),
        ...(config.camelCase !== undefined ? { camelCase: config.camelCase } : {}),
      }) as DatabaseInput;
    }),
  }));
