import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { After, Deposits, Timeline } from "./ledger.ts";
import { hosted, ledgerWorker } from "./worker.ts";

/** The second deploy adds the view. */
export default class DomainCatchUpWorker extends Cloudflare.Worker<DomainCatchUpWorker>()(
  "DomainCatchUpWorker",
  {
    main: import.meta.url,
    // Protocol traces (`backfill …`) in the Worker logs.
    ...(process.env.DOMAIN_BENCH_DEBUG ? { env: { DEBUG: "1" } } : {}),
  },
  ledgerWorker("v2", Deposits, Timeline).pipe(Effect.provide(hosted(After.layer(Layer.empty)))),
) {}
