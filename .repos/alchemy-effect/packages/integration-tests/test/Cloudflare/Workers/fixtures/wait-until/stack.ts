import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import WaitUntilWorker from "./wait-until-worker.ts";

export default Alchemy.Stack(
  "WaitUntilStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* WaitUntilWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
