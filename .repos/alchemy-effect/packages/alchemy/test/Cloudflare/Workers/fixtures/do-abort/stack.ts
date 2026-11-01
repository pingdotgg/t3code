import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
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
