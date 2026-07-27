import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as pathe from "pathe";
import HyperdriveEffectWorker from "./effect-worker.ts";

/**
 * Async Worker that binds the shared Hyperdrive Connection via `env`. The
 * Connection (and its Neon Postgres origin) share the same logical IDs as
 * the ones the effect-worker binds, so the engine dedupes them to a single
 * deployed resource that both workers observe.
 */
export const AsyncWorker = Cloudflare.Worker("HyperdriveAsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "async-worker.ts"),
  env: {
    HD: Effect.gen(function* () {
      const project = yield* Neon.Project("HyperdriveBindingProject");
      return yield* Cloudflare.Hyperdrive.Connection(
        "HyperdriveBindingConnection",
        { origin: project.origin },
      );
    }),
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

/**
 * Deploys two Workers that bind ONE shared Hyperdrive Connection — the
 * effect-worker (via `Cloudflare.Hyperdrive.Connect`) and the async-worker
 * (via `env: { HD: connection }`). Extracted into its own stack file so it
 * can also be inspected directly, e.g.
 *
 * ```sh
 * alchemy tail --stage test ./test/Cloudflare/Hyperdrive/fixtures/stack.ts
 * ```
 */
export default Alchemy.Stack(
  "HyperdriveBindingStack",
  {
    providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const effectWorker = yield* HyperdriveEffectWorker;
    const asyncWorker = yield* AsyncWorker;
    return {
      effectWorkerUrl: effectWorker.url.as<string>(),
      asyncWorkerUrl: asyncWorker.url.as<string>(),
    };
  }),
);
