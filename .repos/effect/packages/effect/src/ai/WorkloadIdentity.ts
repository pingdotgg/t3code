/**
 * Authenticates an `HttpClient` by exchanging workload identity tokens for cached
 * access tokens. For Anthropic, OpenAI or OpenRouter, use the provider package's
 * `AnthropicWorkloadIdentity`, `OpenAiWorkloadIdentity` or
 * `OpenRouterWorkloadIdentity` module.
 *
 * @stability unstable
 * @since 4.1.3
 */
import * as Cache from "../Cache.ts"
import * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import * as Exit from "../Exit.ts"
import * as FetchHttpClient from "../http/FetchHttpClient.ts"
import * as HttpClient from "../http/HttpClient.ts"
import * as HttpClientError from "../http/HttpClientError.ts"
import * as HttpClientRequest from "../http/HttpClientRequest.ts"
import * as HttpClientResponse from "../http/HttpClientResponse.ts"
import * as Option from "../Option.ts"
import * as Redacted from "../Redacted.ts"
import * as Schema from "../Schema.ts"
import * as Stream from "../Stream.ts"

const MAX_RESPONSE_BYTES = 1024 * 1024
const cacheKey = "accessToken"

const decodeTokenResponse = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  // Printable ASCII only, so the token is safe to send in a header.
  access_token: Schema.String.check(Schema.isPattern(/^[\x21-\x7E]+$/)),
  expires_in: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0)))
})))

