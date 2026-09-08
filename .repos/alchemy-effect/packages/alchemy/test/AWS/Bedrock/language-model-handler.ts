import * as Bedrock from "@/AWS/Bedrock";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  LanguageModel as AiLanguageModel,
  Tool,
  Toolkit,
} from "effect/unstable/ai";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "language-model-handler.ts");

// Nova Micro via the us cross-region inference profile: the cheapest
// on-demand conversational model in the testing account, with full
// Converse tool-use + streaming support.
const MODEL = "us.amazon.nova-micro-v1:0";
// A second bound model to exercise the per-call `modelId` override.
const LITE_MODEL = "us.amazon.nova-lite-v1:0";

const GetWeather = Tool.make("get_weather", {
  description:
    "Get the current weather for a city. Always call this tool when the user asks about the weather.",
  parameters: Schema.Struct({
    city: Schema.String,
  }),
  success: Schema.Struct({
    city: Schema.String,
    temperatureF: Schema.Number,
    condition: Schema.String,
  }),
});

const WeatherToolkit = Toolkit.make(GetWeather);

const WeatherToolkitLayer = WeatherToolkit.toLayer({
  get_weather: ({ city }) =>
    Effect.succeed({
      city,
      temperatureF: 72,
      condition: "sunny",
    }),
});

const toSse = (parts: Iterable<unknown>): string =>
  [...parts].map((part) => `data: ${JSON.stringify(part)}\n\n`).join("");

export class BedrockLanguageModelFunction extends Lambda.Function<Lambda.Function>()(
  "BedrockLanguageModelFunction",
) {}

export default BedrockLanguageModelFunction.make(
  {
    main,
    functionUrl: true,
    // Model inference regularly exceeds Lambda's 3s default timeout.
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const model = yield* Bedrock.LanguageModel([MODEL, LITE_MODEL], {
      parameters: { maxTokens: 1024, temperature: 0.2 },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const prompt =
          url.searchParams.get("prompt") ??
          "Say the single word 'pong' and nothing else.";

        // Cheap readiness route — no Bedrock call.
        if (pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (pathname === "/generate") {
          const response = yield* AiLanguageModel.generateText({ prompt });
          return yield* HttpServerResponse.json({
            text: response.text,
            finishReason: response.finishReason,
            usage: {
              inputTokens: response.usage.inputTokens.total,
              outputTokens: response.usage.outputTokens.total,
            },
          });
        }

        if (pathname === "/generate-short") {
          // Runtime override: clamp the same bound model to a tiny budget.
          const response = yield* AiLanguageModel.generateText({
            prompt,
          }).pipe(
            Bedrock.withModelParameters({ maxTokens: 8, temperature: 0 }),
          );
          return yield* HttpServerResponse.json({
            text: response.text,
            finishReason: response.finishReason,
            outputTokens: response.usage.outputTokens.total,
          });
        }

        if (pathname === "/generate-lite") {
          // Runtime override: route this call to the second bound model.
          const response = yield* AiLanguageModel.generateText({
            prompt,
          }).pipe(Bedrock.withModelParameters({ modelId: LITE_MODEL }));
          return yield* HttpServerResponse.json({
            text: response.text,
            finishReason: response.finishReason,
          });
        }

        if (pathname === "/stream") {
          // Collected server-side: Lambda function URLs buffer responses by
          // default, and the tests assert on the part sequence, not
          // incremental delivery.
          const parts = yield* Stream.runCollect(
            AiLanguageModel.streamText({ prompt }),
          );
          return HttpServerResponse.text(toSse(parts), {
            headers: { "content-type": "text/event-stream" },
          });
        }

        if (pathname === "/tool") {
          const response = yield* AiLanguageModel.generateText({
            prompt,
            toolkit: WeatherToolkit,
            toolChoice: "required",
          }).pipe(Effect.provide(WeatherToolkitLayer));
          return yield* HttpServerResponse.json({
            text: response.text,
            finishReason: response.finishReason,
            toolCalls: response.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              params: call.params,
            })),
            toolResults: response.toolResults.map((result) => ({
              id: result.id,
              name: result.name,
              result: result.result,
              isFailure: result.isFailure,
            })),
          });
        }

        if (pathname === "/tool-stream") {
          const parts = yield* Stream.runCollect(
            AiLanguageModel.streamText({
              prompt,
              toolkit: WeatherToolkit,
              toolChoice: "required",
            }).pipe(Stream.provide(WeatherToolkitLayer)),
          );
          return HttpServerResponse.text(toSse(parts), {
            headers: { "content-type": "text/event-stream" },
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface adapter/model failures as a JSON 500 so live-test runs can
        // read the failure without digging through CloudWatch.
        Effect.catchTag("AiError", (error) =>
          HttpServerResponse.json(
            { error: String(error.message) },
            { status: 500 },
          ),
        ),
        Effect.provide(model),
        Effect.orDie,
      ),
    };
  }).pipe(Effect.provide(Bedrock.LanguageModelHttp)),
);
