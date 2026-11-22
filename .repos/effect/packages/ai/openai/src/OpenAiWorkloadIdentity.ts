/**
 * The `OpenAiWorkloadIdentity` module authenticates `OpenAiClient` with
 * [workload identity federation](https://developers.openai.com/api/docs/guides/workload-identity-federation).
 *
 * @stability unstable
 * @since 4.1.3
 */
import * as WorkloadIdentity from "effect/ai/WorkloadIdentity"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"

/**
 * Options for authenticating OpenAI requests with Workload Identity
 * Federation.
 *
 * @see {@link make} for creating a client transform from these options
 * @see {@link layer} for providing a transformed `HttpClient` from these options
 *
 * @stability unstable
 * @category options
 * @since 4.1.3
 */
export type Options<E = never, R = never> = {
  /**
   * Produces the identity token to exchange. Runs again on every exchange.
   */
  readonly identityToken: Effect.Effect<Redacted.Redacted<string>, E, R>
  /**
   * Whether the identity token is a JWT or an OpenID Connect ID token.
   *
   * @default "jwt"
   */
  readonly identityTokenType?: "jwt" | "id_token" | undefined
  /**
   * ID of the workload identity provider registered with OpenAI.
   */
  readonly identityProviderId: string
  /**
   * ID of the service account the token acts as.
   */
  readonly serviceAccountId: string
  /**
   * The URL of the token endpoint.
   *
   * @default "https://auth.openai.com/oauth/token"
   */
  readonly tokenUrl?: string | undefined
}

/**
 * Creates an `HttpClient` transform that authenticates OpenAI requests with
 * workload identity federation.
 *
 * **When to use**
 *
 * Use as the `transformClient` option of `OpenAiClient` instead of an API key.
 *
 * **Details**
 *
 * The first request runs `identityToken` and exchanges the result at
 * `https://auth.openai.com/oauth/token` with the `token-exchange` grant. The
 * access token is cached and sent as `Authorization: Bearer` until shortly
 * before it expires. Concurrent requests share one exchange. `identityToken`
 * runs again on every exchange, so a token read from a file is picked up after
 * it rotates. Surrounding whitespace is trimmed.
 *
 * Exchanges use the `HttpClient` captured by `make`, not the transformed client.
 * Failures are `HttpClientError`s, mapped to `AiError` by `OpenAiClient`.
 * A failing or empty `identityToken` produces an `EncodeError`. Source failures
 * are preserved as causes and must not contain secrets. Exchange errors redact
 * the literal identity token, including JSON-escaped occurrences.
 *
 * In WebSocket mode the access token is resolved each time a socket connects.
 *
 * **Gotchas**
 *
 * - No background refresh: the next request after expiry waits for an exchange.
 * - A 401 invalidates only the token used by that request, without replay.
 * - A WebSocket keeps the token it connected with. A rejected WebSocket
 *   handshake does not discard the cached token, because the socket does not
 *   report the response status.
 * - The exchange client must not follow redirects or log request bodies.
 *   `FetchHttpClient` redirects are disabled; redirect responses fail the exchange.
 * - The exchange is never retried.
 * - The token URL must use `https`, or `http` on `localhost`, `127.0.0.1` or
 *   `::1`. Any other URL is a defect.
 * - Leave the `apiKey` option of `OpenAiClient` unset. The access token
 *   replaces it.
 * - The access token is not accepted by the Admin API.
 *
 * **Example** (Reading a projected Kubernetes token)
 *
 * ```ts
 * import { OpenAiClient, OpenAiWorkloadIdentity } from "@effect/ai-openai"
 * import { Effect, FileSystem, Layer, Redacted } from "effect"
 *
 * // Provide an `HttpClient` and a `FileSystem` to this layer.
 * const OpenAiLayer = Layer.unwrap(Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *   const transformClient = yield* OpenAiWorkloadIdentity.make({
 *     identityToken: Effect.map(
 *       fs.readFileString("/var/run/secrets/openai.com/token"),
 *       Redacted.make
 *     ),
 *     identityProviderId: "idp_...",
 *     serviceAccountId: "sa_..."
 *   })
 *   return OpenAiClient.layer({ transformClient })
 * }))
 * ```
 *
 * @see {@link layer} for providing the transformed `HttpClient` as a layer
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const make = <E = never, R = never>(options: Options<E, R>): Effect.Effect<
  (client: HttpClient.HttpClient) => HttpClient.HttpClient,
  never,
  HttpClient.HttpClient | R
> =>
  WorkloadIdentity.make({
    tokenUrl: options.tokenUrl ?? "https://auth.openai.com/oauth/token",
    identityToken: options.identityToken,
    exchangeRequest: (request, subjectToken) =>
      request.pipe(HttpClientRequest.bodyJsonUnsafe({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: subjectToken,
        subject_token_type: `urn:ietf:params:oauth:token-type:${options.identityTokenType ?? "jwt"}`,
        identity_provider_id: options.identityProviderId,
        service_account_id: options.serviceAccountId
      })),
    defaultExpiresIn: "1 hour"
  })

/**
 * Provides the current `HttpClient` authenticated with workload identity federation.
 *
 * **When to use**
 *
 * Use with `Layer.provide` to authenticate `OpenAiClient` without
 * setting its `transformClient` option.
 *
 * **Details**
 *
 * Applies `make` to the current client, which also performs token exchanges.
 * The layer requires the services needed by `identityToken`.
 *
 * **Gotchas**
 *
 * - Every request carries the access token regardless of URL. Provide this
 *   layer only to `OpenAiClient`, not the whole application.
 * - An `apiKey` option of `OpenAiClient` replaces the access token here, so
 *   leave it unset.
 * - The other gotchas of `make` apply.
 *
 * **Example** (Providing an authenticated client to `OpenAiClient`)
 *
 * ```ts
 * import { OpenAiClient, OpenAiWorkloadIdentity } from "@effect/ai-openai"
 * import { Effect, FileSystem, Layer, Redacted } from "effect"
 *
 * const WorkloadIdentity = OpenAiWorkloadIdentity.layer({
 *   identityToken: Effect.gen(function*() {
 *     const fs = yield* FileSystem.FileSystem
 *     return Redacted.make(yield* fs.readFileString("/var/run/secrets/openai.com/token"))
 *   }),
 *   identityProviderId: "idp_...",
 *   serviceAccountId: "sa_..."
 * })
 *
 * // Requires an `HttpClient` and a `FileSystem`.
 * const OpenAiLayer = OpenAiClient.layer({}).pipe(
 *   Layer.provide(WorkloadIdentity)
 * )
 * ```
 *
 * @see {@link make} for the client transform this layer applies
 *
 * @stability unstable
 * @category layers
 * @since 4.1.3
 */
export const layer = <E = never, R = never>(
  options: Options<E, R>
): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient | R> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const transform = yield* make(options)
      return transform(client)
    })
  )
