import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Prisma from "@alchemy.run/prisma";
import * as Postgres from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// #region show
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Prisma.Postgres("Db", { project: "chat" });
    const db = yield* Prisma.Connection("Db", { database });
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", {
      origin: db.origin.as<Prisma.PostgresOrigin>(),
    });
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    return Postgres.PostgresLayer({ url: connection.connectionString });
  }),
) /*hide*/
  .pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding)); /*end*/
// #endregion show
