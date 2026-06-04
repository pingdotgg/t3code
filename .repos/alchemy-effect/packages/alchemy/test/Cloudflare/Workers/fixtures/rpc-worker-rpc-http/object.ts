import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { DoRpcs } from "./group.ts";

/**
 * Typed Durable Object backing the `*DO` variants on the
 * {@link RpcWorkerRpcHttpWorker}. Built with
 * {@link Cloudflare.RpcDurableObjectNamespace} so the worker can call
 * `objects.getByName(id).PingDO(...)` directly — no `RpcClient.make`,
 * no `Cloudflare.toHttpClient`, no manual transport plumbing.
 */
export default class RpcWorkerRpcHttpObject extends Cloudflare.RpcDurableObjectNamespace<RpcWorkerRpcHttpObject>()(
  "RpcWorkerRpcHttpObject",
  { schema: DoRpcs },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      let counter = 0;

      const handlers = DoRpcs.toLayer({
        PingDO: ({ message }) =>
          Effect.sync(() => ({ echo: message, n: ++counter })),
        CountDO: ({ upto }) =>
          Stream.fromIterable(
            Array.from({ length: Math.max(0, upto) }, (_, i) => i + 1),
          ),
      });

      return RpcServer.toHttpEffect(DoRpcs).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
      );
    });
  }),
) {}
