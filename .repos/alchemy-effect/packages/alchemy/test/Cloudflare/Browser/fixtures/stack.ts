import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import BrowserEffectWorker from "./effect-worker.ts";

const asyncWorkerMain = pathe.resolve(import.meta.dirname, "async-worker.ts");

export const AsyncWorker = Cloudflare.Worker("BrowserAsyncWorker", {
  main: asyncWorkerMain,
  compatibility: {
    flags: ["nodejs_compat"],
  },
  env: {
    BROWSER: Cloudflare.Browser({ name: "BROWSER" }),
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export default Alchemy.Stack(
  "BrowserBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* BrowserEffectWorker;

    return {
      asyncWorkerUrl: asyncWorker.url.as<string>(),
      effectWorkerUrl: effectWorker.url.as<string>(),
    };
  }),
);
