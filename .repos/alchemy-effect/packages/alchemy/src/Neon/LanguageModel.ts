import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AiError, LanguageModel, Response, Tool } from "effect/ai";
import { toCodecOpenAI } from "effect/ai/OpenAiStructuredOutput";
import * as Sse from "effect/encoding/Sse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { RuntimeContext } from "../RuntimeContext.ts";

/** Runtime-only connection obtained from QueryAIGateway, never an account API key. */
export interface LanguageModelClient {
  /** OpenAI-compatible base URL ending in /v1. */
  readonly chatBaseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** Redacted credential with ai_gateway:invoke scope. */
  readonly token: Effect.Effect<
    Redacted.Redacted<string>,
    never,
    RuntimeContext
  >;
}

/** Configuration for Neon's OpenAI-compatible Chat Completions endpoint. */
export interface LanguageModelOptions {
  /** Model ID from Neon's catalog that supports Chat Completions. */
  readonly model: string;
  /** Model-dependent generation settings, sent without silently rewriting them. */
  readonly parameters?: {
    /** Sampling temperature. */
    readonly temperature?: number;
    /** Maximum output tokens; mutually exclusive with maxCompletionTokens. */
    readonly maxTokens?: number;
    /** Completion budget for models using max_completion_tokens. */
    readonly maxCompletionTokens?: number;
    /** Nucleus sampling probability. */
    readonly topP?: number;
    /** Provider-supported deterministic sampling seed. */
    readonly seed?: number;
    /** Repetition penalty based on token frequency. */
    readonly frequencyPenalty?: number;
    /** Repetition penalty based on token presence. */
    readonly presencePenalty?: number;
  };
}

/**
 * Effect AI over Neon's documented `/v1/chat/completions` route. Supports text,
 * image inputs, function tools, JSON-schema output and cancellable SSE streams.
 * Tool and structured-output support depends on the selected model. Responses-only
 * models (including Codex), native Anthropic thinking/cache controls, audio,
 * provider-executed tools and image generation are not supported by this adapter.
 * Use the bound client's dialect URLs with a native SDK for those APIs.
 *
 * ### Generate text
 * **Example:** A request-scoped Effect model
 * ```typescript
 * const ai = yield* Neon.QueryAIGateway(gateway);
 * const model = ai.model({ model: "gpt-5-mini" });
 * // Inside the Function or Worker request handler:
 * const reply = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
 *   Effect.provide(model),
 * );
 * ```
 *
 * ### Generate structured output
 * **Example:** Decode the response with an Effect Schema
 * ```typescript
 * const reply = yield* LanguageModel.generateObject({
 *   prompt: "Return a short greeting.",
 *   schema: Schema.Struct({ greeting: Schema.String }),
 * }).pipe(Effect.provide(ai.model({ model: "gpt-5-mini" })));
 * ```
 *
 * @layer
 * @provides effect/ai/LanguageModel
 * @product AI Gateway
 * @category AI Gateway
 */
export const makeLanguageModelLayer = (
  options: LanguageModelOptions & { readonly client: LanguageModelClient },
): Layer.Layer<LanguageModel.LanguageModel, never, RuntimeContext> =>
  Layer.effect(LanguageModel.LanguageModel, makeLanguageModel(options)).pipe(
    Layer.provide(FetchHttpClient.layer),
  );

