import { Rpc, RpcGroup } from "effect/rpc";
import * as Schema from "effect/Schema";

export class Greeting extends Schema.Class<Greeting>("Greeting")({
  message: Schema.String,
}) {}

export class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  message: Schema.String,
}) {}

export const SocketStats = Schema.Struct({
  boots: Schema.Number,
  count: Schema.Number,
  opened: Schema.Array(Schema.String),
  closed: Schema.Array(Schema.String),
  invocations: Schema.Record(Schema.String, Schema.Number),
  cleanupStarted: Schema.Array(Schema.String),
  cleanupCompleted: Schema.Record(Schema.String, Schema.Number),
});

export class SocketRpcs extends RpcGroup.make(
  Rpc.make("greet", { payload: { name: Schema.String }, success: Greeting }),
  Rpc.make("increment", { success: Schema.Number }),
  Rpc.make("reject", { success: Schema.Never, error: Rejected }),
  Rpc.make("numbers", {
    payload: { count: Schema.Number },
    success: Schema.Number,
    stream: true,
  }),
  Rpc.make("watch", {
    payload: { key: Schema.String },
    success: Schema.Number,
    stream: true,
  }),
  Rpc.make("cleanup", {
    payload: { key: Schema.String, waitForDisconnect: Schema.Boolean },
    success: Schema.Number,
  }),
  Rpc.make("releaseCleanup", {
    payload: { key: Schema.String },
    success: Schema.Boolean,
  }),
  Rpc.make("invalidateSocketSerialization", { success: Schema.Number }),
  Rpc.make("abort", { success: Schema.Void }),
  Rpc.make("stats", { success: SocketStats }),
) {}
