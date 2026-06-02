/**
 * The `AnthropicClient` module defines the low-level Effect service used to
 * call Anthropic's API. It wraps the generated Anthropic HTTP client with
 * Effect layers, request defaults, authentication headers, API versioning,
 * response decoding, and error mapping for Messages API calls.
 *
 * **Mental model**
 *
 * `HttpClient.HttpClient` provides the transport. {@link make} turns explicit
 * {@link Options} into an {@link AnthropicClient} service, while {@link layer}
 * and {@link layerConfig} provide that service as a layer. The service exposes
 * the generated client for direct endpoint access plus handwritten helpers for
 * regular and streaming message creation.
 *
 * **Common tasks**
 *
 * - Provide an authenticated Anthropic client from an API key and optional base
 *   URL
 * - Load client settings from Effect `Config` with {@link layerConfig}
 * - Apply HTTP client transformations for proxying, retries, instrumentation,
 *   or tests
 * - Decode Anthropic server-sent event streams into typed message events
 *
 * **Gotchas**
 *
 * - `apiKey` is optional so proxied and test clients can provide
 *   authentication elsewhere.
 * - `createMessageStream` filters Anthropic ping events and terminates the
 *   stream when a `message_stop` event is received.
 * - The message helpers map transport, schema, and provider failures to the
 *   unified Effect AI error type.
 *
 * @since 4.0.0
 */
import * as Array from "effect/Array"
import type * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/unstable/ai/AiError"
import * as Sse from "effect/unstable/encoding/Sse"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { AnthropicConfig } from "./AnthropicConfig.ts"
import * as Generated from "./Generated.ts"
import * as Errors from "./internal/errors.ts"

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Represents the Anthropic client service with methods for the Messages API, including regular and streaming message
 * creation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  /**
   * The underlying generated Anthropic client that exposes all API endpoints.
   */
  readonly client: Generated.AnthropicClient

  /**
   * Executes a low-level streaming HTTP request and decodes the Server-Sent Events response using the provided schema.
   */
  readonly streamRequest: <
    Type extends {
      readonly id?: string | undefined
      readonly event: string
      readonly data: string
    },
    DecodingServices
  >(
    schema: Schema.Decoder<Type, DecodingServices>
  ) => (request: HttpClientRequest.HttpClientRequest) => Stream.Stream<
    Type,
    HttpClientError.HttpClientError | Schema.SchemaError | Sse.Retry,
    DecodingServices
  >

  /**
   * Creates a message using the Anthropic Messages API and maps all errors to the unified `AiError` type.
   */
  readonly createMessage: (options: {
    readonly payload: typeof Generated.BetaCreateMessageParams.Encoded
    readonly params?: typeof Generated.BetaMessagesPostParams.Encoded | undefined
  }) => Effect.Effect<
    [body: typeof Generated.BetaMessage.Type, response: HttpClientResponse.HttpClientResponse],
    AiError.AiError
  >

  /**
   * Creates a streaming message using the Anthropic Messages API and maps all errors to the unified `AiError` type.
   *
   * **Details**
   *
   * The returned Effect yields the HTTP response and a stream of events as the model generates its response. The stream
   * automatically terminates when a `message_stop` event is received.
   */
  readonly createMessageStream: (options: {
    readonly payload: Omit<typeof Generated.BetaCreateMessageParams.Encoded, "stream">
    readonly params?: typeof Generated.BetaMessagesPostParams.Encoded | undefined
  }) => Effect.Effect<
    [response: HttpClientResponse.HttpClientResponse, stream: Stream.Stream<MessageStreamEvent, AiError.AiError>],
    AiError.AiError
  >
}

/**
 * Represents an event received from the Anthropic Messages API during a streaming request.
 *
 * **Details**
 *
 * Events include:
 * - `message_start`: Initial event containing message metadata
 * - `message_delta`: Incremental updates to the message (e.g., stop reason)
 * - `message_stop`: Final event indicating the message is complete
 * - `content_block_start`: Start of a content block
 * - `content_block_delta`: Incremental content updates (text, tool use, etc.)
 * - `content_block_stop`: End of a content block
 * - `error`: Error events with type and message
 *
 * @category models
 * @since 4.0.0
 */
export type MessageStreamEvent =
  | typeof Generated.BetaMessageStartEvent.Type
  | typeof Generated.BetaMessageDeltaEvent.Type
  | typeof Generated.BetaMessageStopEvent.Type
  | typeof Generated.BetaContentBlockStartEvent.Type
  | typeof Generated.BetaContentBlockDeltaEvent.Type
  | typeof Generated.BetaContentBlockStopEvent.Type
  | typeof Generated.BetaErrorResponse.Type

// =============================================================================
// Service Identifier
// =============================================================================