/** Construct with an injected Effect HTTP client for custom transports and protocol tests. */
export const makeLanguageModel = ({
  client,
  model,
  parameters,
}: LanguageModelOptions & {
  readonly client: LanguageModelClient;
}): Effect.Effect<
  LanguageModel.LanguageModel,
  never,
  RuntimeContext | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const baseUrl = yield* client.chatBaseUrl;
    const token = yield* client.token;
    const send = (options: LanguageModel.ProviderOptions, stream: boolean) =>
      Effect.gen(function* () {
        const body = yield* requestBody(options, model, parameters, stream);
        const request = yield* HttpClientRequest.bodyJson(body)(
          HttpClientRequest.post(
            `${baseUrl.replace(/\/$/, "")}/chat/completions`,
          ).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.accept(
              stream ? "text/event-stream" : "application/json",
            ),
          ),
        ).pipe(
          Effect.mapError(() =>
            invalidRequest("Request is not JSON serializable"),
          ),
        );
        const response = yield* http.execute(request).pipe(
          Effect.mapError(() =>
            error(
              new AiError.NetworkError({
                reason: "TransportError",
                request: {
                  method: "POST",
                  url: "/v1/chat/completions",
                  urlParams: [],
                  headers: {},
                },
                description: "Neon AI Gateway transport failed",
              }),
            ),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* httpError(response);
        }
        return response;
      });
    return yield* LanguageModel.make({
      codecTransformer: toCodecOpenAI,
      generateText: (options) =>
        Effect.gen(function* () {
          const response = yield* send(options, false);
          const raw = yield* response.json.pipe(
            Effect.mapError(() => invalidOutput("Expected a JSON completion")),
          );
          const decoded = yield* decode(Completion, raw);
          const choice = decoded.choices[0];
          if (!choice) return yield* invalidOutput("Completion has no choices");
          const parts: Array<Response.PartEncoded> = [];
          const message = choice.message;
          if (message.refusal)
            return yield* error(
              new AiError.ContentPolicyError({
                description: "Model refused the request",
              }),
            );
          if (message.reasoning_content)
            parts.push({ type: "reasoning", text: message.reasoning_content });
          if (typeof message.content === "string") {
            if (message.content)
              parts.push({ type: "text", text: message.content });
          } else if (message.content) {
            for (const block of message.content)
              parts.push({ type: "text", text: block.text });
          }
          for (const call of message.tool_calls ?? []) {
            parts.push({
              type: "tool-call",
              id: call.id,
              name: call.function.name,
              params: yield* parseArguments(call.function.arguments),
            });
          }
          parts.push({
            type: "finish",
            reason: finishReason(choice.finish_reason),
            usage: usage(decoded.usage),
          });
          return parts;
        }),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const response = yield* send(options, true);
            return completionStream(response);
          }),
        ),
    });
  });

const error = (reason: AiError.AiError["reason"]) =>
  AiError.make({
    module: "Neon.LanguageModel",
    method: "chatCompletions",
    reason,
  });
const invalidOutput = (description: string) =>
  error(new AiError.InvalidOutputError({ description }));
const invalidRequest = (description: string) =>
  error(new AiError.InvalidRequestError({ description }));
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() =>
      invalidOutput("Invalid Chat Completions response shape"),
    ),
  );
const parseArguments = (value: string) =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  )(value).pipe(
    Effect.mapError(() =>
      invalidOutput("Invalid function-call JSON arguments"),
    ),
  );

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Usage = Schema.Struct({
  prompt_tokens: Schema.optional(TokenCount),
  completion_tokens: Schema.optional(TokenCount),
  prompt_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ cached_tokens: Schema.optional(TokenCount) }),
    ),
  ),
  completion_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ reasoning_tokens: Schema.optional(TokenCount) }),
    ),
  ),
});
const Content = Schema.NullOr(
  Schema.Union([
    Schema.String,
    Schema.Array(
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    ),
  ]),
);
const Completion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: Schema.NullOr(Schema.String),
      message: Schema.Struct({
        content: Schema.optional(Content),
        reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
        refusal: Schema.optional(Schema.NullOr(Schema.String)),
        tool_calls: Schema.optional(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              type: Schema.Literal("function"),
              function: Schema.Struct({
                name: Schema.String,
                arguments: Schema.String,
              }),
            }),
          ),
        ),
      }),
    }),
  ),
  usage: Schema.optional(Schema.NullOr(Usage)),
});
const Chunk = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      index: TokenCount,
      finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
      delta: Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
        refusal: Schema.optional(Schema.NullOr(Schema.String)),
        tool_calls: Schema.optional(
          Schema.Array(
            Schema.Struct({
              index: TokenCount,
              id: Schema.optional(Schema.String),
              type: Schema.optional(Schema.Literal("function")),
              function: Schema.optional(
                Schema.Struct({
                  name: Schema.optional(Schema.String),
                  arguments: Schema.optional(Schema.String),
                }),
              ),
            }),
          ),
        ),
      }),
    }),
  ),
  usage: Schema.optional(Schema.NullOr(Usage)),
});
const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optional(
      Schema.Union([Schema.String, Schema.Number, Schema.Null]),
    ),
    message: Schema.optional(Schema.String),
  }),
});

