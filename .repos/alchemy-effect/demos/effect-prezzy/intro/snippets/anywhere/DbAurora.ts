import * as AWS from "@alchemy.run/aws";
import * as Postgres from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Private } from "./Network.ts";

// #region show
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* AWS.RDS.Aurora("Db", yield* Private);
    const db = yield* AWS.RDS.Connect(database.cluster, {
      secret: database.secret,
      database: "chat",
    });
    return Postgres.PostgresLayer({ url: Effect.map(db, (info) => info.url) });
  }),
) /*hide*/
  .pipe(Layer.provide(AWS.RDS.ConnectHttp)); /*end*/
// #endregion show
