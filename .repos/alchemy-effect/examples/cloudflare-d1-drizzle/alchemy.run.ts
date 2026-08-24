import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import Api from "./src/Api.ts";
import { Database } from "./src/Db.ts";

export default Alchemy.Stack(
  "CloudflareD1DrizzleExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const db = yield* Database;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      databaseName: db.databaseName,
    };
  }),
);
