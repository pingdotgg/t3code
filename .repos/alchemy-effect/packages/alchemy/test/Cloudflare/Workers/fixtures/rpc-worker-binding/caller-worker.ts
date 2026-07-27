import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { CallerRpcs } from "./group.ts";
import BindingTargetRpcWorker from "./target-worker.ts";

/**
 * Caller {@link RpcWorker} that uses `Cloudflare.RpcWorker.bind` to
 * obtain a typed client for {@link BindingTargetRpcWorker}. The bind
 * yields the client directly — the per-request handler just calls
 * `target.Greet({ name })` like any other Effect RpcClient. Internally
 * each method invocation builds a fresh underlying RPC client (via a
 * Proxy) because Cloudflare rejects cross-request reuse of the
 * service-binding stub I/O; that detail is hidden from the consumer.
 */
export default class BindingCallerRpcWorker extends Cloudflare.RpcWorker<BindingCallerRpcWorker>()(
  "BindingCallerRpcWorker",
  { main: import.meta.url, schema: CallerRpcs },
  Effect.gen(function* () {
    const target = yield* Cloudflare.RpcWorker.bind(BindingTargetRpcWorker);

    const handlers = CallerRpcs.toLayer({
      ProxyGreet: ({ name }) => target.Greet({ name }).pipe(Effect.orDie),
    });
    return RpcServer.toHttpEffect(CallerRpcs).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    );
  }),
) {}
