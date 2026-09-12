import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import DynamicLoaderEffectWorker from "./effect-worker.ts";
import DynamicLoaderGetWorker from "./get-worker.ts";

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
    const getWorker = yield* DynamicLoaderGetWorker;

    return {
      asyncWorkerUrl: asyncWorker.url.as<string>(),
      effectWorkerUrl: effectWorker.url.as<string>(),
      getWorkerUrl: getWorker.url.as<string>(),
    };
  }),
);
