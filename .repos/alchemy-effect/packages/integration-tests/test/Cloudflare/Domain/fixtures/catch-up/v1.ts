import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Before } from "./ledger.ts";
import { hosted, ledgerWorker } from "./worker.ts";

/** The first deploy: accounts only. */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  { main: import.meta.url },
  ledgerWorker("v1").pipe(Effect.provide(hosted(Before.layer(Layer.empty)))),
) {}
