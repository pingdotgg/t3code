import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import VectorizeEffectWorker from "./effect-worker.ts";
import { ensureMetaIndex, TestIndex } from "./index-resource.ts";

/**
 * Async-style Worker: the shared Vectorize index is declared on `env`.
 * `WorkerAsyncBindings` resolves it (via `isIndex`) into the native
 * `vectorize` binding, so the plain `async fetch` handler in async-worker.ts
 * gets `env.INDEX` as the runtime `Vectorize` binding.
 */
export const AsyncWorker = Cloudflare.Worker("VectorizeAsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "async-worker.ts"),
  env: {
    INDEX: TestIndex,
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

/**
 * One stack deploying BOTH binding styles against ONE shared index. The
 * metadata index is declared at the stack level so it is created before either
 * worker upserts (filtered queries require it to pre-exist the vectors).
 */
export default Alchemy.Stack(
  "VectorizeBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const index = yield* TestIndex;
    yield* ensureMetaIndex(index);
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* VectorizeEffectWorker;

    return {
      asyncWorkerUrl: asyncWorker.url.as<string>(),
      effectWorkerUrl: effectWorker.url.as<string>(),
    };
  }),
);
