import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import DynamicLoaderEffectWorker from "./effect-worker.ts";

export const AsyncWorker = Cloudflare.Worker("DynamicLoaderAsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "async-worker.ts"),
  env: {
    LOADER: Cloudflare.WorkerLoader(),
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export default Alchemy.Stack(
  "DynamicWorkerLoaderStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* DynamicLoaderEffectWorker;

    return {
      asyncWorkerUrl: asyncWorker.url.as<string>(),
      effectWorkerUrl: effectWorker.url.as<string>(),
    };
  }),
);
