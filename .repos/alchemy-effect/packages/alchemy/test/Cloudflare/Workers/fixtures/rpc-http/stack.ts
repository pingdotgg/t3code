import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import RpcHttpTestWorker from "./worker.ts";

export default Alchemy.Stack(
  "RpcHttpTestStack",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* RpcHttpTestWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
