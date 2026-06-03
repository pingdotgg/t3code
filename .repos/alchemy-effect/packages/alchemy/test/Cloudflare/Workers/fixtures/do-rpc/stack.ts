import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import DurableObjectWorkerEnvironmentWorker from "./worker.ts";

export default Alchemy.Stack(
  "DurableObjectWorkerEnvironmentStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* DurableObjectWorkerEnvironmentWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
