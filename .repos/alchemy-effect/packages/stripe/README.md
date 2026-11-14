# @alchemy.run/stripe

Stripe for [Alchemy](https://alchemy.run). Declare products, prices, webhooks, and Connect accounts next to the code that sells them, and call Stripe from a Worker with a token scoped to exactly the calls it makes.

```sh
npm install alchemy @alchemy.run/stripe @alchemy.run/cloudflare effect
```

A Worker that sells a monthly plan through Checkout and reacts to new subscriptions:

```typescript
// src/api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stripe from "@alchemy.run/stripe";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    // The catalog deploys with the Worker.
    const product = yield* Stripe.Product("Pro", { name: "Pro" });
    const price = yield* Stripe.Price("ProMonthly", {
      product,
      currency: "usd",
      unitAmount: 2000,
      recurring: { interval: "month" },
    });
    const priceId = yield* price.id;

    // Each call adds its permission to the Worker's restricted key.
    const createCheckout = yield* Stripe.CreateCheckoutSession();

    // Stripe → app: the webhook endpoint is created for you.
    yield* Stripe.consumeEvents(
      "Events",
      { events: [Stripe.CustomerSubscriptionCreated] },
      Effect.fn(function* (event) {
        yield* Effect.log(`${event.object.customer} subscribed`);
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const session = yield* createCheckout({
          mode: "subscription",
          line_items: [{ price: yield* priceId, quantity: 1 }],
          success_url: "https://example.com/welcome",
          cancel_url: "https://example.com/pricing",
        });
        return HttpServerResponse.redirect(session.url!);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide([Stripe.CreateCheckoutSessionHttp, Stripe.ConsumeEventsLive])),
) {}
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stripe from "@alchemy.run/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

## Learn more

- [Stripe on alchemy.run](https://alchemy.run/stripe)
- [Setup](https://alchemy.run/stripe/setup)
- [API reference](https://alchemy.run/providers)
