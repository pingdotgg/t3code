import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Postgres from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

// The Database module built up line by line (Db.ts is the finished file).
// #region show
/** The Database module's interface: a SQL client. */
export const Database = SqlClient.SqlClient;

export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const db = yield* Neon.Project("Db", { migrations: "./migrations" });
    // #region pool
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", { origin: db.origin });
    // #endregion pool
    // #region connect
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    // #endregion connect
    // #region ret
    return Postgres.PostgresLayer({ url: connection.connectionString });
    // #endregion ret
  }),
) /*hide*/
  .pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding)); /*end*/
// #endregion show