const httpError = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, AiError.AiError> =>
  Effect.gen(function* () {
    // Never retain upstream bodies, headers or request objects in public errors.
    const body = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const status = response.status;
    if (
      status === 403 &&
      body?.error.message === "ai gateway not enabled for account"
    )
      return yield* error(new AiError.QuotaExhaustedError({}));
    if (status === 401 || status === 403)
      return yield* error(
        new AiError.AuthenticationError({
          kind: status === 401 ? "InvalidKey" : "InsufficientPermissions",
        }),
      );
    if (
      status === 402 ||
      body?.error.code === "REQUEST_LIMIT_EXCEEDED" ||
      body?.error.code === "insufficient_quota"
    )
      return yield* error(new AiError.QuotaExhaustedError({}));
    if (status === 429) {
      const seconds = Number(response.headers["retry-after"]);
      return yield* error(
        new AiError.RateLimitError({
          ...(Number.isFinite(seconds) && seconds >= 0
            ? { retryAfter: Duration.seconds(seconds) }
            : {}),
        }),
      );
    }
    if (status >= 500)
      return yield* error(
        new AiError.InternalProviderError({
          description: `Neon AI Gateway returned HTTP ${status}`,
        }),
      );
    return yield* invalidRequest(
      `Neon AI Gateway rejected the request (HTTP ${status}); check the model, endpoint and parameters`,
    );
  });

const finishReason = (
  reason: string | null | undefined,
): Response.FinishReason => {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    case null:
    case undefined:
      return "unknown";
    default:
      return "other";
  }
};
const usage = (value: typeof Usage.Type | null | undefined) => {
  const input = value?.prompt_tokens;
  const cached = value?.prompt_tokens_details?.cached_tokens;
  const output = value?.completion_tokens;
  const reasoning = value?.completion_tokens_details?.reasoning_tokens;
  return new Response.Usage({
    inputTokens: {
      total: input,
      uncached:
        input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: output,
      text:
        output === undefined
          ? undefined
          : Math.max(0, output - (reasoning ?? 0)),
      reasoning,
    },
  });
};

