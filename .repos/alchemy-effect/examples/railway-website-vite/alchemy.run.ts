import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Railway from "alchemy/Railway";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import Api from "./src/api.ts";
import { Db, Site } from "./src/shared.ts";

const RAILWAY_TEST_DOMAIN = Config.string("RAILWAY_TEST_DOMAIN").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

export default Alchemy.Stack(
  "RailwayWebsiteViteExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const domain = yield* RAILWAY_TEST_DOMAIN;
    const project = yield* Site;
    const db = yield* Db;
    const api = yield* Api;
    const web = yield* Railway.Website.Vite("Web", {
      project,
      domain,
      env: {
        VITE_API_URL: Output.map(api.url, (url) => url ?? ""),
      },
      memo: {
        include: [
          "index.html",
          "src/**",
          "public/**",
          "package.json",
          "vite.config.ts",
        ],
      },
    });

    return {
      url: web.url,
      apiUrl: api.url,
      serviceId: web.service?.serviceId,
      postgresId: db.serviceId,
    };
  }),
);