const checkTokenUrl = (url: string): Effect.Effect<void> =>
  Effect.sync(() => {
    const { hostname, protocol } = new URL(url)
    if (protocol === "https:") return
    if (protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return
    throw new Error(`Refusing to send an identity token to the non-https token URL "${url}"`)
  })

// Keep only messages: errors may reference requests containing the identity token.
const errorMessages = (error: unknown): Array<string> => {
  const messages: Array<string> = []
  for (let cause = error, depth = 0; cause instanceof Error && depth < 5; cause = cause.cause, depth++) {
    if (cause.message !== "") messages.push(cause.message)
  }
  return messages
}

// Decode escaped tokens before redacting values; the second pass covers keys.
const redactBody = (body: string, redact: (text: string) => string): string => {
  try {
    return redact(JSON.stringify(JSON.parse(body, (_, value) => typeof value === "string" ? redact(value) : value)))
  } catch {
    return redact(body)
  }
}

// Resolves to `undefined` when the body is missing, unreadable or over the limit.
const readBody = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<string | undefined> =>
  Effect.suspend(() => {
    let size = 0
    return response.stream.pipe(
      Stream.takeWhile((chunk) => (size += chunk.length) <= MAX_RESPONSE_BYTES),
      Stream.decodeText(),
      Stream.mkString,
      Effect.map((body) => size > MAX_RESPONSE_BYTES ? undefined : body),
      Effect.orElseSucceed(() => undefined)
    )
  })

/**
 * Creates an `HttpClient` transform that authenticates requests with an access
 * token obtained by exchanging an identity token at a token endpoint.
 *
 * **When to use**
 *
 * Use to add workload identity federation to a provider client whose token
 * endpoint answers a `POST` request with a JSON object holding an
 * `access_token` and an `expires_in` number of seconds.
 *
 * **Details**
 *
 * Each exchange reruns `identityToken` and passes its trimmed value and a JSON-
 * accepting `POST` request to `exchangeRequest`. The response's `access_token`
 * is sent as `Authorization: Bearer`. Its lifetime is `expires_in` seconds,
 * falling back to `defaultExpiresIn` when absent.
 *
 * Tokens are cached until 30 seconds before expiry or three quarters of their
 * lifetime, whichever is later. Concurrent requests share one exchange;
 * interrupting a waiter does not cancel it.
 *
 * Exchanges use the `HttpClient` captured by `make`, not the transformed client.
 * Failures are `HttpClientError`s: `StatusCodeError` for rejected exchanges,
 * `TransportError` for transport failures or redirects, `DecodeError` for
 * invalid responses, and `EncodeError` for failing or empty identity tokens.
 * Identity-token source failures are preserved as causes and must not contain
 * secrets.
 *
 * Exchange errors omit the request body and retain only transport error
 * messages. The literal identity token is redacted from those messages and
 * rejection headers and bodies, including JSON-escaped occurrences.
 *
 * **Gotchas**
 *
 * - No background refresh: the next request after expiry waits for an exchange.
 * - A 401 invalidates only the token used by that request, without replay.
 * - The exchange is never retried.
 * - Every request carries the access token regardless of URL.
 * - The exchange client must not follow redirects or log request bodies.
 *   `FetchHttpClient` redirects are disabled; redirect responses fail the exchange.
 * - `tokenUrl` must use `https`, or `http` on `localhost`, `127.0.0.1` or
 *   `::1`. Any other URL is a defect.
 * - `exchangeRequest` may change only the body and headers; other changes are
 *   defects and send nothing. Put query parameters in `tokenUrl`.
 * - `defaultExpiresIn` must be positive and finite or `make` defects.
 *   Numeric durations are milliseconds; response `expires_in` is seconds.
 * - Only the literal identity token is redacted, after JSON decoding. A token
 *   endpoint that echoes it in another encoding is not covered.
 * - The response is limited to 1 MiB, and the access token to printable ASCII.
 *
 * **Example** (Exchanging a token at an RFC 8693 style endpoint)
 *
 * ```ts
 * import { Effect, FileSystem, Redacted } from "effect"
 * import { WorkloadIdentity } from "effect/ai"
 * import { HttpClientRequest } from "effect/http"
 *
 * // Requires an `HttpClient` for the exchange, and a `FileSystem`.
 * const transformClient = WorkloadIdentity.make({
 *   tokenUrl: "https://auth.example.com/oauth/token",
 *   identityToken: Effect.gen(function*() {
 *     const fs = yield* FileSystem.FileSystem
 *     return Redacted.make(yield* fs.readFileString("/var/run/secrets/example.com/token"))
 *   }),
 *   exchangeRequest: (request, identityToken) =>
 *     request.pipe(HttpClientRequest.bodyJsonUnsafe({
 *       grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
 *       subject_token: identityToken,
 *       subject_token_type: "urn:ietf:params:oauth:token-type:jwt"
 *     })),
 *   defaultExpiresIn: "1 hour"
 * })
 * ```
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const make = <E = never, R = never>(options: {
  /**
   * The URL of the token endpoint.
   */
  readonly tokenUrl: string
  /**
   * Produces the identity token to exchange. Runs again on every exchange.
   */
  readonly identityToken: Effect.Effect<Redacted.Redacted<string>, E, R>
  /**
   * Completes the exchange request with the identity token. `request` is a
   * `POST` request to `tokenUrl` that accepts JSON, and `identityToken` is
   * the trimmed token. Runs on every exchange.
   *
   * Set the body and headers only. Changing the method, URL, URL parameters or
   * hash is a defect, so the identity token is only sent to `tokenUrl`.
   */
  readonly exchangeRequest: (
    request: HttpClientRequest.HttpClientRequest,
    identityToken: string
  ) => HttpClientRequest.HttpClientRequest
  /**
   * The lifetime of an access token when the token response has no
   * `expires_in`. Without it, such a response fails the exchange. An
   * `expires_in` in the response takes precedence.
   *
   * Must be positive and finite. A number is milliseconds.
   */
  readonly defaultExpiresIn?: Duration.Input | undefined
}): Effect.Effect<
  (client: HttpClient.HttpClient) => HttpClient.HttpClient,
  never,
  HttpClient.HttpClient | R