const requestBody = (
  options: LanguageModel.ProviderOptions,
  model: string,
  parameters: LanguageModelOptions["parameters"],
  stream: boolean,
) =>
  Effect.gen(function* () {
    if (
      parameters?.maxTokens !== undefined &&
      parameters.maxCompletionTokens !== undefined
    )
      return yield* invalidRequest(
        "Set maxTokens or maxCompletionTokens, not both",
      );
    if (options.tools.some(Tool.isProviderDefined))
      return yield* invalidRequest(
        "Provider-executed tools require a native provider API",
      );
    const messages: Array<Record<string, unknown>> = [];
    for (const message of options.prompt.content) {
      if (message.role === "system") {
        messages.push({ role: "system", content: message.content });
      } else if (message.role === "user") {
        const content: Array<unknown> = [];
        for (const part of message.content) {
          if (part.type === "text")
            content.push({ type: "text", text: part.text });
          else if (
            part.type === "file" &&
            part.mediaType.startsWith("image/")
          ) {
            const url = yield* Effect.sync(() => {
              if (part.data instanceof URL) return part.data.toString();
              if (part.data instanceof Uint8Array) {
                let binary = "";
                for (const byte of part.data)
                  binary += String.fromCharCode(byte);
                return `data:${part.mediaType};base64,${btoa(binary)}`;
              }
              return /^(data:|https?:)/.test(part.data)
                ? part.data
                : `data:${part.mediaType};base64,${part.data}`;
            });
            content.push({ type: "image_url", image_url: { url } });
          } else
            return yield* invalidRequest(
              "Only text and image user inputs are supported",
            );
        }
        messages.push({ role: "user", content });
      } else if (message.role === "assistant") {
        const text: Array<string> = [];
        const toolCalls: Array<unknown> = [];
        for (const part of message.content) {
          if (part.type === "text") text.push(part.text);
          else if (part.type === "tool-call")
            toolCalls.push({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: yield* stringify(part.params),
              },
            });
          else if (part.type !== "reasoning")
            return yield* invalidRequest(
              "Unsupported assistant content for Chat Completions",
            );
        }
        messages.push({
          role: "assistant",
          content: text.join("") || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
      } else {
        for (const part of message.content) {
          if (part.type !== "tool-result")
            return yield* invalidRequest(
              "Unsupported tool message for Chat Completions",
            );
          messages.push({
            role: "tool",
            tool_call_id: part.id,
            content:
              typeof part.result === "string"
                ? part.result
                : yield* stringify(part.result),
          });
        }
      }
    }
    const choice = options.toolChoice;
    const selected =
      typeof choice === "object" && "oneOf" in choice
        ? options.tools.filter((tool) => choice.oneOf.includes(tool.name))
        : options.tools;
    const tools = yield* Effect.try({
      try: () =>
        selected.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: Tool.getDescription(tool),
            parameters: Tool.getJsonSchema(tool),
          },
        })),
      catch: () =>
        invalidRequest("Tool schema cannot be represented as JSON Schema"),
    });
    const responseFormat = options.responseFormat;
    const jsonSchema =
      responseFormat.type === "json"
        ? yield* Effect.try({
            try: () => toCodecOpenAI(responseFormat.schema).jsonSchema,
            catch: () =>
              error(
                new AiError.UnsupportedSchemaError({
                  description:
                    "Schema is not supported by OpenAI structured output",
                }),
              ),
          })
        : undefined;
    return {
      model,
      messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length
        ? {
            tools,
            tool_choice:
              typeof choice === "object"
                ? "tool" in choice
                  ? { type: "function", function: { name: choice.tool } }
                  : (choice.mode ?? "auto")
                : choice,
          }
        : {}),
      ...(jsonSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name:
                  responseFormat.type === "json"
                    ? responseFormat.objectName
                    : "response",
                schema: jsonSchema,
                strict: true,
              },
            },
          }
        : {}),
      temperature: parameters?.temperature,
      max_tokens: parameters?.maxTokens,
      max_completion_tokens: parameters?.maxCompletionTokens,
      top_p: parameters?.topP,
      seed: parameters?.seed,
      frequency_penalty: parameters?.frequencyPenalty,
      presence_penalty: parameters?.presencePenalty,
    };
  });
const stringify = (value: unknown) =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: () => invalidRequest("Prompt contains a non-JSON value"),
  });

