import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import IsolatedContainerLive from "./container.ts";
import Worker from "./worker.ts";

export default Alchemy.Stack(
  "IsolatedProjectContainerStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return {
      url: worker.url.as<string>(),
    };
  }).pipe(Effect.provide(IsolatedContainerLive)),
);
