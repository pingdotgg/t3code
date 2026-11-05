import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";

/**
 * Procedures served on each {@link RpcDurableObject} instance.
 * The DO instance *is* the session, so payloads don't include a per-
 * session id — the keying happens at `getByName(...)`.
 */
export class CounterRpcs extends RpcGroup.make(
  Rpc.make("Increment", {
    payload: {},
    success: Schema.Struct({ count: Schema.Number }),
  }),
  Rpc.make("Get", {
    payload: {},
    success: Schema.Struct({ count: Schema.Number }),
  }),
  Rpc.make("CountUpTo", {
    payload: { upto: Schema.Number },
    success: RpcSchema.Stream(Schema.Number, Schema.Never),
  }),
  Rpc.make("Reset", {
    payload: {},
    success: Schema.Void,
  }),
) {}
