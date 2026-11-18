import * as Cloudflare from "@alchemy.run/cloudflare";
import * as D1 from "@alchemy.run/cloudflare/D1/SQL";
import * as Neon from "@alchemy.run/neon";
import * as Postgres from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** SQLite on Cloudflare D1. */
export const D1Storage = Layer.unwrap(
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.Database("Db", { migrations: "./migrations" });
    return D1.D1Layer(yield* Cloudflare.D1.QueryDatabase(db));
  }),
).pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding));

/** Postgres on Neon, pooled at the edge by Hyperdrive. Same migrations. */
export const NeonStorage = Layer.unwrap(
  Effect.gen(function* () {
    const db = yield* Neon.Project("Postgres", { migrations: "./migrations" });
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", {
      origin: db.origin, // deployed: Hyperdrive pools Neon's direct endpoint
      dev: db.pooledOrigin, // alchemy dev: straight to Neon's own pooler
      caching: { disabled: true }, // links must be read-after-write
    });
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    return Postgres.PostgresLayer({ url: connection.connectionString });
  }),
).pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding));
