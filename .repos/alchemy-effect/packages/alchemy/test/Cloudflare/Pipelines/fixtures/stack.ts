import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import PipelinesEffectWorker from "./effect-worker.ts";
import { EventsStream } from "./stream.ts";

export const AsyncWorker = Cloudflare.Worker("PipelinesAsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "async-worker.ts"),
  env: {
    EVENTS: EventsStream,
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export default Alchemy.Stack(
  "PipelinesBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* EventsStream;
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* PipelinesEffectWorker;

    return {
      asyncWorkerUrl: asyncWorker.url.as<string>(),
      effectWorkerUrl: effectWorker.url.as<string>(),
    };
  }),
);
