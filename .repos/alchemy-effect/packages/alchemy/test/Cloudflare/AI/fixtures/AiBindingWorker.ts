import * as Cloudflare from "@/Cloudflare/index.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { LanguageModel as AiLanguageModel } from "effect/unstable/ai";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// `@cf/meta/llama-3.1-8b-instruct` was deprecated by Cloudflare on
// 2026-05-30 (the API answers 410), so use the supported fast 3.3 model.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export default class AiBindingTestWorker extends Cloudflare.Worker<AiBindingTestWorker>()(
  "AiBindingTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const ai = yield* Cloudflare.Workers.AI();

    const languageModel = ai.model({
      model: MODEL,
      parameters: { temperature: 0.7, maxTokens: 1024 },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const ctx = yield* Effect.context<RuntimeContext>();
        const url = new URL(request.url, "http://worker");
        const prompt =
          url.searchParams.get("prompt") ??
          "Say the single word 'pong' and nothing else.";

        if (url.pathname === "/run") {
          // Raw `ai.run` against the binding — no gateway involved.
          const result = yield* ai
            .run(MODEL, {
              messages: [{ role: "user", content: prompt }],
              max_tokens: 128,
            })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/models") {
          const models = yield* ai
            .models({ search: "llama-3.3" })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            count: models.length,
            names: models.map((m) => m.name),
          });
        }

        if (url.pathname === "/generate") {
          const response = yield* AiLanguageModel.generateText({ prompt }).pipe(
            Effect.orDie,
          );
          return yield* HttpServerResponse.json({
            text: response.text,
            finishReason: response.finishReason,
            usage: {
              inputTokens: response.usage.inputTokens.total,
              outputTokens: response.usage.outputTokens.total,
            },
          });
        }

        if (url.pathname === "/stream") {
          const encoder = new TextEncoder();
          const body = AiLanguageModel.streamText({ prompt }).pipe(
            Stream.map((part) =>
              encoder.encode(`data: ${JSON.stringify(part)}\n\n`),
            ),
            Stream.provide(languageModel),
            Stream.provideContext(ctx),
          );
          return HttpServerResponse.stream(body, {
            headers: { "content-type": "text/event-stream" },
          });
        }

        return HttpServerResponse.text("ok");
      }).pipe(Effect.provide(languageModel)),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.AIBinding)),
) {}
