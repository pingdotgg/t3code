/**
 * The `OpenAiClient` module provides the handwritten Effect service used by
 * the OpenAI integration for Responses API and embedding requests. It builds on
 * the Effect HTTP client, applies OpenAI authentication and organization or
 * project headers, decodes the minimal schemas needed by higher-level modules,
 * and maps transport or decoding failures into `AiError`.
 *
 * The service exposes a configured HTTP client plus helpers for non-streaming
 * responses, server-sent event response streams, and embeddings. It also
 * includes WebSocket mode for response streams when an application wants to use
 * OpenAI's WebSocket transport instead of the default SSE path.
 *
 * **Common tasks**
 *
 * - Construct the service directly with {@link make}
 * - Provide the service with {@link layer} or load settings from `Config` with
 *   {@link layerConfig}
 * - Call `createResponse`, `createResponseStream`, or `createEmbedding` from
 *   code that depends on the `OpenAiClient` service
 * - Enable WebSocket streaming around an effect with {@link withWebSocketMode}
 *   or through layers with {@link layerWebSocketMode}
 *
 * **Gotchas**
 *
 * - The default base URL is `https://api.openai.com/v1`; set `apiUrl` for
 *   proxies, local gateways, or compatible deployments.
 * - A constructor `transformClient` is applied when the service is built, while
 *   scoped `OpenAiConfig` transforms are applied by request helpers when they
 *   run.
 * - WebSocket mode requires a supported `Socket.WebSocketConstructor` layer and
 *   serializes response streams through the shared socket service.
 * - This module is intentionally narrower than the generated OpenAI client; use
 *   `OpenAiClientGenerated` for direct access to generated endpoint helpers.
 *
 * @since 4.0.0
 */
import * as Array from "effect/Array"
import type * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Function from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Queue from "effect/Queue"
import * as RcRef from "effect/RcRef"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as AiError from "effect/unstable/ai/AiError"
import * as ResponseIdTracker from "effect/unstable/ai/ResponseIdTracker"
import * as Sse from "effect/unstable/encoding/Sse"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as Socket from "effect/unstable/socket/Socket"
import * as Errors from "./internal/errors.ts"
import { OpenAiConfig } from "./OpenAiConfig.ts"
import * as OpenAiSchema from "./OpenAiSchema.ts"

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Effect service interface for the handwritten OpenAI client.
 *
 * **Details**
 *
 * Provides the configured HTTP client plus helpers for Responses API calls, streaming Responses events, and embeddings. Transport and schema decoding failures are mapped to `AiError`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  /**
   * The transformed HTTP client used by this service.
   */
  readonly client: HttpClient.HttpClient

  /**
   * Create a response using the OpenAI responses endpoint.
   */
  readonly createResponse: (
    options: typeof OpenAiSchema.CreateResponse.Encoded
  ) => Effect.Effect<
    readonly [body: typeof OpenAiSchema.Response.Type, response: HttpClientResponse.HttpClientResponse],
    AiError.AiError
  >

  /**
   * Create a streaming response using the OpenAI responses endpoint.
   */
  readonly createResponseStream: (
    options: Omit<typeof OpenAiSchema.CreateResponse.Encoded, "stream">
  ) => Effect.Effect<
    readonly [
      response: HttpClientResponse.HttpClientResponse,
      stream: Stream.Stream<typeof OpenAiSchema.ResponseStreamEvent.Type, AiError.AiError>
    ],
    AiError.AiError
  >

  /**
   * Create embeddings using the OpenAI embeddings endpoint.
   */
  readonly createEmbedding: (
    options: typeof OpenAiSchema.CreateEmbeddingRequest.Encoded
  ) => Effect.Effect<typeof OpenAiSchema.CreateEmbeddingResponse.Type, AiError.AiError>
}

// =============================================================================
// Service Identifier
// =============================================================================

/**
 * Service tag for the OpenAI client.
 *
 * **When to use**
 *
 * Use when accessing or providing the OpenAI client service through Effect's
 * context.
 *
 * @see {@link make} for constructing an OpenAI client effectfully
 * @see {@link layer} for providing a client from explicit options
 * @see {@link layerConfig} for providing a client from `Config`
 *
 * @category services
 * @since 4.0.0
 */
export class OpenAiClient extends Context.Service<OpenAiClient, Service>()(
  "@effect/ai-openai/OpenAiClient"
) {}

// =============================================================================
// Options
// =============================================================================

