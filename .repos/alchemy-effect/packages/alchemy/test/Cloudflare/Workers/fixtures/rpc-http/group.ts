import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

/**
 * RPCs implemented locally in both the Worker and the Durable Object.
 *
 * - `Ping` — unary
 * - `Count` — streaming response
 * - `Echo` — array payload (a "stream" of inputs in one HTTP body) that
 *   replays each item back as a streaming response
 */
export const InnerRpcs = RpcGroup.make(
  Rpc.make("Ping", {
    payload: { message: Schema.String },
    success: Schema.Struct({ echo: Schema.String, n: Schema.Number }),
  }),
  Rpc.make("Count", {
    payload: { upto: Schema.Number },
    success: RpcSchema.Stream(Schema.Number, Schema.Never),
  }),
  Rpc.make("Echo", {
    payload: { messages: Schema.Array(Schema.String) },
    success: RpcSchema.Stream(
      Schema.Struct({ index: Schema.Number, message: Schema.String }),
      Schema.Never,
    ),
  }),
);

/**
 * RPCs exposed only by the Worker. Each handler proxies the corresponding
 * `InnerRpcs` method through an `RpcClient` whose transport is backed by
 * `Cloudflare.toHttpClient(rpcDO.getByName(...))`. This exercises the DO
 * fetch pathway (`DurableObjectBridge.fetch` -> `makeRequestEffect`) via
 * the typed RPC client, mirroring the `*DO` variants in the HttpApi
 * fixture.
 */
export const DoRpcs = RpcGroup.make(
  Rpc.make("PingDO", {
    payload: { message: Schema.String },
    success: Schema.Struct({ echo: Schema.String, n: Schema.Number }),
  }),
  Rpc.make("CountDO", {
    payload: { upto: Schema.Number },
    success: RpcSchema.Stream(Schema.Number, Schema.Never),
  }),
  Rpc.make("EchoDO", {
    payload: { messages: Schema.Array(Schema.String) },
    success: RpcSchema.Stream(
      Schema.Struct({ index: Schema.Number, message: Schema.String }),
      Schema.Never,
    ),
  }),
);

export const WorkerRpcs = InnerRpcs.merge(DoRpcs);
