import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import AbortWorker from "./abort-worker.ts";

export default Alchemy.Stack(
  "DurableObjectAbortStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* AbortWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
