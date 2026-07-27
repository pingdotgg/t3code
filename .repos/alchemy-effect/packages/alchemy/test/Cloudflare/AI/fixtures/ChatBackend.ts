import * as Cloudflare from "@/Cloudflare";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Chat } from "effect/unstable/ai";
import { Gateway } from "./Gateway.ts";

// One DurableObject instance == one conversation thread. The thread's
// history lives in the DO's `state.storage` via
// `DurableObjectChatPersistence`, so it survives hibernation and DO
// eviction. The Worker routes `/chat?id=<thread>` to the matching DO
// instance by name.
export default class ChatBackend extends Cloudflare.DurableObject<ChatBackend>()(
  "ChatBackend",
  Effect.gen(function* () {
    // Init phase: bind the AI Gateway and build the LanguageModel layer.
    const aiGateway = yield* Cloudflare.AI.QueryGateway(Gateway);
    const languageModel = aiGateway.model({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      parameters: { temperature: 0.2, maxTokens: 512 },
    });

    return Effect.gen(function* () {
      // Per-instance: a chat persistence service backed by this DO's
      // storage. `Chat.makePersisted` needs `BackingPersistence`, which
      // `DurableObjectChatPersistence` provides from `DurableObjectState`
      // (in scope here).
      const persistence = yield* Chat.makePersisted({
        storeId: "alchemy.chat",
      }).pipe(Effect.provide(Cloudflare.AI.DurableObjectChatPersistence));

      return {
        send: (threadId: string, prompt: string) =>
          Effect.gen(function* () {
            const chat = yield* persistence.getOrCreate(threadId);
            const response = yield* chat.generateText({ prompt });
            const history = yield* Ref.get(chat.history);
            return {
              text: response.text,
              turns: history.content.length,
            };
          }).pipe(Effect.provide(languageModel), Effect.orDie),
      };
    });
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.AI.QueryGatewayBinding))),
) {}
