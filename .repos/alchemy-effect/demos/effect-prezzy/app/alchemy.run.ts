import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "Shorty",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;

    const dashboard = yield* Cloudflare.Website.Vite("Dashboard", {
      rootDir: "./web",
      env: { VITE_API_URL: api.url.as<string>() },
    });

    return { api: api.url, dashboard: dashboard.url };
  }),
);
