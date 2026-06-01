import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface RelayDatabase extends EffectPgDatabase {
  readonly $client: PgClient;
}

export class RelayDb extends Context.Service<RelayDb, RelayDatabase>()("t3code-relay/db/RelayDb") {}

export const PlanetscaleDatabase = Effect.gen(function* () {
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });

  const database = yield* Planetscale.PostgresDatabase("RelayPostgresDatabase", {
    region: { slug: "us-west" },
    clusterSize: "PS_5",
    migrationsDir: schema.out,
    migrationsTable: "relay_migrations",
    replicas: 0, // BUMP BEFORE GOING TO PROD
  });

  const runtimeRole = yield* Planetscale.PostgresRole("RelayPostgresRuntimeRole", {
    database,
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });

  return { database, runtimeRole, schema };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const { runtimeRole } = yield* PlanetscaleDatabase;
  return yield* Cloudflare.Hyperdrive("RelayHyperdrive", {
    origin: runtimeRole.origin,
    caching: {
      disabled: true,
    },
    originConnectionLimit: 5,
  });
});
