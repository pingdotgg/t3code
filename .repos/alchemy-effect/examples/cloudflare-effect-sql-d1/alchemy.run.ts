import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Database } from "./src/database.ts";

export default Alchemy.Stack(
  "CloudflareEffectSqlD1Example",
  {
    providers: Cloudflare.providers(),
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
