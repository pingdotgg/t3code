import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DoubledDeposits, Rebuilt, Timeline } from "./ledger.ts";
import { hosted, ledgerWorker } from "./worker.ts";

/** The third deploy redefines the view and bumps its version: it is rebuilt from the history. */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  ledgerWorker("v3", DoubledDeposits, Timeline).pipe(
    Effect.provide(hosted(Rebuilt.layer(Layer.empty))),
  ),
) {}
