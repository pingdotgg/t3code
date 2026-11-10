import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import RestartContainerLive from "./container.ts";
import Worker from "./worker.ts";

export default Alchemy.Stack(
  "RestartContainerStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return {
      url: worker.url.as<string>(),
    };
  }).pipe(Effect.provide(RestartContainerLive)),
);
