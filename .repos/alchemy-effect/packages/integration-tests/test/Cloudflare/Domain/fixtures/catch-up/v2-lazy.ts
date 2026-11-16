import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Account, Deposits } from "./ledger.ts";
import { hosted, ledgerWorker } from "./worker.ts";

/** The view added lazily: each account's key reads its history when first read. */
class LazyLedger extends Domain.Model("Ledger", { aggregates: [Account], views: [Deposits] }) {}

export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  ledgerWorker("v2-lazy", Deposits).pipe(
    Effect.provide(hosted(LazyLedger.layer(Layer.empty, { lazy: ["Deposits"] }))),
  ),
) {}
