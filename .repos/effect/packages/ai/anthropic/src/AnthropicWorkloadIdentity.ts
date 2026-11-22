/**
 * The `AnthropicWorkloadIdentity` module authenticates `AnthropicClient` with
 * [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation).
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

const OAUTH_BETA = "oauth-2025-04-20"
const FEDERATION_BETA = "oidc-federation-2026-04-01"

const withOAuthBeta = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
  const betas = request.headers["anthropic-beta"]?.split(",").map((beta) => beta.trim()).filter(Boolean) ?? []
  return betas.includes(OAUTH_BETA)
    ? request
    : HttpClientRequest.setHeader(request, "anthropic-beta", [...betas, OAUTH_BETA].join(","))
}

/**
 * Options for authenticating Anthropic requests with Workload Identity
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
   * Tagged ID (`fdrl_...`) of the federation rule to evaluate.
   */
  readonly federationRuleId: string
  /**
   * UUID of the Anthropic organization.
   */
  readonly organizationId: string
  /**
   * Tagged ID (`svac_...`) of the service account the token acts as.
   */
  readonly serviceAccountId?: string | undefined
  /**
   * Tagged ID (`wrkspc_...`) of the workspace to scope the token to. Required
   * when the federation rule is enabled for more than one workspace.
   */
  readonly workspaceId?: string | undefined
  /**
   * The base URL of the Anthropic API, used for the token exchange. Pass the
   * same value as the `apiUrl` option of `AnthropicClient`.
   *
   * @default "https://api.anthropic.com"
   */
  readonly apiUrl?: string | undefined
}

/**
 * Creates an `HttpClient` transform that authenticates Anthropic requests with
 * Workload Identity Federation.
 *
 * **When to use**
 *
 * Use as the `transformClient` option of `AnthropicClient` instead of an API key.
 *
 * **Details**
 *
 * The first request runs `identityToken` and exchanges the result at
 * `${apiUrl}/v1/oauth/token` with the `jwt-bearer` grant. The access token is
 * cached and sent as `Authorization: Bearer` with the `oauth-2025-04-20` beta
 * until shortly before it expires. Concurrent requests share one exchange.
 * `identityToken` runs again on every exchange, so a token read from a file is
 * picked up after it rotates. Surrounding whitespace is trimmed.
 *
 * Exchanges use the `HttpClient` captured by `make`, not the transformed client.
 * Failures are `HttpClientError`s, mapped to `AiError` by `AnthropicClient`.
 * A failing or empty `identityToken` produces an `EncodeError`. Source failures
 * are preserved as causes and must not contain secrets. Exchange errors redact
 * the literal identity token, including JSON-escaped occurrences.
 *
 * **Gotchas**
 *
 * - No background refresh: the next request after expiry waits for an exchange.
 * - A 401 invalidates only the token used by that request, without replay.
 * - The exchange client must not follow redirects or log request bodies.
 *   `FetchHttpClient` redirects are disabled; redirect responses fail the exchange.
 * - Anthropic accepts an identity token with a `jti` claim once, so the
 *   exchange is never retried and `identityToken` must yield a new token for
 *   each exchange.
 * - The token URL must use `https`, or `http` on `localhost`, `127.0.0.1` or
 *   `::1`. Any other URL is a defect.
 * - Leave the `apiKey` option of `AnthropicClient` unset.
 *
 * **Example** (Reading a projected Kubernetes token)
 *
 * ```ts
 * import { AnthropicClient, AnthropicWorkloadIdentity } from "@effect/ai-anthropic"
 * import { Effect, FileSystem, Layer, Redacted } from "effect"
 *
 * // Provide an `HttpClient` and a `FileSystem` to this layer.
 * const AnthropicLayer = Layer.unwrap(Effect.gen(function*() {
 *   const fs = yield* FileSystem.FileSystem
 *   const transformClient = yield* AnthropicWorkloadIdentity.make({
 *     identityToken: Effect.map(
 *       fs.readFileString("/var/run/secrets/anthropic.com/token"),
 *       Redacted.make
 *     ),
 *     federationRuleId: "fdrl_...",
 *     organizationId: "00000000-0000-0000-0000-000000000000",
 *     serviceAccountId: "svac_..."
 *   })
 *   return AnthropicClient.layer({ transformClient })
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
  Effect.map(
    WorkloadIdentity.make({
      tokenUrl: `${options.apiUrl ?? "https://api.anthropic.com"}/v1/oauth/token`,
      identityToken: options.identityToken,
      exchangeRequest: (request, assertion) =>
        request.pipe(
          HttpClientRequest.setHeader("anthropic-beta", `${OAUTH_BETA},${FEDERATION_BETA}`),
          HttpClientRequest.bodyJsonUnsafe({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
            federation_rule_id: options.federationRuleId,
            organization_id: options.organizationId,
            service_account_id: options.serviceAccountId,
            workspace_id: options.workspaceId
          })
        )
    }),
    (transform) => (client) => transform(HttpClient.mapRequest(client, withOAuthBeta))
  )

/**
 * Provides the current `HttpClient` authenticated with workload identity federation.
 *
 * **When to use**
 *
 * Use with `Layer.provide` to authenticate `AnthropicClient` without
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
 *   layer only to `AnthropicClient`, not the whole application.
 * - The gotchas of `make` apply.
 *
 * **Example** (Providing an authenticated client to `AnthropicClient`)
 *
 * ```ts
 * import { AnthropicClient, AnthropicWorkloadIdentity } from "@effect/ai-anthropic"
 * import { Effect, FileSystem, Layer, Redacted } from "effect"
 *
 * const WorkloadIdentity = AnthropicWorkloadIdentity.layer({
 *   identityToken: Effect.gen(function*() {
 *     const fs = yield* FileSystem.FileSystem
 *     return Redacted.make(yield* fs.readFileString("/var/run/secrets/anthropic.com/token"))
 *   }),
 *   federationRuleId: "fdrl_...",
 *   organizationId: "00000000-0000-0000-0000-000000000000",
 *   serviceAccountId: "svac_..."
 * })
 *
 * // Requires an `HttpClient` and a `FileSystem`.
 * const AnthropicLayer = AnthropicClient.layer({}).pipe(
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
