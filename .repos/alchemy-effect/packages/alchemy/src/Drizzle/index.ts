export * from "./D1.ts";

// The tagged errors drizzle's effect drivers fail with — re-exported so
// consumers can reference them without reaching into drizzle-orm
// internals. (`Effect.catchTag` needs only the tag string; these are for
// instanceof checks, schemas, and annotations.)
export {
  EffectDrizzleError,
  EffectDrizzleQueryError,
  EffectTransactionRollbackError,
  MigratorInitError,
} from "drizzle-orm/effect-core";
export * from "./Providers.ts";
export * from "./Schema.ts";
// MySQL and Postgres are deliberately NOT re-exported here: their drivers
// (`@effect/sql-mysql2`/`mysql2`, `@effect/sql-pg`/`pg`) are optional peer
// dependencies, and keeping them out of the barrel keeps them out of every
// non-user's module graph. Import them via their subpaths instead:
// `alchemy/Drizzle/MySQL`, `alchemy/Drizzle/Postgres`.
