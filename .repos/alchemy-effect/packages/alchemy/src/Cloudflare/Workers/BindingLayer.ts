import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CoreBinding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Binding } from "./Binding.ts";
import { isWorker, WorkerEnvironment } from "./Worker.ts";

/**
 * Native runtime layer for a Worker-only {@link Binding}. Registers the native
 * binding on the host Worker at deploy time (via `binding.toWorkerBinding()`)
 * and builds the Effect-native client from the lazy `env[name]` accessor.
 *
 * Factored out of `Binding.ts` (which must stay free of `Worker.ts` to avoid an
 * import cycle through the contract files). Each binding's layer is a one-liner:
 * `export const XBinding = makeBindingLayer(X, makeXClient)`.
 */
export const makeBindingLayer = <Self, Runtime, Client>(
  tag: Self,
  makeClient: (
    raw: Effect.Effect<Runtime, never, RuntimeContext>,
    binding: Binding<string, Client, Self>,
  ) => Client,
): Layer.Layer<Self, never, WorkerEnvironment> =>
  Layer.effect(
    tag as never,
    Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      return Effect.fn(function* (binding: Binding<string, Client>) {
        // Deploy-time only: register the native binding on the host Worker.
        if (!globalThis.__ALCHEMY_RUNTIME__) {
          const host = yield* CoreBinding.Host;
          if (isWorker(host)) {
            yield* host.bind(binding.name, {
              bindings: [binding.toWorkerBinding()],
            });
          }
        }
        // Lazy: `WorkerEnvironment` is only populated at exec phase.
        const raw = Effect.sync(
          () => (env as Record<string, Runtime>)[binding.name]!,
        ) as Effect.Effect<Runtime, never, RuntimeContext>;
        return makeClient(raw, binding as Binding<string, Client, Self>);
      });
    }),
  ) as Layer.Layer<Self, never, WorkerEnvironment>;
