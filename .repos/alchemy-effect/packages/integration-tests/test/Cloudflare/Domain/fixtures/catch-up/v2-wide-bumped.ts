import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Deposits, WideTimelineV1, WidenedV1 } from "./ledger.ts";
import { hosted, ledgerWorker } from "./worker.ts";

/** The timeline reads the journal too, at version 1: rebuilt from every source's history. */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  ledgerWorker("v2-wide-bumped", Deposits, WideTimelineV1).pipe(
    Effect.provide(hosted(WidenedV1.layer(Layer.empty))),
  ),
) {}
