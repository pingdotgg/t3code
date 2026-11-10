import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CountersLive, serve } from "./counter-model.ts";

/** The counter model on Durable Objects restricted to the EU jurisdiction. */
export default class DomainCounterWorker extends Cloudflare.Worker<DomainCounterWorker>()(
  "DomainCounterWorker",
  { main: import.meta.url },
  serve("eu").pipe(
    Effect.provide(
      CountersLive.pipe(
        Layer.provide(DomainCloudflare.layerDurableObjects({ jurisdiction: "eu" })),
      ),
    ),
  ),
) {}
