import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Alchemy from "alchemy";
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
