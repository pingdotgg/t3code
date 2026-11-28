/**
 * The `OpenRouterWorkloadIdentity` module authenticates `OpenRouterClient` with
 * [workload identity federation](https://openrouter.ai/docs/guides/overview/auth/workload-identity-federation).
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
 * Options for authenticating OpenRouter requests with workload identity
 * federation.
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
   * ID of the OpenRouter federation policy to evaluate.
   */
  readonly federationPolicyId: string
  /**
   * The base URL of the OpenRouter API, used for the token exchange. Pass the
   * same value as the `apiUrl` option of `OpenRouterClient`.
   *
   * @default "https://openrouter.ai/api/v1"
   */
  readonly apiUrl?: string | undefined
}

/**
 * Creates an `HttpClient` transform that authenticates OpenRouter requests with
 * workload identity federation.
 *
 * **When to use**
 *
 * Use as the `transformClient` option of `OpenRouterClient` instead of an API
 * key.
 *
 * **Details**
 *
 * The first request runs `identityToken` and exchanges the result at
 * `{apiUrl}/oauth/token` with the RFC 8693 `token-exchange` grant and the
 * `inference` scope. The access token is cached and sent as
 * `Authorization: Bearer` until shortly before it expires. Concurrent requests
 * share one exchange. `identityToken` runs again on every exchange, so a token
 * read from a file is picked up after it rotates. Surrounding whitespace is
 * trimmed.
 *
 * Exchanges use the `HttpClient` captured by `make`, not the transformed client.
 * Failures are `HttpClientError`s, mapped to `AiError` by `OpenRouterClient`.
 * A failing or empty `identityToken` produces an `EncodeError`. Source failures
 * are preserved as causes and must not contain secrets. Exchange errors redact
 * the literal identity token, including JSON-escaped occurrences.
 *
 * **Gotchas**
 *
 * - The identity token must be a JWT. OIDC ID tokens are JWTs.
 * - The federation policy must grant the `inference` scope. A policy that acts
 *   as a management key is rejected.
 * - No background refresh: the next request after expiry waits for an exchange.
 * - A 401 invalidates only the token used by that request, without replay.
 * - The exchange client must not follow redirects or log request bodies.
 *   `FetchHttpClient` redirects are disabled; redirect responses fail the exchange.
 * - The exchange is never retried.
 * - The token URL must use `https`, or `http` on `localhost`, `127.0.0.1` or
 *   `::1`. Any other URL is a defect.
 * - Leave the `apiKey` option of `OpenRouterClient` unset. The access token
 *   replaces it.
 *
 * **Example** (Reading a projected Kubernetes token)
 *
 * ```ts
 * import { OpenRouterClient, OpenRouterWorkloadIdentity } from "@effect/ai-openrouter"
 * import { Effect, FileSystem, Layer, Redacted } from "effect"
 *
 * // Provide an `HttpClient` and a `FileSystem` to this layer.
 * const OpenRouterLayer = Layer.unwrap(Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *   const transformClient = yield* OpenRouterWorkloadIdentity.make({
 *     identityToken: Effect.map(
 *       fs.readFileString("/var/run/secrets/openrouter.ai/token"),
 *       Redacted.make
 *     ),
 *     federationPolicyId: "..."
 *   })
 *   return OpenRouterClient.layer({ transformClient })
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
    tokenUrl: `${(options.apiUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "")}/oauth/token`,
    identityToken: options.identityToken,
    exchangeRequest: (request, subjectToken) =>
      HttpClientRequest.bodyUrlParams(request, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: subjectToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        federation_policy_id: options.federationPolicyId,
        scope: "inference"
      })
  })

/**
 * Provides the current `HttpClient` authenticated with workload identity federation.
 *
 * **When to use**
 *
 * Use with `Layer.provide` to authenticate `OpenRouterClient` without
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
 *   layer only to `OpenRouterClient`, not the whole application.
 * - An `apiKey` option of `OpenRouterClient` replaces the access token here,
 *   so leave it unset.
 * - The other gotchas of `make` apply.
 *
 * **Example** (Providing an authenticated client to `OpenRouterClient`)
 *
 * ```ts
 * import { OpenRouterClient, OpenRouterWorkloadIdentity } from "@effect/ai-openrouter"
 * import { Effect, FileSystem, Layer, Redacted } from "effect"
 *
 * const WorkloadIdentity = OpenRouterWorkloadIdentity.layer({
 *   identityToken: Effect.gen(function*() {
 *     const fs = yield* FileSystem.FileSystem
 *     return Redacted.make(yield* fs.readFileString("/var/run/secrets/openrouter.ai/token"))
 *   }),
 *   federationPolicyId: "..."
 * })
 *
 * // Requires an `HttpClient` and a `FileSystem`.
 * const OpenRouterLayer = OpenRouterClient.layer({}).pipe(
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
