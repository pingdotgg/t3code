import * as Schema from "effect/Schema";
import { Response, Toolkit } from "effect/unstable/ai";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

// `effect/ai` ships a `Schema` for every streaming response part.
// `Response.StreamPart(toolkit)` builds the union codec; with the empty
// toolkit it's exactly what `Chat.streamText` emits for a tool-less
// chat (text-start / text-delta / text-end / reasoning / finish /
// error). Reusing it as the RPC stream element means both ends decode
// to real `effect/ai` part instances instead of hand-rolled structs.
export const ChatStreamPart = Response.StreamPart(Toolkit.empty);

export const SendResult = Schema.Struct({
  text: Schema.String,
  turns: Schema.Number,
});

// Served on each Durable Object instance. The DO instance *is* the
// conversation thread, so payloads carry no id — keying happens at
// `getByName(threadId)`.
export class ChatBackendRpcs extends RpcGroup.make(
  Rpc.make("send", {
    payload: { prompt: Schema.String },
    success: SendResult,
  }),
  Rpc.make("streamMessage", {
    payload: { prompt: Schema.String },
    success: RpcSchema.Stream(ChatStreamPart, Schema.Never),
  }),
) {}

// Served on the public `RpcWorker`. It fans out to a DO instance by
// thread id, so every payload carries the id.
export class ChatRpcs extends RpcGroup.make(
  Rpc.make("send", {
    payload: { id: Schema.String, prompt: Schema.String },
    success: SendResult,
  }),
  Rpc.make("streamMessage", {
    payload: { id: Schema.String, prompt: Schema.String },
    success: RpcSchema.Stream(ChatStreamPart, Schema.Never),
  }),
) {}