/**
 * Options for configuring the OpenAI client.
 *
 * @category models
 * @since 4.0.0
 */
export type Options = {
  /**
   * The OpenAI API key.
   */
  readonly apiKey?: Redacted.Redacted<string> | undefined

  /**
   * The base URL for the OpenAI API.
   *
   * @default "https://api.openai.com/v1"
   */
  readonly apiUrl?: string | undefined

  /**
   * Optional organization ID for multi-org accounts.
   */
  readonly organizationId?: Redacted.Redacted<string> | undefined

  /**
   * Optional project ID for project-scoped requests.
   */
  readonly projectId?: Redacted.Redacted<string> | undefined

  /**
   * Optional transformer for the HTTP client.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

// =============================================================================
// Constructor
// =============================================================================

const RedactedOpenAiHeaders = {
  OpenAiOrganization: "OpenAI-Organization",
  OpenAiProject: "OpenAI-Project"
}

/**
 * Creates an OpenAI client service with the given options.
 *
 * **When to use**
 *
 * Use to construct the OpenAI client service inside an effect when you need the
 * service value directly.
 *
 * **Details**
 *
 * The returned service uses the current `HttpClient`, prepends `apiUrl` or
 * `https://api.openai.com/v1`, adds the bearer token and optional OpenAI
 * organization/project headers, accepts JSON responses, filters for successful
 * HTTP statuses, and applies `transformClient` when provided.
 *
 * **Gotchas**
 *
 * A scoped `OpenAiConfig.withClientTransform` is applied when request helpers
 * run, after the `transformClient` option supplied to `make`.
 *
 * @see {@link layer} for providing this client from explicit options
 * @see {@link layerConfig} for loading client settings from `Config`
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(
  function*(
    options: Options
  ): Effect.fn.Return<Service, never, HttpClient.HttpClient> {
    const baseClient = yield* HttpClient.HttpClient
    const apiUrl = options.apiUrl ?? "https://api.openai.com/v1"

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest(Function.flow(
        HttpClientRequest.prependUrl(apiUrl),
        options.apiKey
          ? HttpClientRequest.bearerToken(Redacted.value(options.apiKey))
          : identity,
        options.organizationId
          ? HttpClientRequest.setHeader(
            RedactedOpenAiHeaders.OpenAiOrganization,
            Redacted.value(options.organizationId)
          )
          : identity,
        options.projectId
          ? HttpClientRequest.setHeader(
            RedactedOpenAiHeaders.OpenAiProject,
            Redacted.value(options.projectId)
          )
          : identity,
        HttpClientRequest.acceptJson
      )),
      HttpClient.filterStatusOk,
      options.transformClient
        ? options.transformClient
        : identity
    )

    const resolveHttpClient = Effect.map(
      OpenAiConfig.getOrUndefined,
      (config) =>
        Predicate.isNotUndefined(config?.transformClient)
          ? config.transformClient(httpClient)
          : httpClient
    )

    const decodeResponse = HttpClientResponse.schemaBodyJson(OpenAiSchema.Response)

    const createResponse = (
      payload: typeof OpenAiSchema.CreateResponse.Encoded
    ): Effect.Effect<
      [body: typeof OpenAiSchema.Response.Type, response: HttpClientResponse.HttpClientResponse],
      AiError.AiError
    > =>
      Effect.flatMap(resolveHttpClient, (client) =>
        client.execute(
          HttpClientRequest.post("/responses", {
            body: HttpBody.jsonUnsafe(payload)
          })
        ).pipe(
          Effect.flatMap((response) =>
            decodeResponse(response).pipe(
              Effect.map((body): [typeof OpenAiSchema.Response.Type, HttpClientResponse.HttpClientResponse] => [
                body,
                response
              ])
            )
          ),
          Effect.catchTags({
            HttpClientError: (error) => Errors.mapHttpClientError(error, "createResponse"),
            SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createResponse"))
          })
        ))

    const buildResponseStream = (
      response: HttpClientResponse.HttpClientResponse
    ): [
      HttpClientResponse.HttpClientResponse,
      Stream.Stream<typeof OpenAiSchema.ResponseStreamEvent.Type, AiError.AiError>
    ] => {
      const stream = response.stream.pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
        Stream.takeUntil((event) =>
          event.data.type === "response.completed" ||
          event.data.type === "response.incomplete"
        ),
        Stream.map((event) => event.data),
        Stream.catchTags({
          // TODO: handle SSE retries
          Retry: (error) => Stream.die(error),
          HttpClientError: (error) => Stream.fromEffect(Errors.mapHttpClientError(error, "createResponseStream")),
          SchemaError: (error) => Stream.fail(Errors.mapSchemaError(error, "createResponseStream"))
        })
      )
      return [response, stream]
    }

    const createResponseStream: Service["createResponseStream"] = (payload) =>
      Effect.contextWith((services) => {
        const socket = Context.getOrUndefined(services, OpenAiSocket)
        if (socket) return socket.createResponseStream(payload)
        return Effect.flatMap(resolveHttpClient, (client) =>
          client.execute(
            HttpClientRequest.post("/responses", {
              body: HttpBody.jsonUnsafe({ ...payload, stream: true })
            })
          ).pipe(
            Effect.map(buildResponseStream),
            Effect.catchTag(
              "HttpClientError",
              (error) => Errors.mapHttpClientError(error, "createResponseStream")
            )
          ))
      })

    const decodeEmbedding = HttpClientResponse.schemaBodyJson(OpenAiSchema.CreateEmbeddingResponse)

    const createEmbedding = (
      payload: typeof OpenAiSchema.CreateEmbeddingRequest.Encoded
    ): Effect.Effect<typeof OpenAiSchema.CreateEmbeddingResponse.Type, AiError.AiError> =>
      Effect.flatMap(resolveHttpClient, (client) =>
        client.execute(
          HttpClientRequest.post("/embeddings", {
            body: HttpBody.jsonUnsafe(payload)
          })
        ).pipe(
          Effect.flatMap(decodeEmbedding),
          Effect.catchTags({
            HttpClientError: (error) => Errors.mapHttpClientError(error, "createEmbedding"),
            SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createEmbedding"))
          })
        ))

    return OpenAiClient.of({
      client: httpClient,
      createResponse,
      createResponseStream,
      createEmbedding
    })
  },
  Effect.updateService(
    Headers.CurrentRedactedNames,
    Array.appendAll(Object.values(RedactedOpenAiHeaders))
  )
)

// =============================================================================
// Layers
// =============================================================================

/**
 * Creates a layer for the OpenAI client with the given options.
 *
 * **When to use**
 *
 * Use when you already have explicit `Options` values, such as an API key or
 * custom API URL, and want to provide `OpenAiClient` as a `Layer`.
 *
 * @see {@link make} for constructing the client service effectfully
 * @see {@link layerConfig} for loading client settings from `Config`
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: Options): Layer.Layer<OpenAiClient, never, HttpClient.HttpClient> =>
  Layer.effect(OpenAiClient, make(options))

/**
 * Creates a layer for the OpenAI client from provided `Config` values.
 *
 * **When to use**
 *
 * Use when client settings should be read from Effect `Config` values while
 * providing `OpenAiClient` as a `Layer`.
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
   * The config value to load for the organization ID.
   */
  readonly organizationId?: Config.Config<Redacted.Redacted<string> | undefined> | undefined

  /**
   * The config value to load for the project ID.
   */
  readonly projectId?: Config.Config<Redacted.Redacted<string> | undefined> | undefined

  /**
   * Optional transformer for the HTTP client.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}): Layer.Layer<OpenAiClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    OpenAiClient,
    Effect.gen(function*() {
      const apiKey = Predicate.isNotUndefined(options?.apiKey)
        ? yield* options.apiKey :
        undefined
      const apiUrl = Predicate.isNotUndefined(options?.apiUrl)
        ? yield* options.apiUrl :
        undefined
      const organizationId = Predicate.isNotUndefined(options?.organizationId)
        ? yield* options.organizationId
        : undefined
      const projectId = Predicate.isNotUndefined(options?.projectId)
        ? yield* options.projectId :
        undefined
      return yield* make({
        apiKey,
        apiUrl,
        organizationId,
        projectId,
        transformClient: options?.transformClient
      })
    })
  )

// =============================================================================
// Websocket mode
// =============================================================================

/**
 * Response stream event emitted by the OpenAI Responses API.
 *
 * @category Events
 * @since 4.0.0
 */
export type ResponseStreamEvent = typeof OpenAiSchema.ResponseStreamEvent.Type

/**
 * Service for creating OpenAI response streams over a WebSocket connection.
 *
 * **When to use**
 *
 * Use when code needs direct access to the WebSocket-backed response streaming
 * service rather than wrapping an effect with WebSocket mode.
 *
 * **Details**
 *
 * `createResponseStream` sends a `response.create` message over the WebSocket
 * connection and returns an HTTP response together with a stream of
 * `ResponseStreamEvent` values.
 *
 * **Gotchas**
 *
 * WebSocket response streams are serialized to one request at a time by the
 * shared socket service.
 *
 * @see {@link withWebSocketMode} for enabling WebSocket mode for one effect
 * @see {@link layerWebSocketMode} for providing WebSocket mode through a layer
 *
 * @category Websocket mode
 * @since 4.0.0
 */
export class OpenAiSocket extends Context.Service<OpenAiSocket, {
  /**
   * Create a streaming response using the OpenAI responses endpoint.
   */
  readonly createResponseStream: (
    options: Omit<typeof OpenAiSchema.CreateResponse.Encoded, "stream">
  ) => Effect.Effect<
    readonly [
      response: HttpClientResponse.HttpClientResponse,
      stream: Stream.Stream<ResponseStreamEvent, AiError.AiError>
    ],
    AiError.AiError
  >
}>()("@effect/ai-openai/OpenAiClient/OpenAiSocket") {}

const makeSocket = Effect.gen(function*() {
  const client = yield* OpenAiClient
  const tracker = yield* ResponseIdTracker.make
  const socketScope = yield* Effect.scope
  const makeRequest = Effect.flatMap(
    OpenAiConfig.getOrUndefined,
    (config) => {
      const httpClient = Predicate.isNotUndefined(config?.transformClient)
        ? config.transformClient(client.client)
        : client.client
      return Effect.orDie(httpClient.preprocess(HttpClientRequest.post("/responses")))
    }
  )
  const makeWebSocket = yield* Socket.WebSocketConstructor

  const decoder = new TextDecoder()

  const queueRef: RcRef.RcRef<
    {
      readonly send: (message: typeof OpenAiSchema.CreateResponse.Encoded) => Effect.Effect<void, AiError.AiError>
      readonly incoming: Queue.Dequeue<ResponseStreamEvent, AiError.AiError>
    }
  > = yield* RcRef.make({
    idleTimeToLive: 60_000,
    acquire: Effect.gen(function*() {
      const scope = yield* Effect.scope
      const request = yield* makeRequest
      const socket = yield* Socket.makeWebSocket(request.url.replace(/^http/, "ws")).pipe(
        Effect.provideService(Socket.WebSocketConstructor, (url) =>
          makeWebSocket(url, {
            headers: request.headers
          } as any))
      )
      const write = yield* socket.writer

      yield* Scope.addFinalizerExit(scope, () => {
        tracker.clearUnsafe()
        return Effect.void
      })

      const incoming = yield* Queue.unbounded<ResponseStreamEvent, AiError.AiError>()
      const send = (message: typeof OpenAiSchema.CreateResponse.Encoded) =>
        write(JSON.stringify({
          type: "response.create",
          ...message
        })).pipe(
          Effect.mapError((_error) =>
            AiError.make({
              module: "OpenAiClient",
              method: "createResponseStream",
              reason: new AiError.NetworkError({
                reason: "TransportError",
                request: {
                  method: "POST",
                  url: request.url,
                  urlParams: [],
                  hash: undefined,
                  headers: request.headers
                },
                description: "Failed to send message over WebSocket"
              })
            })
          )
        )

      yield* socket.runRaw((msg) => {
        const text = typeof msg === "string" ? msg : decoder.decode(msg)
        try {
          const event = decodeEvent(text)
          if (event.type === "error" && "status" in event) {
            const status = Number(event.status)
            const error = "error" in event ? event.error as typeof ErrorEvent.Type.error : event
            const json = JSON.stringify(error)
            return Effect.fail(
              AiError.make({
                module: "OpenAiClient",
                method: "createResponseStream",
                reason: AiError.reasonFromHttpStatus({
                  description: json,
                  status: isNaN(status) ? errorTypeToStatus[error.type] ?? 500 : status,
                  metadata: error as any,
                  http: {
                    body: json,
                    request: {
                      method: "POST",
                      url: request.url,
                      urlParams: [],
                      hash: undefined,
                      headers: request.headers
                    }
                  }
                })
              })
            )
          }
          Queue.offerUnsafe(incoming, event)
        } catch {}
      }).pipe(
        Effect.catchTag("SocketError", (error) =>
          AiError.make({
            module: "OpenAiClient",
            method: "createResponseStream",
            reason: new AiError.NetworkError({
              reason: "TransportError",
              request: {
                method: "POST",
                url: request.url,
                urlParams: [],
                hash: undefined,
                headers: request.headers
              },
              description: error.message
            })
          })),
        Effect.catchCause((cause) => Queue.failCause(incoming, cause)),
        Effect.ensuring(Effect.forkIn(RcRef.invalidate(queueRef), socketScope, {
          startImmediately: true
        })),
        Effect.forkScoped({ startImmediately: true })
      )

      return { send, incoming } as const
    })
  })

  // Prime the websocket
  yield* Effect.scoped(RcRef.get(queueRef))

  // Websocket mode only allows one request at a time
  const semaphore = Semaphore.makeUnsafe(1)
  const request = yield* makeRequest

  return OpenAiSocket.context({
    createResponseStream(options) {
      const stream = Stream.unwrap(Effect.gen(function*() {
        const scope = yield* Effect.scope
        yield* Effect.acquireRelease(
          semaphore.take(1),
          () => semaphore.release(1),
          { interruptible: true }
        )
        const { send, incoming } = yield* RcRef.get(queueRef)
        let done = false

        yield* Scope.addFinalizerExit(
          scope,
          () => done ? Effect.void : RcRef.invalidate(queueRef)
        )

        yield* send(options).pipe(
          Effect.forkScoped({ startImmediately: true })
        )

        return Stream.fromQueue(incoming).pipe(
          Stream.takeUntil((e) => {
            done = e.type === "response.completed" || e.type === "response.incomplete"
            return done
          })
        )
      }))

      return Effect.succeed([
        HttpClientResponse.fromWeb(request, new Response()),
        stream
      ])
    }
  }).pipe(
    Context.add(ResponseIdTracker.ResponseIdTracker, tracker)
  )
})

const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  status: Schema.Number.pipe(
    Schema.withDecodingDefault(Effect.succeed(500))
  ),
  error: Schema.Struct({
    type: Schema.String,
    message: Schema.String
  })
})

