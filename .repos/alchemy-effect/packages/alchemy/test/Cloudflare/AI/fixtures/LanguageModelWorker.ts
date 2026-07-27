import * as Cloudflare from "@/Cloudflare/index.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
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
import { Gateway } from "./Gateway.ts";

// `@cf/meta/llama-3.1-8b-instruct` was deprecated by Cloudflare on
// 2026-05-30 (the API answers 410), so use the supported fast 3.3 model.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// Tool tests need a model that reliably honors `tool_choice: "required"`.
// The previous choice (`@cf/moonshotai/kimi-k2.6`) is a reasoning model
// that intermittently emitted reasoning/text and *no* tool call, flaking
// the tool assertions. Llama 3.3 70B is non-reasoning and reliably returns
// an OpenAI-shaped `tool_calls` array under `tool_choice: "required"`.
const TOOL_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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

export default class LanguageModelTestWorker extends Cloudflare.Worker<LanguageModelTestWorker>()(
  "LanguageModelTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const aiGateway = yield* Cloudflare.AI.QueryGateway(Gateway);

    const languageModel = aiGateway.model({
      model: MODEL,
      parameters: { temperature: 0.7, maxTokens: 1024 },
    });
    const toolLanguageModel = aiGateway.model({
      model: TOOL_MODEL,
      parameters: { temperature: 0.2, maxTokens: 1024 },
    });
    const dumpRawStream = (
      model: string,
      messages: ReadonlyArray<{ role: string; content: string }>,
      streamOptions: Record<string, unknown> | undefined,
    ) =>
      Effect.gen(function* () {
        const ai = yield* aiGateway.raw;
        const gatewayId = yield* aiGateway.id;
        const response = yield* Effect.tryPromise({
          try: () =>
            ai.run(
              model as keyof AiModels,
              {
                messages,
                stream: true,
                ...streamOptions,
              } as unknown as AiModels[keyof AiModels]["inputs"],
              { gateway: { id: gatewayId }, returnRawResponse: true },
            ),
          catch: (e) => e,
        });
        if (response.body == null)
          return HttpServerResponse.text("no body", { status: 500 });
        const body = Stream.fromReadableStream<Uint8Array, never>({
          evaluate: () => response.body!,
          onError: () => undefined as never,
        });
        return HttpServerResponse.stream(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }).pipe(Effect.orDie);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const ctx = yield* Effect.context<RuntimeContext>();
        const url = new URL(request.url, "http://worker");
        const prompt =
          url.searchParams.get("prompt") ??
          "Say the single word 'pong' and nothing else.";

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

        if (url.pathname === "/raw-stream") {
          const model = url.searchParams.get("model") ?? MODEL;
          const includeUsage = url.searchParams.get("include_usage") === "1";
          return yield* dumpRawStream(
            model,
            [{ role: "user", content: prompt }],
            includeUsage
              ? { stream_options: { include_usage: true } }
              : undefined,
          );
        }

        if (url.pathname === "/raw-tool-stream") {
          // Dump the raw Workers AI SSE for a streamed tool call so we can
          // see exactly how the model encodes tool_calls in the stream.
          return yield* dumpRawStream(
            TOOL_MODEL,
            [{ role: "user", content: prompt }],
            {
              tools: [
                {
                  type: "function",
                  function: {
                    name: "get_weather",
                    description: "Get the current weather for a city.",
                    parameters: {
                      type: "object",
                      properties: { city: { type: "string" } },
                      required: ["city"],
                    },
                  },
                },
              ],
              tool_choice: "required",
            },
          );
        }

        if (url.pathname === "/test-stream") {
          // Synthetic stream: 5 chunks with 200ms gaps. If the client sees
          // them at staggered timestamps, worker→edge streaming works.
          // If they all land at once, output is buffered downstream.
          const encoder = new TextEncoder();
          const body = Stream.range(0, 5).pipe(
            Stream.mapEffect((i) =>
              Effect.sleep(Duration.millis(200)).pipe(
                Effect.as(encoder.encode(`data: chunk-${i}\n\n`)),
              ),
            ),
          );
          return HttpServerResponse.stream(body, {
            headers: { "content-type": "text/event-stream" },
          });
        }

        if (url.pathname === "/tool") {
          const response = yield* AiLanguageModel.generateText({
            prompt,
            toolkit: WeatherToolkit,
            toolChoice: "required",
          }).pipe(
            Effect.provide(WeatherToolkitLayer),
            Effect.provide(toolLanguageModel),
            Effect.orDie,
          );
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

        if (url.pathname === "/tool-stream") {
          const encoder = new TextEncoder();
          const body = AiLanguageModel.streamText({
            prompt,
            toolkit: WeatherToolkit,
            toolChoice: "required",
          }).pipe(
            Stream.map((part) =>
              encoder.encode(`data: ${JSON.stringify(part)}\n\n`),
            ),
            Stream.provide(WeatherToolkitLayer),
            Stream.provide(toolLanguageModel),
            Stream.provideContext(ctx),
          );
          return HttpServerResponse.stream(body, {
            headers: { "content-type": "text/event-stream" },
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
  }).pipe(Effect.provide(Cloudflare.AI.QueryGatewayBinding)),
) {}
