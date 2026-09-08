import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Neon from "@/Neon";
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
