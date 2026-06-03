import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import TunnelEffectWorker from "./effect.ts";

export default Alchemy.Stack(
  "TunnelsTestStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const effectWorker = yield* TunnelEffectWorker;
    return {
      effectUrl: effectWorker.url.as<string>(),
    };
  }),
);
