import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Drizzle from "@/Drizzle/index.ts";
import * as Effect from "effect/Effect";

/**
 * The full deploy-time Drizzle flywheel on D1:
 *
 *   1. `Drizzle.Schema` diffs `drizzle-schema.ts` against the checked-in
 *      snapshot under `drizzle-migrations/` and regenerates SQL on drift
 *      (no drift in CI — the initial migration is checked in).
 *   2. `Cloudflare.D1.Database` detects the drizzle-kit layout and applies
 *      pending migrations through drizzle-orm's own migrator, tracked in
 *      the `drizzle_migrations` table (a custom-table override of drizzle's
 *      default `__drizzle_migrations`).
 *
 * Paths are relative to the test cwd (`packages/alchemy`).
 */
export const DrizzleDb = Effect.gen(function* () {
  const schema = yield* Drizzle.Schema("d1-drizzle-schema", {
    schema: "./test/Cloudflare/D1/fixtures/drizzle-schema.ts",
    out: "./test/Cloudflare/D1/fixtures/drizzle-migrations",
    dialect: "sqlite",
  });

  return yield* Cloudflare.D1.Database("D1DrizzleDatabase", {
    migrations: { dir: schema.out, table: "drizzle_migrations" },
  });
});
