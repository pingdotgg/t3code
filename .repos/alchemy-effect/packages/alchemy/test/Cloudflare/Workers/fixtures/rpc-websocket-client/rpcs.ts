import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

export class BrowserRpcs extends RpcGroup.make(
  Rpc.make("echo", {
    payload: { value: Schema.String },
    success: Schema.String,
    error: Schema.Literal("Rejected"),
  }),
  Rpc.make("numbers", {
    payload: { count: Schema.Number },
    success: Schema.Number,
    stream: true,
  }),
) {}
