import * as PrPackage from "@alchemy.run/pr-package";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "./pr-package/Api.ts";

export default Alchemy.Stack(
  "PrPackage",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const authToken = yield* PrPackage.AuthTokenValue;
    const api = yield* Api;
    return {
      url: api.url.as<string>(),
      authToken: authToken.text,
    };
  }),
);
