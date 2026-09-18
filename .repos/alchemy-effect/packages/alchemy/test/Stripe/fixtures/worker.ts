import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Stripe from "@/Stripe/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class StripeBindingWorker extends Cloudflare.Worker<StripeBindingWorker>()(
  "StripeBindingWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const product = yield* Stripe.Product("BoundProduct", {
      name: "Alchemy Bound Product",
      description: "Worker binding coverage",
    });
    const retrieveProduct = yield* Stripe.RetrieveProduct(product);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/product")) {
          const live = yield* retrieveProduct().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            id: live.id,
            name: live.name,
          });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Stripe.RetrieveProductHttp)),
) {}
