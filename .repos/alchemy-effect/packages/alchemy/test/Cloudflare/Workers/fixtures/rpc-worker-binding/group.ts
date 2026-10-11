import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

/**
 * RPCs exposed by the target {@link RpcWorker} — the canonical
 * `greet(name)` so the call site has an obvious round-trip to assert.
 */
export class TargetRpcs extends RpcGroup.make(
  Rpc.make("Greet", {
    payload: { name: Schema.String },
    success: Schema.Struct({ greeting: Schema.String }),
  }),
) {}

/**
 * RPCs exposed by the caller worker. `ProxyGreet` forwards through the
 * service-binding RPC client returned by `Cloudflare.RpcWorker.bind`.
 */
export class CallerRpcs extends RpcGroup.make(
  Rpc.make("ProxyGreet", {
    payload: { name: Schema.String },
    success: Schema.Struct({ greeting: Schema.String }),
  }),
) {}
