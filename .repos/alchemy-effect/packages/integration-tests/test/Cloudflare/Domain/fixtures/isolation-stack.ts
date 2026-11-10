import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import DomainIsolationWorker from "./isolation-worker.ts";

export default Alchemy.Stack(
  "DomainIsolationStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* DomainIsolationWorker;
    return { url: worker.url.as<string>(), workerName: worker.workerName };
  }),
);
