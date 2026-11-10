import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { BindingOrders, produceRoutes } from "./k2-shared.ts";

/**
 * Produces to a K2 stream through the native `k2` Worker binding
 * (`WriteStreamBinding` / `StreamSinkBinding`).
 */
export default class K2BindingWorker extends Cloudflare.Worker<K2BindingWorker>()(
  "K2BindingWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const orders = yield* BindingOrders;
    const typed = yield* Cloudflare.K2.WriteStream(orders);
    const sink = yield* Cloudflare.K2.StreamSink(orders);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return yield* produceRoutes(new URL(request.url, "http://x"), { typed, sink });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.K2.WriteStreamBinding, Cloudflare.K2.StreamSinkBinding),
    ),
  ),
) {}
