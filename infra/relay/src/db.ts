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

export class RelayDb extends Context.Service<RelayDb, RelayDatabase>()("RelayDb") {}

const relayPostgresDatabaseName = "t3coderelay-relaypostgresdatabase-dev-julius-qcduwqxl7fi3rjlx";
export const relayPostgresDatabaseRegion = { slug: "us-west" } as const;

export const RelaySchema = Drizzle.Schema("RelaySchema", {
  schema: "./src/schema.ts",
  out: "./migrations/postgres",
  dialect: "postgres",
});

export const PlanetscaleDatabase = Effect.gen(function* () {
  const schema = yield* RelaySchema;
  const database = yield* Planetscale.PostgresDatabase("RelayPostgresDatabase", {
    name: relayPostgresDatabaseName,
    region: relayPostgresDatabaseRegion,
    clusterSize: "PS_5",
    migrationsDir: schema.out,
    migrationsTable: "relay_migrations",
    replicas: 0, // BUMP BEFORE GOING TO PROD
  });

  const runtimeRole = yield* Planetscale.PostgresRole("RelayPostgresRuntimeRole", {
    database: relayPostgresDatabaseName,
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
