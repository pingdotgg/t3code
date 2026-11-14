import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Deposits } from "../catch-up/ledger.ts";
import { After, benchWorker, hosted } from "./worker.ts";

/** The second deploy adds the view: the deploy waits for its backfill. */
export default class DomainBenchWorker extends Cloudflare.Worker<DomainBenchWorker>()(
  "DomainBenchWorker",
  {
    main: import.meta.url,
    // Protocol traces (`backfill …`) in the Worker logs.
    ...(process.env.DOMAIN_BENCH_DEBUG ? { env: { DEBUG: "1" } } : {}),
  },
  benchWorker("v2", { kind: "deposits", view: Deposits }).pipe(
    Effect.provide(hosted(After.layer(Layer.empty))),
  ),
) {}
