/**
 * The `AmazonBedrockClient` module defines the low-level Effect service used to
 * call the Amazon Bedrock Runtime Converse API. It wraps an `HttpClient` with
 * AWS Signature Version 4 signing or Bedrock API key authentication, request
 * defaults, response decoding, event stream decoding and error mapping to the
 * unified `AiError` type.
 *
 * **Mental model**
 *
 * `HttpClient.HttpClient` provides the transport, and the `Digest` and `Mac`
 * services of `effect/crypto` provide the SHA-256 and HMAC that SigV4 signing
 * runs on. {@link make} turns {@link Options} into an
 * {@link AmazonBedrockClient} service, while {@link layer} and
 * {@link layerConfig} provide that service as a layer. The service exposes
 * helpers for the `converse` and `converse-stream` endpoints.
 *
 * @stability unstable
 * @since 4.0.0
 */
import * as AiError from "effect/ai/AiError"
import * as Array from "effect/Array"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Headers from "effect/http/Headers"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { AmazonBedrockConfig } from "./AmazonBedrockConfig.ts"
import type { ConverseRequest } from "./AmazonBedrockSchema.ts"
import { ConverseResponse, ConverseStreamEvent, ConverseStreamException } from "./AmazonBedrockSchema.ts"
import * as Errors from "./internal/errors.ts"
import * as EventStream from "./internal/eventStream.ts"
import * as SigV4 from "./internal/sigv4.ts"

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Represents the Amazon Bedrock client service with methods for the Converse
 * API, including regular and streaming message creation.
 *
 * @stability unstable
 * @category services
 * @since 4.0.0
 */
export interface Service {
  /**
   * The underlying `HttpClient`, with the base URL and authentication
   * applied, for Bedrock Runtime operations this service does not model.
   * Resolving the credentials can fail with an `AiError`.
   */
  readonly client: HttpClient.HttpClient.With<HttpClientError.HttpClientError | AiError.AiError>

  /**
   * Calls the Converse operation and maps all errors to the unified `AiError`
   * type. `modelId` names the model in the URL; the other fields form the
   * request body.
   */
  readonly converse: (
    request: typeof ConverseRequest.Encoded
  ) => Effect.Effect<ConverseResponse, AiError.AiError>

  /**
   * Calls the ConverseStream operation and decodes the event stream, mapping
   * all errors to the unified `AiError` type. An exception frame in the
   * stream, such as a `throttlingException`, fails the stream.
   */
  readonly converseStream: (
    request: typeof ConverseRequest.Encoded
  ) => Stream.Stream<ConverseStreamEvent, AiError.AiError>
}

// =============================================================================
// Service Identifier
// =============================================================================

/**
 * Service tag for the Amazon Bedrock client.
 *
 * @see {@link make} for constructing a client effectfully
 * @see {@link layer} for providing a client from explicit options
 * @see {@link layerConfig} for providing a client from `Config`
 *
 * @stability unstable
 * @category services
 * @since 4.0.0
 */
export class AmazonBedrockClient extends Context.Service<AmazonBedrockClient, Service>()(
  "@effect/ai-amazon-bedrock/AmazonBedrockClient"
) {}

// =============================================================================
// Options
// =============================================================================

/**
 * AWS credentials, in the shape of the AWS SDK's `AwsCredentialIdentity`, so
 * the SDK's credential providers fit without an adapter.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** An empty token is sent as no token. */
  readonly sessionToken?: string | undefined
}

/**
 * Configuration for creating an Amazon Bedrock client.
 *
 * **Details**
 *
 * The client authenticates in one of three ways, in this order of precedence:
 *
 * - `apiKey`, a Bedrock API key, sent as `Authorization: Bearer <key>`.
 * - `credentials`, an effect resolved before every request, signed with
 *   SigV4. This is where a credential provider such as `fromNodeProviderChain()`
 *   from `@aws-sdk/credential-providers` plugs in, wrapped in
 *   `Effect.promise`. To avoid resolving credentials on every request, build
 *   the layer inside `Layer.unwrap` and pass the effect that
 *   `Effect.cachedWithTTL` returns.
 * - `accessKeyId` and `secretAccessKey`, with an optional `sessionToken`,
 *   signed with SigV4.
 *
 * Without any of them, every request fails with an `AuthenticationError` of
 * kind `MissingKey`.
 *
 * @stability unstable
 * @category options
 * @since 4.0.0
 */