/**
 * Service tag for the Anthropic client.
 *
 * **When to use**
 *
 * Use when accessing or providing the Anthropic client service through Effect's
 * context.
 *
 * @see {@link make} for constructing an Anthropic client effectfully
 * @see {@link layer} for providing a client from explicit options
 * @see {@link layerConfig} for providing a client from `Config`
 *
 * @category services
 * @since 4.0.0
 */
export class AnthropicClient extends Context.Service<AnthropicClient, Service>()(
  "@effect/ai-anthropic/AnthropicClient"
) {}

// =============================================================================
// Options
// =============================================================================

/**
 * Configuration for creating an Anthropic client.
 *
 * **When to use**
 *
 * Use when the Anthropic client settings are already available as values and
 * should be passed directly to `make` or `layer`.
 *
 * **Details**
 *
 * These options configure the base Anthropic URL, the `x-api-key`
 * authentication header, the `anthropic-version` header, and an optional
 * transformation of the underlying `HttpClient`.
 *
 * @see {@link make} for constructing an Anthropic client from explicit options
 * @see {@link layer} for providing an Anthropic client from explicit options
 * @see {@link layerConfig} for loading Anthropic client settings from `Config`
 *
 * @category models
 * @since 4.0.0
 */
export type Options = {
  /**
   * The Anthropic API key for authentication. Requests are made without authentication when this is omitted, which is
   * useful for proxied setups or testing.
   */
  readonly apiKey?: Redacted.Redacted<string> | undefined

  /**
   * The base URL for the Anthropic API. Override this to use a proxy or a different API-compatible endpoint.
   *
   * @default "https://api.anthropic.com"
   */
  readonly apiUrl?: string | undefined

  /**
   * The Anthropic API version header value. This controls which version of the API to use.
   *
   * @default "2023-06-01"
   */
  readonly apiVersion?: string | undefined

  /**
   * Optional transformer for the underlying HTTP client, such as middleware, logging, or custom request/response
   * handling.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

// =============================================================================
// Constructor
// =============================================================================

const RedactedAnthropicHeaders = {
  AnthropicApiKey: "x-api-key"
}

/**
 * Creates an Anthropic client service with the given options.
 *
 * **When to use**
 *
 * Use when you have explicit configuration values and need an `Effect` that
 * constructs the Anthropic client service, rather than providing it as a `Layer`.
 *
 * **Details**
 *
 * The client handles API key authentication via the `x-api-key` header, API versioning via the `anthropic-version`
 * header, error mapping to the unified `AiError` type, and request/response transformations via `AnthropicConfig`. It
 * requires an `HttpClient` in the context.
 *
 * @see {@link layer} for providing the client as a `Layer` from explicit options
 * @see {@link layerConfig} for providing the client as a `Layer` with `Config`-based settings
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(
  function*(options: Options): Effect.fn.Return<Service, never, HttpClient.HttpClient> {
    const baseClient = yield* HttpClient.HttpClient
    const apiVersion = options.apiVersion ?? "2023-06-01"

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(options.apiUrl ?? "https://api.anthropic.com"),
          Predicate.isNotUndefined(options.apiKey)
            ? HttpClientRequest.setHeader(
              RedactedAnthropicHeaders.AnthropicApiKey,
              Redacted.value(options.apiKey)
            )
            : identity,
          HttpClientRequest.setHeader("anthropic-version", apiVersion),
          HttpClientRequest.acceptJson
        )
      ),
      Predicate.isNotUndefined(options.transformClient)
        ? options.transformClient
        : identity
    )

    const client = Generated.make(httpClient, {
      transformClient: Effect.fnUntraced(function*(client) {
        const config = yield* AnthropicConfig.getOrUndefined
        if (Predicate.isNotUndefined(config?.transformClient)) {
          return config.transformClient(client)
        }
        return client
      })
    })

    const httpClientOk = HttpClient.filterStatusOk(httpClient)

    const streamRequest = <
      Type extends {
        readonly id?: string | undefined
        readonly event: string
        readonly data: string
      },
      DecodingServices
    >(schema: Schema.Decoder<Type, DecodingServices>) =>
    (request: HttpClientRequest.HttpClientRequest): Stream.Stream<
      Type,
      HttpClientError.HttpClientError | Schema.SchemaError | Sse.Retry,
      DecodingServices
    > =>
      httpClientOk.execute(request).pipe(
        Effect.map((response) => response.stream),
        Stream.unwrap,
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decodeSchema(schema))
      )

    const createMessage = (options: {
      readonly payload: typeof Generated.BetaCreateMessageParams.Encoded
      readonly params?: typeof Generated.BetaMessagesPostParams.Encoded | undefined
    }): Effect.Effect<
      [body: typeof Generated.BetaMessage.Type, response: HttpClientResponse.HttpClientResponse],
      AiError.AiError
    > =>
      client.betaMessagesPost({ ...options, config: { includeResponse: true } }).pipe(
        Effect.catchTags({
          BetaMessagesPost4XX: (error) => Effect.fail(Errors.mapClientError(error, "createMessage")),
          HttpClientError: (error) => Errors.mapHttpClientError(error, "createMessage"),
          SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createMessage"))
        })
      )

    const PingEvent = Schema.Struct({
      type: Schema.Literal("ping")
    })

    const MessageEvent = Schema.Union([
      PingEvent,
      Generated.BetaMessageStartEvent,
      Generated.BetaMessageDeltaEvent,
      Generated.BetaMessageStopEvent,
      Generated.BetaContentBlockStartEvent,
      Generated.BetaContentBlockDeltaEvent,
      Generated.BetaContentBlockStopEvent,
      Generated.BetaErrorResponse
    ])

    const buildMessageStream = (
      response: HttpClientResponse.HttpClientResponse
    ): [HttpClientResponse.HttpClientResponse, Stream.Stream<MessageStreamEvent, AiError.AiError>] => {
      const stream = response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decodeDataSchema(MessageEvent)),
        Stream.takeUntil((event) => event.data.type === "message_stop"),
        Stream.map((event) => event.data),
        Stream.filter((event): event is MessageStreamEvent => event.type !== "ping"),
        Stream.catchTags({
          // TODO: handle SSE retries
          Retry: (error) => Stream.die(error),
          HttpClientError: (error) => Stream.fromEffect(Errors.mapHttpClientError(error, "createMessageStream")),
          SchemaError: (error) => Stream.fail(Errors.mapSchemaError(error, "createMessageStream"))
        })
      ) as any
      return [response, stream]
    }

    const createMessageStream: Service["createMessageStream"] = (options) => {
      const request = HttpClientRequest.post("/v1/messages", {
        headers: Headers.fromInput({
          "anthropic-beta": options.params?.["anthropic-beta"] ?? undefined,
          "anthropic-version": options.params?.["anthropic-version"] ?? apiVersion
        }),
        body: HttpBody.jsonUnsafe({
          ...options.payload,
          stream: true
        })
      })
      return httpClientOk.execute(request).pipe(
        Effect.map(buildMessageStream),
        Effect.catchTag(
          "HttpClientError",
          (error) => Errors.mapHttpClientError(error, "createMessageStream")
        )
      )
    }

    return AnthropicClient.of({
      client,
      streamRequest,
      createMessage,
      createMessageStream
    })
  },
  Effect.updateService(
    Headers.CurrentRedactedNames,
    Array.appendAll(Object.values(RedactedAnthropicHeaders))
  )
)

// =============================================================================
// Layers
// =============================================================================

/**
 * Creates a layer for the Anthropic client with the given options.
 *
 * **When to use**
 *
 * Use when you already have explicit `Options` values, such as an API key or
 * custom API URL, and want to provide `AnthropicClient` as a `Layer`.
 *
 * @see {@link make} for constructing the client service effectfully
 * @see {@link layerConfig} for loading client settings from `Config`
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: Options): Layer.Layer<AnthropicClient, never, HttpClient.HttpClient> =>
  Layer.effect(AnthropicClient, make(options))

/**
 * Creates a layer for the Anthropic client, loading the requisite configuration
 * via Effect's `Config` module.
 *
 * **When to use**
 *
 * Use when you want to provide the Anthropic client as a `Layer` with
 * configuration loaded from Effect's `Config` module, such as from environment
 * variables or a secrets provider.
 *
 * @see {@link layer} for providing the client from explicit options instead of `Config`
 * @see {@link make} for constructing the client service effectfully
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (options?: {
  /**
   * The Anthropic API key for authentication. Requests are made without authentication when this is omitted, which is
   * useful for proxied setups or testing.
   */
  readonly apiKey?: Config.Config<Redacted.Redacted<string> | undefined> | undefined

  /**
   * The base URL for the Anthropic API. Override this to use a proxy or a different API-compatible endpoint.
   *
   * @default "https://api.anthropic.com"
   */
  readonly apiUrl?: Config.Config<string> | undefined

  /**
   * The Anthropic API version header value. This controls which version of the API to use.
   *
   * @default "2023-06-01"
   */
  readonly apiVersion?: Config.Config<string> | undefined

  /**
   * Optional transformer for the underlying HTTP client, such as middleware, logging, or custom request/response
   * handling.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}): Layer.Layer<AnthropicClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    AnthropicClient,
    Effect.gen(function*() {
      const apiKey = Predicate.isNotUndefined(options?.apiKey)
        ? yield* options.apiKey :
        undefined
      const apiUrl = Predicate.isNotUndefined(options?.apiUrl)
        ? yield* options.apiUrl :
        undefined
      const apiVersion = Predicate.isNotUndefined(options?.apiVersion)
        ? yield* options.apiVersion :
        undefined
      return yield* make({
        apiKey,
        apiUrl,
        apiVersion,
        transformClient: options?.transformClient
      })
    })
  )
