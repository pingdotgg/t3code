import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import HttpApiTestWorker from "./worker.ts";

export default Alchemy.Stack(
  "HttpApiTestStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* HttpApiTestWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
