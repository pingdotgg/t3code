import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Db, PublicIp, Site } from "./src/shared.ts";

export default Alchemy.Stack(
  "FlyWebsiteViteExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const ip = yield* PublicIp;
    const db = yield* Db;
    const api = yield* Api;
    const web = yield* Fly.Website.Vite("Web", {
      env: {
        VITE_API_URL: Output.map(api.url, (url) => url ?? ""),
      },
      memo: {
        include: ["index.html", "src/**", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: web.url,
      apiUrl: api.url,
      appName: web.app?.appName,
      apiAppName: site.appName,
      ip: ip.ip,
      clusterId: db.clusterId,
    };
  }),
);
