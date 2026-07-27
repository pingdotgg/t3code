import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { App } from "./app.ts";
import FlagshipEffectWorker from "./effect-worker.ts";

export const AsyncWorker = Cloudflare.Worker("FlagshipAsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "async-worker.ts"),
  env: {
    FLAGS: App,
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export default Alchemy.Stack(
  "FlagshipBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* FlagshipEffectWorker;

    return {
      asyncWorkerUrl: asyncWorker.url.as<string>(),
      effectWorkerUrl: effectWorker.url.as<string>(),
    };
  }),
);
