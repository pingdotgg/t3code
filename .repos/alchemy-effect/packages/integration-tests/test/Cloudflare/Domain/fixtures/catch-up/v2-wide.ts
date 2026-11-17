import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Deposits, WideTimeline, Widened } from "./ledger.ts";
import { hosted, ledgerWorker } from "./worker.ts";

/** The timeline reads the journal too, without a version bump: its backfill read only accounts. */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  ledgerWorker("v2-wide", Deposits, WideTimeline).pipe(
    Effect.provide(hosted(Widened.layer(Layer.empty))),
  ),
) {}
