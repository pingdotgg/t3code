import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import BindingEffectCaller from "./binding-effect-caller.ts";
import BindingTargetWorker from "./binding-target-worker.ts";

const asyncCallerMain = pathe.resolve(
  import.meta.dirname,
  "binding-async-caller.ts",
);

/**
 * Stack with three workers:
 *
 * - `BindingTargetWorker` — Effect-native target exposing `greet` (RPC) +
 *   `fetch`.
 * - `BindingAsyncCaller` — plain `{ fetch }` Cloudflare worker that calls
 *   `env.TARGET.greet(name)` over a service binding.
 * - `BindingEffectCaller` — Effect-native worker that uses
 *   `Cloudflare.bindWorker(BindingTargetWorker)` to call `greet` from
 *   inside an Effect.
 */
export default Alchemy.Stack(
  "WorkerBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const target = yield* BindingTargetWorker;

    const asyncCaller = yield* Cloudflare.Worker("BindingAsyncCaller", {
      main: asyncCallerMain,
      env: {
        TARGET: target,
      },
    });

    const effectCaller = yield* BindingEffectCaller;

    return {
      targetUrl: target.url.as<string>(),
      asyncCallerUrl: asyncCaller.url.as<string>(),
      effectCallerUrl: effectCaller.url.as<string>(),
    };
  }),
);
