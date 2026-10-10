import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Planetscale from "@/Planetscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import PlanetscaleHostContainerWorker from "./worker.ts";

export default Alchemy.Stack(
  "PlanetscaleHostContainerStack",
  {
    providers: Layer.merge(Cloudflare.providers(), Planetscale.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* PlanetscaleHostContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
