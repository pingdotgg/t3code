import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Postgres from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// #region show
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Neon.Project("Db");
    const db = yield* Neon.Branch("Db", { project: database });
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", { origin: db.origin });
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    return Postgres.PostgresLayer({ url: connection.connectionString });
  }),
) /*hide*/
  .pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding)); /*end*/
// #endregion show
