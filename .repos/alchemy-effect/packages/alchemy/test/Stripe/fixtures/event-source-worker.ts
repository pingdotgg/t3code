import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Stripe from "@/Stripe/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class StripeEventSourceWorker extends Cloudflare.Worker<StripeEventSourceWorker>()(
  "StripeEventSourceWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const log = yield* Cloudflare.KV.Namespace("EventLog");
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(log);
    const createCustomer = yield* Stripe.CreateCustomer();

    yield* Stripe.consumeEvents(
      "Events",
      { events: [Stripe.CustomerCreated] },
      Effect.fn(function* (event) {
        yield* kv.put(event.object.id, "1").pipe(Effect.orDie);
        yield* kv.put("lastCustomerId", event.object.id).pipe(Effect.orDie);
      }),
    ).pipe(Effect.orDie);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/last/")) {
          const id = request.url.slice("/last/".length).split("?")[0];
          const seen = yield* kv.get(id).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            id: seen === "1" ? id : null,
          });
        }
        if (request.url.startsWith("/last")) {
          const id = yield* kv.get("lastCustomerId").pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ id: id ?? null });
        }
        if (request.method === "POST" && request.url.startsWith("/customers")) {
          const customer = yield* createCustomer({
            email: "event-source@example.com",
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            { id: customer.id },
            { status: 201 },
          );
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.KV.ReadWriteNamespaceBinding,
      Stripe.CreateCustomerHttp,
      Stripe.ConsumeEventsLive,
    ]),
  ),
) {}
