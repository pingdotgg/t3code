import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import NeonHostContainerWorker from "./worker.ts";

export default Alchemy.Stack(
  "NeonHostContainerStack",
  {
    providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* NeonHostContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
