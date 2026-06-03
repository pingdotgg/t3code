import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import DnsEffectWorker from "./effect.ts";

export default Alchemy.Stack(
  "DnsTestStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const effectWorker = yield* DnsEffectWorker;
    return {
      effectUrl: effectWorker.url.as<string>(),
    };
  }),
);
