import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Postgres from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// #region show
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Planetscale.PostgresDatabase("Db", {
      clusterSize: "PS_10",
      arch: "arm",
    });
    const db = yield* Planetscale.PostgresRole("Db", { database, inheritedRoles: ["postgres"] });
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", { origin: db.origin });
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    return Postgres.PostgresLayer({ url: connection.connectionString });
  }),
) /*hide*/
  .pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding)); /*end*/
// #endregion show
