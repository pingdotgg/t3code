import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

/**
 * RPCs implemented locally on the {@link RpcWorker} itself.
 *
 * - `Ping` — unary
 * - `Count` — streaming response
 */
export class InnerRpcs extends RpcGroup.make(
  Rpc.make("Ping", {
    payload: { message: Schema.String },
    success: Schema.Struct({ echo: Schema.String, n: Schema.Number }),
  }),
  Rpc.make("Count", {
    payload: { upto: Schema.Number },
    success: RpcSchema.Stream(Schema.Number, Schema.Never),
  }),
) {}

/**
 * RPCs served by the {@link RpcDurableObject} backing the
 * `*DO` variants below — same shapes as `InnerRpcs`, sharing the wire
 * codec end-to-end.
 */
export class DoRpcs extends RpcGroup.make(
  Rpc.make("PingDO", {
    payload: { message: Schema.String },
    success: Schema.Struct({ echo: Schema.String, n: Schema.Number }),
  }),
  Rpc.make("CountDO", {
    payload: { upto: Schema.Number },
    success: RpcSchema.Stream(Schema.Number, Schema.Never),
  }),
) {}

/**
 * Surface served by the {@link RpcWorker} — local + DO-proxied.
 */
export const WorkerRpcs = InnerRpcs.merge(DoRpcs);
