/**
 * The `OpenRouterClient` module provides an Effect service for calling
 * OpenRouter's chat completions API. It wraps the generated OpenRouter HTTP
 * client with Effect-native constructors, layers, typed errors, and streaming
 * support.
 *
 * **Common tasks**
 *
 * - Build a client from explicit options with {@link make}
 * - Provide the client to an application with {@link layer} or {@link layerConfig}
 * - Create non-streaming chat completions with {@link Service.createChatCompletion}
 * - Create server-sent event chat completion streams with
 *   {@link Service.createChatCompletionStream}
 * - Customize authentication, base URL, OpenRouter ranking headers, or the
 *   underlying HTTP client through {@link Options}
 *
 * **Gotchas**
 *
 * - Streaming requests are sent directly to `/chat/completions` with `stream`
 *   and `stream_options.include_usage` enabled by this module.
 * - OpenRouter API failures, HTTP client failures, and schema decoding failures
 *   are mapped into `AiError` values for the exported service methods.
 *
 * @since 4.0.0
 */
import type * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/unstable/ai/AiError"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as Generated from "./Generated.ts"
import * as Errors from "./internal/errors.ts"
import { OpenRouterConfig } from "./OpenRouterConfig.ts"

// =============================================================================
// Service Interface
// =============================================================================

/**
 * The OpenRouter client service interface.
 *
 * **Details**
 *
 * Provides methods for interacting with OpenRouter's Chat Completions API,
 * including both synchronous and streaming message creation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  readonly client: Generated.OpenRouterClient

  readonly createChatCompletion: (
    options: typeof Generated.ChatGenerationParams.Encoded
  ) => Effect.Effect<
    [body: typeof Generated.SendChatCompletionRequest200.Type, response: HttpClientResponse.HttpClientResponse],
    AiError.AiError
  >

  readonly createChatCompletionStream: (
    options: Omit<typeof Generated.ChatGenerationParams.Encoded, "stream" | "stream_options">
  ) => Effect.Effect<
    [
      response: HttpClientResponse.HttpClientResponse,
      stream: Stream.Stream<ChatStreamingResponseChunkData, AiError.AiError>
    ],
    AiError.AiError
  >
}

/**
 * Decoded `data` payload from an OpenRouter chat completion streaming chunk.
 *
 * **Details**
 *
 * The payload contains streamed choices, model metadata, optional usage, and may
 * include an OpenRouter error object for a streamed response.
 *
 * @category models
 * @since 4.0.0
 */
export type ChatStreamingResponseChunkData = typeof Generated.ChatStreamingResponseChunk.fields.data.Type

// =============================================================================
// Service Identifier
// =============================================================================

/**
 * Service tag for the OpenRouter client.
 *
 * **When to use**
 *
 * Use when accessing or providing the OpenRouter client service through
 * Effect's context.
 *
 * @see {@link make} for constructing an OpenRouter client effectfully
 * @see {@link layer} for providing a client from explicit options
 * @see {@link layerConfig} for providing a client from `Config`
 *
 * @category services
 * @since 4.0.0
 */
export class OpenRouterClient extends Context.Service<
  OpenRouterClient,
  Service
>()("@effect/ai-openrouter/OpenRouterClient") {}

// =============================================================================
// Options
// =============================================================================

/**
 * Configuration for creating an OpenRouter client.
 *
 * @category models
 * @since 4.0.0
 */