export interface Options {
  /**
   * The AWS region.
   *
   * @default "us-east-1"
   */
  readonly region?: string | undefined
  /**
   * The base URL for the Bedrock Runtime API. Override to use a proxy or a
   * different endpoint.
   *
   * @default `https://bedrock-runtime.${region}.amazonaws.com`
   */
  readonly apiUrl?: string | undefined
  readonly accessKeyId?: string | undefined
  readonly secretAccessKey?: Redacted.Redacted<string> | undefined
  readonly sessionToken?: Redacted.Redacted<string> | undefined
  /**
   * A Bedrock API key, sent as `Authorization: Bearer <key>` in place of a
   * SigV4 signature.
   */
  readonly apiKey?: Redacted.Redacted<string> | undefined
  /**
   * Resolves the AWS credentials of each request.
   */
  readonly credentials?: Effect.Effect<Credentials, AiError.AiError> | undefined
  /**
   * Optional transformer for the underlying HTTP client, such as middleware,
   * logging, or custom request/response handling.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

// =============================================================================
// Constructor
// =============================================================================

type RequestCredentials =
  | { readonly _tag: "Bearer"; readonly apiKey: Redacted.Redacted<string> }
  | { readonly _tag: "SigV4"; readonly credentials: SigV4.SigningCredentials }

/**
 * The credentials of the request in flight. The client resolves them before
 * `HttpClient.execute` and provides them around it, so that a resolution
 * failure is not an `HttpClientError` that a retry policy would retry, and so
 * that every retry inside `execute` signs again with them.
 */
const CurrentRequestCredentials = Context.Reference<RequestCredentials | undefined>(
  "@effect/ai-amazon-bedrock/AmazonBedrockClient/CurrentRequestCredentials",
  { defaultValue: () => undefined }
)

const appendRedactedHeaders = Array.append("x-amz-security-token")

const withRedactedHeaders = Effect.updateService(Headers.CurrentRedactedNames, appendRedactedHeaders)

const missingKey = (method: string, description: string) =>
  Errors.make(method, new AiError.AuthenticationError({ kind: "MissingKey", description }))

const sigV4 = (accessKeyId: string, secretAccessKey: string, sessionToken: string | undefined): RequestCredentials => ({
  _tag: "SigV4",
  credentials: { accessKeyId, secretAccessKey, sessionToken: sessionToken === "" ? undefined : sessionToken }
})

const makeResolveCredentials = (
  options: Options
): (method: string) => Effect.Effect<RequestCredentials, AiError.AiError> => {
  if (options.apiKey !== undefined) {
    const credentials = Effect.succeed<RequestCredentials>({ _tag: "Bearer", apiKey: options.apiKey })
    return () => credentials
  }
  if (options.credentials !== undefined) {
    const resolve = options.credentials
    return (method) =>
      Effect.flatMap(resolve, (credentials) =>
        credentials.accessKeyId === "" || credentials.secretAccessKey === ""
          ? Effect.fail(
            missingKey(method, "The credentials effect returned an empty access key ID or secret access key")
          )
          : Effect.succeed(sigV4(credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken)))
  }
  if (options.accessKeyId !== undefined && options.secretAccessKey !== undefined) {
    const credentials = Effect.succeed(sigV4(
      options.accessKeyId,
      Redacted.value(options.secretAccessKey),
      options.sessionToken === undefined ? undefined : Redacted.value(options.sessionToken)
    ))
    return () => credentials
  }
  return (method) =>
    Effect.fail(missingKey(
      method,
      "AmazonBedrockClient has no credentials: set `apiKey`, `credentials`, or `accessKeyId` with `secretAccessKey`"
    ))
}

const authenticateRequest = (signing: {
  readonly region: string
  readonly digest: Digest.Digest["Service"]
  readonly mac: Mac.Mac["Service"]
}) =>
  Effect.fnUntraced(function*(request: HttpClientRequest.HttpClientRequest) {
    const credentials = yield* CurrentRequestCredentials
    if (Predicate.isUndefined(credentials)) {
      return yield* Effect.die(new Error("AmazonBedrockClient sent a request without resolving its credentials"))
    }
    switch (credentials._tag) {
      case "Bearer": {
        return HttpClientRequest.bearerToken(request, credentials.apiKey)
      }
      case "SigV4": {
        return yield* SigV4.sign(request, { ...signing, credentials: credentials.credentials })
      }
    }
  })

const decodeResponse = HttpClientResponse.schemaBodyJson(ConverseResponse)
const decodeStreamEvent = Schema.decodeUnknownEffect(ConverseStreamEvent)
const decodeStreamException = Schema.decodeUnknownEffect(ConverseStreamException)

/**
 * Creates an Amazon Bedrock client service with the given options.
 *
 * **Details**
 *
 * The client signs with the `Digest` and `Mac` services in its context, so
 * the caller chooses their implementation: the WebCrypto layers of
 * `effect/crypto`, or the layers of a platform package such as
 * `NodeCrypto.layer` from `@effect/platform-node`. They are required for
 * every way of authenticating, although a client with an `apiKey` never
 * calls them. A `CryptoError` from the `Mac` service is a defect.
 *
 * @see {@link layer} for providing the client as a `Layer` from explicit options
 * @see {@link layerConfig} for providing the client as a `Layer` with `Config`-based settings
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(
  function*(
    options: Options
  ): Effect.fn.Return<Service, never, HttpClient.HttpClient | Digest.Digest | Mac.Mac> {
    const region = options.region ?? "us-east-1"
    const apiUrl = options.apiUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`
    const baseClient = yield* HttpClient.HttpClient
    const digest = yield* Digest.Digest
    const mac = yield* Mac.Mac
    const resolveCredentials = makeResolveCredentials(options)

    // Resolves the credentials of one request before it executes, so that a
    // credentials failure is not an `HttpClientError` a retry policy would
    // retry, and provides them for `authenticateRequest` to sign each attempt.
    const withCredentials = (method: string) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
      Effect.flatMap(
        resolveCredentials(method),
        (credentials) => Effect.provideService(self, CurrentRequestCredentials, credentials)
      )

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(HttpClientRequest.prependUrl(apiUrl), HttpClientRequest.acceptJson)
      ),
      HttpClient.mapRequestEffect(authenticateRequest({ region, digest, mac })),
      options.transformClient ?? identity
    )

    // The exposed client resolves the credentials of each request itself and
    // redacts the session token in header tracing, as the helpers do.
    const client = HttpClient.makeWith(
      (requestEffect) =>
        Effect.flatMap(
          requestEffect,
          (request) => httpClient.execute(request).pipe(withCredentials("execute"), withRedactedHeaders)
        ),
      Effect.succeed as HttpClient.HttpClient.Preprocess<never, never>
    )

    const httpClientOk = HttpClient.filterStatusOk(httpClient)

    const configClient = Effect.map(
      AmazonBedrockConfig.getOrUndefined,
      (config) => (config?.transformClient ?? identity)(httpClientOk)
    )

    const execute = (
      operation: "converse" | "converse-stream",
      method: string,
      { modelId, ...body }: typeof ConverseRequest.Encoded
    ) =>
      configClient.pipe(
        Effect.flatMap((client) =>
          client.execute(HttpClientRequest.post(`/model/${encodeURIComponent(modelId)}/${operation}`, {
            body: HttpBody.jsonUnsafe(body)
          }))
        ),
        withCredentials(method)
      )

    const converse: Service["converse"] = (request) =>
      execute("converse", "converse", request).pipe(
        Effect.flatMap(decodeResponse),
        Effect.catchTags({
          HttpClientError: (error) => Errors.mapHttpClientError(error, "converse"),
          SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "converse"))
        }),
        withRedactedHeaders
      )

    const decodeFrame = Effect.fnUntraced(function*(frame: EventStream.Frame) {
      const messageType = frame.headers[":message-type"]
      switch (messageType) {
        case "event": {
          const eventType = frame.headers[":event-type"]
          if (Predicate.isUndefined(eventType)) {
            return undefined
          }
          const payload = yield* EventStream.parseJsonPayload(frame)
          return yield* decodeStreamEvent({ [eventType]: payload })
        }
        case "exception": {
          const payload = yield* EventStream.parseJsonPayload(frame)
          const exception = yield* decodeStreamException(payload)
          return yield* Errors.mapStreamException(
            frame.headers[":exception-type"] ?? "unknown exception",
            exception.message,
            "converseStream"
          )
        }
        case "error": {
          return yield* Errors.make(
            "converseStream",
            new AiError.InternalProviderError({
              description: `Event stream error frame [${frame.headers[":error-code"] ?? "unknown"}]: ${
                frame.headers[":error-message"] ?? "no error message provided"
              }`
            })
          )
        }
        default: {
          return undefined
        }
      }
    })

    const converseStream: Service["converseStream"] = (request) =>
      execute("converse-stream", "converseStream", request).pipe(
        HttpClientResponse.stream,
        EventStream.decode,
        Stream.mapEffect(decodeFrame),
        Stream.filter(Predicate.isNotUndefined),
        Stream.catchTags({
          HttpClientError: (error) => Stream.fromEffect(Errors.mapHttpClientError(error, "converseStream")),
          SchemaError: (error) => Stream.fail(Errors.mapSchemaError(error, "converseStream")),
          EventStreamError: (error) => Stream.fail(Errors.mapEventStreamError(error, "converseStream"))
        }),
        Stream.updateService(Headers.CurrentRedactedNames, appendRedactedHeaders)
      )

    return AmazonBedrockClient.of({
      client,
      converse,
      converseStream
    })
  },
  withRedactedHeaders
)

// =============================================================================
// Layers
// =============================================================================

/**
 * Creates a layer for the Amazon Bedrock client with the given options.
 *
 * **Example** (Providing the transport and the crypto services)
 *
 * ```ts
 * import { AmazonBedrockClient } from "@effect/ai-amazon-bedrock"
 * import { Layer, Redacted } from "effect"
 * import { Digest, Mac, SecureRandom } from "effect/crypto"
 * import { FetchHttpClient } from "effect/http"
 *
 * const BedrockClient = AmazonBedrockClient.layer({
 *   region: "eu-west-1",
 *   accessKeyId: "AKIAIOSFODNN7EXAMPLE",
 *   secretAccessKey: Redacted.make("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
 * }).pipe(
 *   Layer.provide([
 *     FetchHttpClient.layer,
 *     Digest.layerWebCrypto,
 *     Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
 *   ])
 * )
 * ```
 *
 * @see {@link make} for constructing the client service effectfully
 * @see {@link layerConfig} for loading client settings from `Config`
 *
 * @stability unstable
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  options: Options
): Layer.Layer<AmazonBedrockClient, never, HttpClient.HttpClient | Digest.Digest | Mac.Mac> =>
  Layer.effect(AmazonBedrockClient, make(options))

/**
 * Creates a layer for the Amazon Bedrock client, loading credentials and other
 * settings via Effect's `Config` module.
 *
 * **Details**
 *
 * Each setting defaults to the environment variable that the AWS tools read:
 * `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 * `AWS_SESSION_TOKEN` and, for a Bedrock API key, `AWS_BEARER_TOKEN_BEDROCK`.
 * Every one of them is optional; see {@link Options} for which of them are
 * used when several are set.
 *
 * @see {@link layer} for providing the client from explicit options instead of `Config`
 * @see {@link make} for constructing the client service effectfully
 *
 * @stability unstable
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (options?: {
  readonly region?: Config.Config<string | undefined> | undefined
  readonly apiUrl?: Config.Config<string | undefined> | undefined
  readonly accessKeyId?: Config.Config<string | undefined> | undefined
  readonly secretAccessKey?: Config.Config<Redacted.Redacted<string> | undefined> | undefined
  readonly sessionToken?: Config.Config<Redacted.Redacted<string> | undefined> | undefined
  readonly apiKey?: Config.Config<Redacted.Redacted<string> | undefined> | undefined
  readonly credentials?: Effect.Effect<Credentials, AiError.AiError> | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}): Layer.Layer<AmazonBedrockClient, Config.ConfigError, HttpClient.HttpClient | Digest.Digest | Mac.Mac> =>
  Layer.effect(
    AmazonBedrockClient,
    Effect.gen(function*() {
      return yield* make({
        region: yield* options?.region ?? optional(Config.String("AWS_REGION")),
        apiUrl: yield* options?.apiUrl ?? Effect.undefined,
        accessKeyId: yield* options?.accessKeyId ?? optional(Config.String("AWS_ACCESS_KEY_ID")),
        secretAccessKey: yield* options?.secretAccessKey ?? optional(Config.Redacted("AWS_SECRET_ACCESS_KEY")),
        sessionToken: yield* options?.sessionToken ?? optional(Config.Redacted("AWS_SESSION_TOKEN")),
        apiKey: yield* options?.apiKey ?? optional(Config.Redacted("AWS_BEARER_TOKEN_BEDROCK")),
        credentials: options?.credentials,
        transformClient: options?.transformClient
      })
    })
  )

const optional = <A>(config: Config.Config<A>): Config.Config<A | undefined> => Config.withDefault(config, undefined)
