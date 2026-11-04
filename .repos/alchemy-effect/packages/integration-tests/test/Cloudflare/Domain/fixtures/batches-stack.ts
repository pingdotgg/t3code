import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import DomainBatchesWorker from "./batches-worker.ts";

export default (state = Cloudflare.state()) =>
  Alchemy.Stack(
    "DomainBatchesStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* DomainBatchesWorker;
      return { url: worker.url.as<string>() };
    }),
  );
