import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { TargetRpcs } from "./group.ts";

/**
 * Effect-native `RpcWorker` that exposes `greet(name)`. Used as the
 * *callee* in the RpcWorker-binding fixture — the caller worker
 * yields `Cloudflare.RpcWorker.bind(BindingTargetRpcWorker)` to obtain
 * a typed `RpcClient<TargetRpcs>`.
 */
export default class BindingTargetRpcWorker extends Cloudflare.RpcWorker<BindingTargetRpcWorker>()(
  "BindingTargetRpcWorker",
  { main: import.meta.url, schema: TargetRpcs },
  Effect.gen(function* () {
    const handlers = TargetRpcs.toLayer({
      Greet: ({ name }) => Effect.succeed({ greeting: `hello ${name}` }),
    });
    return RpcServer.toHttpEffect(TargetRpcs).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    );
  }),
) {}
