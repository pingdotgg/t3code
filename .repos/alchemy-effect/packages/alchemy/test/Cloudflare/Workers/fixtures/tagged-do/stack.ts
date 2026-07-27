import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import WorkerALive, { WorkerA } from "./workerA.ts";
import WorkerB from "./workerB.ts";
import WorkerCLive, { WorkerC } from "./workerC.ts";

export default Alchemy.Stack(
  "TaggedDOExample",
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
  }).pipe(Effect.provide(Layer.provideMerge(WorkerALive, WorkerCLive))),
);
