import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Postgres from "@alchemy.run/sql/Postgres";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

// #region show
/** The Database module's interface: a SQL client. */
export const Database = SqlClient.SqlClient;

export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    // #region stage
    const { stage } = yield* Stack;
    // #endregion stage
    // #region db
    const db = stage.startsWith("pr-")
      ? yield* Neon.Branch("Db", {
          project: yield* Neon.Project.ref("Db", { stage: "staging" }),
        })
      : yield* Neon.Project("Db", { migrations: "./migrations" });
    // #endregion db
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", { origin: db.origin });
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    return Postgres.PostgresLayer({ url: connection.connectionString });
  }),
) /*hide*/
  .pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding)); /*end*/
// #endregion show
