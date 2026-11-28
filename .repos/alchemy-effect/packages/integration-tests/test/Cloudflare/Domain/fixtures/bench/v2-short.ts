import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Deposits } from "../catch-up/ledger.ts";
import { After, benchWorker, hosted } from "./worker.ts";

/** The view deploy, waiting at most a second for its backfill: the deploy fails while it runs on. */
export default class DomainBenchWorker extends Cloudflare.Worker<DomainBenchWorker>()(
  "DomainBenchWorker",
  { main: import.meta.url },
  benchWorker("v2", { kind: "deposits", view: Deposits }).pipe(
    Effect.provide(hosted(After.layer(Layer.empty), { backfillTimeout: "1 second" })),
  ),
) {}
