import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BankV1, LatestOfV1, SummaryV1 } from "./model.ts";
import { bankWorker, hosted } from "./worker.ts";

/** The summary fixed, at version 1: rebuilt in place, and the view built on it from the history. */
export default class DomainVersionWorker extends Cloudflare.Worker<DomainVersionWorker>()(
  "DomainVersionWorker",
  { main: import.meta.url },
  bankWorker("v1", SummaryV1, LatestOfV1).pipe(Effect.provide(hosted(BankV1.layer(Layer.empty)))),
) {}
