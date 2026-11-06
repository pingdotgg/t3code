import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Bank, Latest, Summary } from "./model.ts";
import { bankWorker, hosted } from "./worker.ts";

/** The first deploy: the summary counts deposits only. */
export default class DomainVersionWorker extends Cloudflare.Worker<DomainVersionWorker>()(
  "DomainVersionWorker",
  { main: import.meta.url },
  bankWorker("v0", Summary, Latest).pipe(Effect.provide(hosted(Bank.layer(Layer.empty)))),
) {}
