import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AfterV1, benchWorker, DepositsV1, hosted } from "./worker.ts";

/** The view at version 1, waiting at most a second for its rebuild. */
export default class DomainBenchWorker extends Cloudflare.Worker<DomainBenchWorker>()(
  "DomainBenchWorker",
  { main: import.meta.url },
  benchWorker("v3", { kind: "deposits", view: DepositsV1 }).pipe(
    Effect.provide(
      hosted(AfterV1.layer(Layer.empty), {
        backfillTimeout: "1 second",
      }),
    ),
  ),
) {}
