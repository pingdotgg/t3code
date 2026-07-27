import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import ArtifactsEffectWorker from "./effect-worker.ts";
import { Repos } from "./shared.ts";

/**
 * Async-style Worker that declares the shared Artifacts namespace on its `env`.
 * `InferEnv` resolves `REPOS` to the native `cf.Artifacts` runtime binding.
 */
export const AsyncWorker = Cloudflare.Worker("ArtifactsAsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "async-worker.ts"),
  env: {
    REPOS: Repos,
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

/**
 * Deploys both invocation styles — the Effect-native worker
 * (`Cloudflare.Artifacts.ReadWriteNamespace(Repos)` + `ReadWriteNamespaceBinding`) and the async
 * worker (`env: { REPOS }`) — against one shared Artifacts namespace, so the
 * driver test can exercise the client surface (`create`/`list`/`get`/`delete`)
 * over both.
 */
export default Alchemy.Stack(
  "ArtifactsBindingStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* ArtifactsEffectWorker;
    return {
      asyncWorkerUrl: asyncWorker.url.as<string>(),
      effectWorkerUrl: effectWorker.url.as<string>(),
    };
  }),
);
