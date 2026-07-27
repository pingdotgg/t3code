import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { TestDatabase } from "./database.ts";
import D1EffectWorker from "./effect-worker.ts";

/**
 * Async (non-Effect) Worker bound to the shared {@link TestDatabase} via its
 * `env`. `InferEnv` maps the `Cloudflare.D1.Database` marker to the native
 * `cf.D1Database`, so `env.DB` is the runtime binding inside `async-worker.ts`.
 */
export const AsyncWorker = Cloudflare.Worker("D1AsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "async-worker.ts"),
  env: {
    DB: TestDatabase,
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

/**
 * One stack deploying both invocation styles against ONE shared D1 database.
 */
export default Alchemy.Stack(
  "D1BindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const effectWorker = yield* D1EffectWorker;
    const asyncWorker = yield* AsyncWorker;
    return {
      effectWorkerUrl: effectWorker.url.as<string>(),
      asyncWorkerUrl: asyncWorker.url.as<string>(),
    };
  }),
);
