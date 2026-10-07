import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import AuthApi from "./src/worker.ts";

export default Alchemy.Stack(
  "BetterAuthTutorial",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* AuthApi;
    return { url: worker.url.as<string>() };
  }),
);
