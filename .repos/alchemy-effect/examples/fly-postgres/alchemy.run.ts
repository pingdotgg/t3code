/**
 * Fly.io Managed Postgres + Drizzle, queried from an HTTP Service.
 *
 * Billed (~$38/mo Basic).
 */
import * as Alchemy from "alchemy";
import * as Drizzle from "alchemy/Drizzle";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/api.ts";
import { Db, Schema } from "./src/shared.ts";

export default Alchemy.Stack(
  "FlyPostgres",
  {
    providers: Layer.mergeAll(Fly.providers(), Drizzle.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const schema = yield* Schema;
    const db = yield* Db;
    const api = yield* Api;

    return {
      appName: api.appName,
      clusterId: db.clusterId,
      clusterName: db.name,
      region: db.region,
      migrations: schema.migrations,
      apiUrl: api.url,
    };
  }),
);