> =>
  Effect.gen(function*() {
    const tokenUrl = options.tokenUrl
    yield* checkTokenUrl(tokenUrl)
    const httpClient = yield* HttpClient.HttpClient
    const defaultExpiresIn = options.defaultExpiresIn === undefined
      ? undefined
      : Duration.toSeconds(options.defaultExpiresIn)
    if (defaultExpiresIn !== undefined && !(defaultExpiresIn > 0 && defaultExpiresIn < Infinity)) {
      return yield* Effect.die(new Error("`defaultExpiresIn` must be a positive finite duration"))
    }

    // Errors must not retain the exchange request body.
    const errorRequest = HttpClientRequest.post(tokenUrl)
    const preparedRequest = HttpClientRequest.acceptJson(errorRequest)
    const requestError = (description: string) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request: errorRequest, description })
      })
    const identityTokenError = (description: string, cause?: unknown) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.EncodeError({ request: errorRequest, description, cause })
      })

    const exchange = Effect.gen(function*() {
      const identityToken = Redacted.value(
        yield* Effect.mapError(
          options.identityToken,
          (cause) => identityTokenError("Failed to load the identity token", cause)
        )
      ).trim()
      if (identityToken === "") {
        return yield* identityTokenError("The identity token is empty")
      }
      const redact = (text: string) => text.replaceAll(identityToken, "<redacted>")
      const errorResponse = (response: HttpClientResponse.HttpClientResponse, body?: string) =>
        HttpClientResponse.fromWeb(
          errorRequest,
          new Response(body === undefined ? null : redactBody(body, redact), {
            status: response.status,
            headers: Object.entries(response.headers).map(([name, value]): [string, string] => [name, redact(value)])
          })
        )
      const invalidResponse = (response: HttpClientResponse.HttpClientResponse) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({
            request: errorRequest,
            response: errorResponse(response),
            description: "The token endpoint returned an invalid token response"
          })
        })
      const request = options.exchangeRequest(preparedRequest, identityToken)
      // Keep the identity token confined to the validated endpoint.
      if (
        request.method !== preparedRequest.method || request.url !== preparedRequest.url ||
        request.urlParams.params.length > 0 || Option.isSome(request.hash)
      ) {
        return yield* Effect.die(
          new Error(
            `\`exchangeRequest\` must keep the method, URL, URL parameters and hash of the "POST ${tokenUrl}" request`
          )
        )
      }
      const fetchInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit)
      const response = yield* httpClient.execute(request).pipe(
        // Prevent redirects from forwarding the identity token.
        Effect.provideService(FetchHttpClient.RequestInit, { ...Option.getOrUndefined(fetchInit), redirect: "manual" }),
        Effect.catch((error) =>
          error.response === undefined
            ? Effect.fail(requestError(
              redact([error.reason.description, ...errorMessages(error.cause)].filter(Boolean).join(": ")) ||
                "Failed to reach the token endpoint"
            ))
            : Effect.succeed(error.response)
        )
      )
      const status = response.status
      // Fetch may report manual redirects as opaque responses with status 0.
      if (status < 200 || status >= 600 || (status >= 300 && status < 400)) {
        return yield* requestError(
          `The token endpoint responded with the status ${status}. Redirects are not followed`
        )
      }
      const body = yield* readBody(response)
      if (status >= 300) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.StatusCodeError({
            request: errorRequest,
            response: errorResponse(response, body)
          })
        })
      }
      const token = decodeTokenResponse(body)
      if (Option.isNone(token)) {
        return yield* invalidResponse(response)
      }
      const expiresIn = token.value.expires_in ?? defaultExpiresIn
      if (expiresIn === undefined) {
        return yield* invalidResponse(response)
      }
      return { value: Redacted.make(token.value.access_token), expiresIn }
    })

    const cache = yield* Cache.makeWith((_: typeof cacheKey) => exchange, {
      capacity: 1,
      // Stop using a token up to 30 seconds early to allow for clock differences
      // and request latency. Failed exchanges are not cached.
      timeToLive: (exit) =>
        Exit.isSuccess(exit)
          ? Duration.seconds(Math.max(exit.value.expiresIn - 30, exit.value.expiresIn * 0.75))
          : Duration.zero
    })

    const invalidate = (request: HttpClientRequest.HttpClientRequest) =>
      Cache.invalidateWhen(
        cache,
        cacheKey,
        (token) => request.headers.authorization === `Bearer ${Redacted.value(token.value)}`
      )

    return (client) =>
      client.pipe(
        HttpClient.mapRequestEffect((request) =>
          Effect.map(
            Cache.get(cache, cacheKey),
            (token) => HttpClientRequest.bearerToken(request, token.value)
          )
        ),
        HttpClient.transformResponse((effect) =>
          effect.pipe(
            Effect.tap((response) => response.status === 401 ? invalidate(response.request) : Effect.void),
            Effect.tapError((error) => error.response?.status === 401 ? invalidate(error.request) : Effect.void)
          )
        )
      )
  })
