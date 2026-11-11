import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Before, benchWorker, hosted } from "./worker.ts";

/** The first deploy: accounts only, seeded with history. */
export default class DomainBenchWorker extends Cloudflare.Worker<DomainBenchWorker>()(
  "DomainBenchWorker",
  {
    main: import.meta.url,
    // Protocol traces (`backfill …`) in the Worker logs.
    ...(process.env.DOMAIN_BENCH_DEBUG ? { env: { DEBUG: "1" } } : {}),
  },
  benchWorker("v1").pipe(Effect.provide(hosted(Before.layer(Layer.empty)))),
) {}
