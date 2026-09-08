import * as AWS from "alchemy/AWS";
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

// Amazon Nova Micro through the us cross-region inference profile — cheap
// and fast. Any conversational Bedrock model works here (Claude, Llama,
// Mistral, ...); enable it under "Model access" in the Bedrock console.
const MODEL = "us.amazon.nova-micro-v1:0";

const GetWeather = Tool.make("get_weather", {
  description: "Get the current weather for a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({
    city: Schema.String,
    temperatureF: Schema.Number,
    condition: Schema.String,
  }),
});

const WeatherToolkit = Toolkit.make(GetWeather);

const WeatherToolkitLayer = WeatherToolkit.toLayer({
  get_weather: ({ city }) =>
    Effect.succeed({ city, temperatureF: 72, condition: "sunny" }),
});

export default class ChatFunction extends AWS.Lambda.Function<ChatFunction>()(
  "ChatFunction",
  {
    main: import.meta.url,
    functionUrl: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // Init: bind the model. This grants the Function `bedrock:InvokeModel`
    // and `bedrock:InvokeModelWithResponseStream` scoped to exactly MODEL
    // and returns an Effect AI `LanguageModel` Layer.
    const model = yield* AWS.Bedrock.LanguageModel(MODEL, {
      parameters: { maxTokens: 1024, temperature: 0.7 },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const prompt = url.searchParams.get("prompt") ?? "Say hello.";

        // GET /stream?prompt=... — stream the answer as SSE parts.
        if (url.pathname === "/stream") {
          const parts = yield* Stream.runCollect(
            AiLanguageModel.streamText({ prompt }),
          );
          const sse = [...parts]
            .map((part) => `data: ${JSON.stringify(part)}\n\n`)
            .join("");
          return HttpServerResponse.text(sse, {
            headers: { "content-type": "text/event-stream" },
          });
        }

        // GET /weather?prompt=... — let the model call a typed tool.
        if (url.pathname === "/weather") {
          const response = yield* AiLanguageModel.generateText({
            prompt,
            toolkit: WeatherToolkit,
          }).pipe(Effect.provide(WeatherToolkitLayer));
          return yield* HttpServerResponse.json({
            text: response.text,
            toolCalls: response.toolCalls.map((call) => ({
              name: call.name,
              params: call.params,
            })),
            toolResults: response.toolResults.map((result) => ({
              name: result.name,
              result: result.result,
            })),
          });
        }

        // GET /?prompt=...&temperature=0.2&maxTokens=64 — single-shot text
        // generation. IAM access to the model is bound at deploy time, but
        // inference parameters are a per-request decision:
        // `withModelParameters` overrides the binding's defaults for just
        // this call.
        const maxTokens = url.searchParams.get("maxTokens");
        const temperature = url.searchParams.get("temperature");
        const response = yield* AiLanguageModel.generateText({ prompt }).pipe(
          AWS.Bedrock.withModelParameters({
            ...(maxTokens !== null ? { maxTokens: Number(maxTokens) } : {}),
            ...(temperature !== null
              ? { temperature: Number(temperature) }
              : {}),
          }),
        );
        return yield* HttpServerResponse.json({
          text: response.text,
          finishReason: response.finishReason,
          usage: {
            inputTokens: response.usage.inputTokens.total,
            outputTokens: response.usage.outputTokens.total,
          },
        });
      }).pipe(
        Effect.catchTag("AiError", (error) =>
          HttpServerResponse.json({ error: error.message }, { status: 500 }),
        ),
        Effect.provide(model),
        Effect.orDie,
      ),
    };
  }).pipe(Effect.provide(AWS.Bedrock.LanguageModelHttp)),
) {}
