import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Chat } from "effect/unstable/ai";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { ChatBackendRpcs } from "./ChatRpcs.ts";
import { Gateway } from "./Gateway.ts";

// One DurableObject instance == one conversation thread. The chat
// history lives in the DO's `state.storage` via
// `DurableObjectChatPersistence`. Unlike the method-bridge DO, this one
// serves a typed Effect `RpcGroup` on its own `fetch`, so the streaming
// procedure can hand back real `effect/ai` `Response.StreamPart`
// instances (the built-in bridge would `JSON.stringify` them and strip
// the `Schema.Class` identity).
export default class ChatBackendRpc extends Cloudflare.RpcDurableObject<ChatBackendRpc>()(
  "ChatBackendRpc",
  { schema: ChatBackendRpcs },
  Effect.gen(function* () {
    // Outer init: bind the AI Gateway and build the LanguageModel layer
    // once — shared across every instance hosted by this Worker.
    const aiGateway = yield* Cloudflare.AI.QueryGateway(Gateway);
    const languageModel = aiGateway.model({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      parameters: {
        temperature: 0.2,
        maxTokens: 512,
      },
    });

    return Effect.gen(function* () {
      // Per-instance: chat persistence backed by this DO's storage.
      const persistence = yield* Chat.makePersisted({
        storeId: "alchemy.chat",
      }).pipe(Effect.provide(Cloudflare.AI.DurableObjectChatPersistence));

      const handlers = ChatBackendRpcs.toLayer({
        send: ({ prompt }) =>
          Effect.gen(function* () {
            const chat = yield* persistence.getOrCreate("thread");
            const response = yield* chat.generateText({ prompt });
            const history = yield* Ref.get(chat.history);
            return { text: response.text, turns: history.content.length };
          }).pipe(Effect.provide(languageModel), Effect.orDie),
        streamMessage: ({ prompt }) =>
          persistence.getOrCreate("thread").pipe(
            // `streamText` on a persisted chat saves the appended turn
            // back to `state.storage` when the stream finalizes.
            Effect.map((chat) =>
              chat.streamText({ prompt }).pipe(Stream.provide(languageModel)),
            ),
            Stream.unwrap,
            Stream.orDie,
          ),
      });

      return RpcServer.toHttpEffect(ChatBackendRpcs).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
      );
    });
  }).pipe(Effect.provide(Cloudflare.AI.QueryGatewayBinding)),
) {}
