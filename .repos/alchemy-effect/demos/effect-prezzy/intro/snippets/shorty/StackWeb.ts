import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./Api.ts";

// #region show
export default Alchemy.Stack(
  "Shorty",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    // #region web
    const web = yield* Cloudflare.Website.Vite("Web", {
      // #region env
      env: { VITE_API_URL: api.url.as<string>() },
      // #endregion env
    });
    // #endregion web
    // #region returnApi
    return { api: api.url.as<string>() };
    // #endregion returnApi
    // #region returnWeb
    return { api: api.url.as<string>(), web: web.url };
    // #endregion returnWeb
  }),
);
// #endregion show
