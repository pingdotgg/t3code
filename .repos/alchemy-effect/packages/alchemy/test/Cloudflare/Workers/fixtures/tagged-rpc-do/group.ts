import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

/**
 * Shared RPC group for the cross-script `tagged-rpc-do` fixture.
 *
 * Served on **two** ends:
 * - Each {@link Cloudflare.RpcDurableObjectNamespace} instance
 *   (`Counter`) — the per-instance counter surface.
 * - WorkerA, an {@link Cloudflare.RpcWorker} that forwards each call
 *   to `counter.getByName(key)` so consumers can hit the counter over
 *   a service binding without knowing about DO routing.
 *
 * Every payload carries `key`. WorkerA uses it to pick the DO instance
 * via `getByName(key)`; the DO uses it for D1 row partitioning and
 * ignores it for the per-instance storage methods (already isolated
 * by `getByName(name)`).
 */
export class CounterRpcs extends RpcGroup.make(
  Rpc.make("incrementD1", {
    payload: { key: Schema.String },
    success: Schema.Struct({ value: Schema.Number }),
  }),
  Rpc.make("getD1", {
    payload: { key: Schema.String },
    success: Schema.Struct({ value: Schema.Number }),
  }),
  Rpc.make("incrementDO", {
    payload: { key: Schema.String },
    success: Schema.Struct({ value: Schema.Number }),
  }),
  Rpc.make("getDO", {
    payload: { key: Schema.String },
    success: Schema.Struct({ value: Schema.Number }),
  }),
  Rpc.make("reset", {
    payload: { key: Schema.String },
    success: Schema.Void,
  }),
) {}
