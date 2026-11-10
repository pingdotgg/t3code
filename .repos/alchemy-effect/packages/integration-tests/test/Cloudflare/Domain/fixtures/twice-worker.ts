import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Account, Billing, Open } from "./isolation.ts";

/**
 * Hosts Billing twice, each provided on its own: `POST /open/<id>/<owner>`
 * writes through the first, `GET /state/<id>` reads through the second.
 */
export default class DomainTwiceWorker extends Cloudflare.Worker<DomainTwiceWorker>()(
  "DomainTwiceWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const accounts = Effect.map(Effect.all({ accounts: Account }), ({ accounts }) => accounts);
    const BillingLive = Billing.layer(Layer.empty).pipe(
      Layer.provide(DomainCloudflare.layerDurableObjects()),
    );
    const writer = yield* Effect.provide(accounts, BillingLive);
    const reader = yield* Effect.provide(accounts, BillingLive);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, id, owner] = new URL(request.url, "http://localhost").pathname.split("/");
        if (route === "open") {
          yield* writer.send(id!, new Open({ owner: owner! }));
          return yield* HttpServerResponse.json({ ok: true });
        }
        return yield* HttpServerResponse.json(yield* reader.state(id!));
      }).pipe(Effect.orDie),
    };
  }),
) {}
