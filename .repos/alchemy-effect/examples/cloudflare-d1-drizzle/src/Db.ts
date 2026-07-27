import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";

/**
 * A Drizzle schema + D1 database. The database's `migrationsDir` is wired to
 * the schema resource's `out` output, so the provider order becomes:
 *
 *   1. `Drizzle.Schema` regenerates pending migration SQL files whenever
 *      `src/schema.ts` drifts from the latest checked-in snapshot.
 *   2. `Cloudflare.D1.Database` scans the directory and applies any new
 *      migrations into the `drizzle_migrations` table.
 */
export const Database = Effect.gen(function* () {
  const schema = yield* Drizzle.Schema("app-schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
    dialect: "sqlite",
  });

  return yield* Cloudflare.D1.Database("app-db", {
    migrationsDir: schema.out,
    migrationsTable: "drizzle_migrations",
  });
});