export type Options = {
  readonly apiKey?: Redacted.Redacted<string> | undefined

  readonly apiUrl?: string | undefined

  /**
   * Optional URL of your site for rankings on `openrouter.ai`.
   */
  readonly siteReferrer?: string | undefined

  /**
   * Optional title of your site for rankings on `openrouter.ai`.
   */
  readonly siteTitle?: string | undefined

  /**
   * Optional transformer for the underlying HTTP client.
   *
   * **When to use**
   *
   * Use to add middleware, logging, or custom request/response handling.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

// =============================================================================
// Constructor
// =============================================================================

/**
 * Creates an OpenRouter client service from explicit options.
 *
 * **When to use**
 *
 * Use to construct the OpenRouter client service inside an effect when you need
 * the service value directly.
 *
 * **Details**
 *
 * The returned service uses the current `HttpClient`, prepends `apiUrl` or
 * `https://openrouter.ai/api/v1`, adds the bearer token and optional
 * `HTTP-Referer` and `X-Title` headers, accepts JSON responses, and applies
 * `transformClient` when provided.
 *
 * **Gotchas**
 *
 * Scoped `OpenRouterConfig.withClientTransform` applies to generated client
 * request methods. Streaming chat completion requests are sent directly by this
 * module and do not read that scoped transform.
 *
 * @see {@link layer} for providing this client from explicit options
 * @see {@link layerConfig} for loading client settings from `Config`
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(
  function*(options: Options): Effect.fn.Return<Service, never, HttpClient.HttpClient> {
    const baseClient = yield* HttpClient.HttpClient

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(options.apiUrl ?? "https://openrouter.ai/api/v1"),
          options.apiKey ? HttpClientRequest.bearerToken(options.apiKey) : identity,
          options.siteReferrer ? HttpClientRequest.setHeader("HTTP-Referer", options.siteReferrer) : identity,
          options.siteTitle ? HttpClientRequest.setHeader("X-Title", options.siteTitle) : identity,
          HttpClientRequest.acceptJson
        )
      ),
      options.transformClient ?? identity
    )

    const httpClientOk = HttpClient.filterStatusOk(httpClient)

    const client = Generated.make(httpClient, {
      transformClient: Effect.fnUntraced(function*(client) {
        const config = yield* OpenRouterConfig.getOrUndefined
        if (Predicate.isNotUndefined(config?.transformClient)) {
          return config.transformClient(client)
        }
        return client
      })
    })

    const createChatCompletion: Service["createChatCompletion"] = (payload) =>
      client.sendChatCompletionRequest({ payload, config: { includeResponse: true } }).pipe(
        Effect.catchTags({
          SendChatCompletionRequest400: (error) => Effect.fail(Errors.mapClientError(error, "createChatCompletion")),
          SendChatCompletionRequest401: (error) => Effect.fail(Errors.mapClientError(error, "createChatCompletion")),
          SendChatCompletionRequest429: (error) => Effect.fail(Errors.mapClientError(error, "createChatCompletion")),
          SendChatCompletionRequest500: (error) => Effect.fail(Errors.mapClientError(error, "createChatCompletion")),
          HttpClientError: (error) => Errors.mapHttpClientError(error, "createChatCompletion"),
          SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createChatCompletion"))
        })
      )

    const buildChatCompletionStream = (
      response: HttpClientResponse.HttpClientResponse
    ): [
      HttpClientResponse.HttpClientResponse,
      Stream.Stream<ChatStreamingResponseChunkData, AiError.AiError>
    ] => {
      const stream = response.stream.pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapEffect((event) => decodeChatCompletionSseData(event.data)),
        Stream.takeWhile((data) => data !== "[DONE]"),
        Stream.catchTags({
          // TODO: handle SSE retries
          Retry: (error) => Stream.die(error),
          HttpClientError: (error) => Stream.fromEffect(Errors.mapHttpClientError(error, "createChatCompletionStream")),
          SchemaError: (error) => Stream.fail(Errors.mapSchemaError(error, "createChatCompletionStream"))
        })
      ) as any
      return [response, stream]
    }

    const createChatCompletionStream: Service["createChatCompletionStream"] = (payload) =>
      httpClientOk.execute(
        HttpClientRequest.post("/chat/completions", {
          body: HttpBody.jsonUnsafe({
            ...payload,
            stream: true,
            stream_options: { include_usage: true }
          })
        })
      ).pipe(
        Effect.map(buildChatCompletionStream),
        Effect.catchTag(
          "HttpClientError",
          (error) => Errors.mapHttpClientError(error, "createChatCompletionStream")
        )
      )

    return OpenRouterClient.of({
      client,
      createChatCompletion,
      createChatCompletionStream
    })
  }
)

// =============================================================================
// Layers
// =============================================================================

/**
 * Creates a layer for the OpenRouter client with the given options.
 *
 * **When to use**
 *
 * Use when you already have the OpenRouter client options in code and want to
 * provide `OpenRouterClient` as a layer.
 *
 * @see {@link make} for constructing the client service effectfully
 * @see {@link layerConfig} for loading client settings from `Config`
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: Options): Layer.Layer<OpenRouterClient, never, HttpClient.HttpClient> =>
  Layer.effect(OpenRouterClient, make(options))

/**
 * Creates a layer for the OpenRouter client from provided `Config` values.
 *
 * **When to use**
 *
 * Use when OpenRouter client settings should be read from Effect `Config`
 * values while providing `OpenRouterClient` as a layer.
 *
 * **Details**
 *
 * Only config values supplied in `options` are loaded. Omitted fields are
 * passed to `make` as `undefined`, and `transformClient` is forwarded as a
 * plain option.
 *
 * @see {@link make} for constructing the client service effectfully
 * @see {@link layer} for providing the client from already-resolved options
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (options?: {
  /**
   * The config value to load for the API key.
   */
  readonly apiKey?: Config.Config<Redacted.Redacted<string> | undefined> | undefined

  /**
   * The config value to load for the API URL.
   */
  readonly apiUrl?: Config.Config<string> | undefined

  /**
   * The config value to load for the site referrer URL.
   */
  readonly siteReferrer?: Config.Config<string> | undefined

  /**
   * The config value to load for the site title.
   */
  readonly siteTitle?: Config.Config<string> | undefined

  /**
   * Optional transformer for the HTTP client.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}): Layer.Layer<OpenRouterClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    OpenRouterClient,
    Effect.gen(function*() {
      const apiKey = Predicate.isNotUndefined(options?.apiKey)
        ? yield* options.apiKey
        : undefined
      const apiUrl = Predicate.isNotUndefined(options?.apiUrl)
        ? yield* options.apiUrl
        : undefined
      const siteReferrer = Predicate.isNotUndefined(options?.siteReferrer)
        ? yield* options.siteReferrer
        : undefined
      const siteTitle = Predicate.isNotUndefined(options?.siteTitle)
        ? yield* options.siteTitle
        : undefined
      return yield* make({
        apiKey,
        apiUrl,
        siteReferrer,
        siteTitle,
        transformClient: options?.transformClient
      })
    })
  )

// =============================================================================
// Internal Utilities
// =============================================================================

const ChatStreamingResponseChunkDataFromString = Schema.fromJsonString(Generated.ChatStreamingResponseChunk.fields.data)
const decodeChatStreamingResponseChunkData = Schema.decodeUnknownEffect(ChatStreamingResponseChunkDataFromString)

const decodeChatCompletionSseData = (
  data: string
): Effect.Effect<ChatStreamingResponseChunkData | "[DONE]", Schema.SchemaError> =>
  data === "[DONE]"
    ? Effect.succeed(data)
    : decodeChatStreamingResponseChunkData(data)
