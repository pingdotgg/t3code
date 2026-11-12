import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import ArtifactsEffectWorker from "./effect-worker.ts";
import ArtifactsReadWorker from "./read-worker.ts";
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
 * worker (`env: { REPOS }`) — plus a read-only worker
 * (`Cloudflare.Artifacts.ReadNamespace(Repos)`) against one shared Artifacts
 * namespace, so the driver test can exercise the namespace surface over both
 * styles and the repo read surface through the read-only binding.
 */
export default Alchemy.Stack(
  "ArtifactsBindingStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* ArtifactsEffectWorker;
    const readWorker = yield* ArtifactsReadWorker;
    return {
      readWorkerUrl: readWorker.url.as<string>(),
      asyncWorkerUrl: asyncWorker.url.as<string>(),
      effectWorkerUrl: effectWorker.url.as<string>(),
    };
  }),
);
