import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CountersLive, serve } from "./counter-model.ts";

/**
 * The same Worker as `eu-worker.ts`, on the unrestricted default platform.
 * Deploying one over the other switches the model's jurisdiction in place.
 */
export default class DomainCounterWorker extends Cloudflare.Worker<DomainCounterWorker>()(
  "DomainCounterWorker",
  { main: import.meta.url },
  serve("unrestricted").pipe(
    Effect.provide(CountersLive.pipe(Layer.provide(DomainCloudflare.layerDurableObjects()))),
  ),
) {}