const errorTypeToStatus: Record<string, number> = {
  invalid_request_error: 400,
  invalid_api_key_error: 401,
  insufficient_quota_error: 429,
  rate_limit_error: 429,
  service_unavailable_error: 503
}

const AllEvents = Schema.Union([ErrorEvent, OpenAiSchema.ResponseStreamEvent])
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(AllEvents))

/**
 * Uses OpenAI's WebSocket mode for response streams within the provided effect.
 *
 * **When to use**
 *
 * Use to enable WebSocket mode around one effect that creates OpenAI response
 * streams.
 *
 * **Gotchas**
 *
 * This only works with the following WebSocket constructor layers:
 *
 * - `NodeSocket.layerWebSocketConstructorWS`
 * - `BunSocket.layerWebSocketConstructor`
 *
 * This is because it needs to use non-standard options for setting the Authorization header.
 *
 * @see {@link layerWebSocketMode} for providing WebSocket mode through a layer
 * @see {@link OpenAiSocket} for direct access to the WebSocket-backed streaming service
 *
 * @category Websocket mode
 * @since 4.0.0
 */
export const withWebSocketMode = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E,
  Exclude<R, OpenAiSocket | ResponseIdTracker.ResponseIdTracker> | OpenAiClient | Socket.WebSocketConstructor
> =>
  Effect.scopedWith((scope) =>
    Effect.flatMap(
      Scope.provide(makeSocket, scope),
      (services) => Effect.provideContext(effect, services)
    )
  )

/**
 * Uses OpenAI's websocket mode for all responses that use the Layer.
 *
 * **When to use**
 *
 * Use to provide WebSocket mode through layer composition for effects that use
 * OpenAI response streaming.
 *
 * **Gotchas**
 *
 * This only works with the following WebSocket constructor layers:
 *
 * - `NodeSocket.layerWebSocketConstructorWS`
 * - `BunSocket.layerWebSocketConstructor`
 *
 * This is because it needs to use non-standard options for setting the Authorization header.
 *
 * @see {@link withWebSocketMode} for enabling WebSocket mode around a single effect
 *
 * @category Websocket mode
 * @since 4.0.0
 */
export const layerWebSocketMode: Layer.Layer<
  OpenAiSocket | ResponseIdTracker.ResponseIdTracker,
  never,
  OpenAiClient | Socket.WebSocketConstructor
> = Layer.effectContext(makeSocket)
