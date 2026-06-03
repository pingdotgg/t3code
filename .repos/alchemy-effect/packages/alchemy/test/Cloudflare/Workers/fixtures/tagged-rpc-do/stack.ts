import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import WorkerALayer, { WorkerA } from "./workerA.ts";
import WorkerB from "./workerB.ts";
import WorkerCLayer, { WorkerC } from "./workerC.ts";

export default Alchemy.Stack(
  "TaggedRpcDOExample",
  {
    state: Cloudflare.state(),
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const workerA = yield* WorkerA;
    const workerB = yield* WorkerB;
    const workerC = yield* WorkerC;

    return {
      urlA: workerA.url.as<string>(),
      urlB: workerB.url.as<string>(),
      urlC: workerC.url.as<string>(),
    };
  }).pipe(Effect.provide(WorkerALayer), Effect.provide(WorkerCLayer)),
);