const completionStream = (
  response: HttpClientResponse.HttpClientResponse,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.unwrap(
    Effect.sync(() => {
      let done = false;
      let reason: string | undefined;
      let tokenUsage: typeof Usage.Type | null | undefined;
      let textStarted = false;
      let reasoningStarted = false;
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string; started: boolean }
      >();
      const chunks = response.stream.pipe(
        Stream.mapError(() =>
          invalidOutput("Chat Completions stream transport failed"),
        ),
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decode<AiError.AiError, unknown>()),
        Stream.mapError(() =>
          invalidOutput("Invalid or interrupted SSE stream"),
        ),
        Stream.takeUntil((event) => event.data === "[DONE]"),
        Stream.mapEffect((event) =>
          Effect.gen(function* () {
            const parts: Array<Response.StreamPartEncoded> = [];
            if (event.data === "[DONE]") {
              done = true;
              return parts;
            }
            if (!event.data) return parts;
            if (event.event === "error")
              return yield* error(
                new AiError.InternalProviderError({
                  description: "Neon AI Gateway stream reported an error",
                }),
              );
            const chunk = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Chunk),
            )(event.data).pipe(
              Effect.mapError(() =>
                invalidOutput("Invalid Chat Completions stream chunk"),
              ),
            );
            if (chunk.usage != null) tokenUsage = chunk.usage;
            for (const choice of chunk.choices) {
              if (choice.index !== 0) continue;
              if (choice.finish_reason != null) reason = choice.finish_reason;
              const delta = choice.delta;
              if (delta.refusal)
                return yield* error(
                  new AiError.ContentPolicyError({
                    description: "Model refused the request",
                  }),
                );
              if (delta.reasoning_content) {
                if (!reasoningStarted) {
                  reasoningStarted = true;
                  parts.push({ type: "reasoning-start", id: "reasoning" });
                }
                parts.push({
                  type: "reasoning-delta",
                  id: "reasoning",
                  delta: delta.reasoning_content,
                });
              }
              if (delta.content) {
                if (!textStarted) {
                  textStarted = true;
                  parts.push({ type: "text-start", id: "text" });
                }
                parts.push({
                  type: "text-delta",
                  id: "text",
                  delta: delta.content,
                });
              }
              for (const deltaCall of delta.tool_calls ?? []) {
                const call = calls.get(deltaCall.index) ?? {
                  id: "",
                  name: "",
                  arguments: "",
                  started: false,
                };
                if (deltaCall.id) {
                  if (call.id && call.id !== deltaCall.id)
                    return yield* invalidOutput(
                      "Tool call ID changed within a stream",
                    );
                  call.id = deltaCall.id;
                }
                if (deltaCall.function?.name) {
                  if (call.started && call.name !== deltaCall.function.name)
                    return yield* invalidOutput(
                      "Tool name changed within a stream",
                    );
                  call.name = deltaCall.function.name;
                }
                const args = deltaCall.function?.arguments ?? "";
                call.arguments += args;
                if (!call.started && call.id && call.name) {
                  call.started = true;
                  parts.push({
                    type: "tool-params-start",
                    id: call.id,
                    name: call.name,
                  });
                  if (call.arguments)
                    parts.push({
                      type: "tool-params-delta",
                      id: call.id,
                      delta: call.arguments,
                    });
                } else if (call.started && args)
                  parts.push({
                    type: "tool-params-delta",
                    id: call.id,
                    delta: args,
                  });
                calls.set(deltaCall.index, call);
              }
            }
            return parts;
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
      );
      const finish = Stream.unwrap(
        Effect.gen(function* () {
          if (!done || !reason)
            return yield* invalidOutput(
              "Chat Completions stream ended before its finish reason and [DONE]",
            );
          const parts: Array<Response.StreamPartEncoded> = [];
          if (reasoningStarted)
            parts.push({ type: "reasoning-end", id: "reasoning" });
          if (textStarted) parts.push({ type: "text-end", id: "text" });
          for (const call of calls.values()) {
            if (!call.started)
              return yield* invalidOutput("Incomplete streamed tool identity");
            parts.push({ type: "tool-params-end", id: call.id });
            if (reason !== "length" && reason !== "content_filter") {
              parts.push({
                type: "tool-call",
                id: call.id,
                name: call.name,
                params: yield* parseArguments(call.arguments),
              });
            }
          }
          parts.push({
            type: "finish",
            reason: finishReason(reason),
            usage: usage(tokenUsage),
          });
          return Stream.fromIterable(parts);
        }),
      );
      return Stream.concat(chunks, finish);
    }),
  );
