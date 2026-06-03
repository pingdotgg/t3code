import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import BindingCallerRpcWorker from "./caller-worker.ts";
import BindingTargetRpcWorker from "./target-worker.ts";

/**
 * Stack with two `RpcWorker`s wired through `RpcWorker.bind`:
 *
 * - `BindingTargetRpcWorker` — exposes `Greet`.
 * - `BindingCallerRpcWorker` — exposes `ProxyGreet`, which yields
 *   `Cloudflare.RpcWorker.bind(BindingTargetRpcWorker)` and forwards
 *   the call through the typed RPC client over the in-account service
 *   binding.
 */
export default Alchemy.Stack(
  "RpcWorkerBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const target = yield* BindingTargetRpcWorker;
    const caller = yield* BindingCallerRpcWorker;
    return {
      targetUrl: target.url.as<string>(),
      callerUrl: caller.url.as<string>(),
    };
  }),
);
