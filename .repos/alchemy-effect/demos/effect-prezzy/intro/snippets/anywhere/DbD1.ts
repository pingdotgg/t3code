import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SQL from "@alchemy.run/cloudflare/D1/SQL";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// #region show
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.Database("Db");
    const db = yield* Cloudflare.D1.QueryDatabase(database);
    return SQL.D1Layer(db);
  }),
) /*hide*/
  .pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding)); /*end*/
// #endregion show
