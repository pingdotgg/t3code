import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Account, Billing } from "./isolation.ts";

/** A different model with Billing's name. */
class OtherBilling extends Domain.Model("Billing", { aggregates: [Account] }) {}

/** Hosts two different models named Billing, each provided on its own. */
export default class DomainDuplicateWorker extends Cloudflare.Worker<DomainDuplicateWorker>()(
  "DomainDuplicateWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const accounts = Effect.map(Effect.all({ accounts: Account }), ({ accounts }) => accounts);
    const Platform = DomainCloudflare.layerDurableObjects();
    yield* Effect.provide(accounts, Billing.layer(Layer.empty).pipe(Layer.provide(Platform)));
    yield* Effect.provide(accounts, OtherBilling.layer(Layer.empty).pipe(Layer.provide(Platform)));
    return { fetch: Effect.succeed(HttpServerResponse.text("unreachable")) };
  }),
) {}
