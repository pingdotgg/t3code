import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Redacted } from "effect"
import { WorkloadIdentity } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"

const IDENTITY_TOKEN = "identity.token.signature"
const TOKEN_URL = "https://auth.example.com/oauth/token"
const API_URL = "https://api.example.com/v1/models"

describe("WorkloadIdentity", () => {
  it.effect("exchanges a new identity token once the access token is about to expire", () =>
    Effect.gen(function*() {
      let identityTokens = 0
      const http = makeHttp()
      const client = yield* makeClient(http, {
        identityToken: Effect.sync(() => Redacted.make(`identity-${++identityTokens}`))
      })

      yield* client.get(API_URL)
      yield* TestClock.adjust("3569 seconds")
      yield* client.get(API_URL)
      yield* TestClock.adjust("1 second")
      yield* client.get(API_URL)

      assert.deepStrictEqual(authorizations(http), [
        undefined,
        "Bearer access-1",
        "Bearer access-1",
        undefined,
        "Bearer access-2"
      ])
      assert.deepStrictEqual(bodyJson(http.requests[3]), { subject_token: "identity-2" })
    }))

  it.effect("discards only the access token a 401 rejected, without replaying the request", () =>
    Effect.gen(function*() {
      const latch = yield* Deferred.make<void>()
      const http = makeHttp({
        api: (request) =>
          Effect.as(
            request.url.endsWith("/slow") ? Deferred.await(latch) : Effect.void,
            new Response(null, { status: request.headers.authorization === "Bearer access-1" ? 401 : 200 })
          )
      })
      const client = yield* makeClient(http)
      const status = (url: string) => Effect.map(client.get(url), (response) => response.status)

      const slow = yield* Effect.forkChild(status(`${API_URL}/slow`), { startImmediately: true })
      assert.strictEqual(yield* status(API_URL), 401)
      assert.strictEqual(yield* status(API_URL), 200)
      // The late rejection of the first token must not discard the second one.
      yield* Deferred.succeed(latch, void 0)
      assert.strictEqual(yield* Fiber.join(slow), 401)
      assert.strictEqual(yield* status(API_URL), 200)

      assert.deepStrictEqual(authorizations(http), [
        undefined,
        "Bearer access-1",
        "Bearer access-1",
        undefined,
        "Bearer access-2",
        "Bearer access-2"
      ])
    }))

  it.effect("discards a rejected access token when the client fails on error statuses", () =>
    Effect.gen(function*() {
      const http = makeHttp({
        api: (request) =>
          Effect.succeed(
            new Response(null, { status: request.headers.authorization === "Bearer access-1" ? 401 : 200 })
          )
      })
      const transform = yield* make(http)
      const client = transform(HttpClient.filterStatusOk(http.client))

      yield* Effect.flip(client.get(API_URL))
      yield* client.get(API_URL)

      assert.deepStrictEqual(authorizations(http), [undefined, "Bearer access-1", undefined, "Bearer access-2"])
    }))

  it.effect("redacts the identity token from a rejected exchange", () =>
    Effect.gen(function*() {
      const http = makeHttp({
        token: () =>
          Effect.succeed(
            new Response(
              JSON.stringify({ message: `Authentication failed for ${IDENTITY_TOKEN}`, [IDENTITY_TOKEN]: true })
                .replaceAll(".", "\\u002e"),
              {
                status: 401,
                headers: { "www-authenticate": `Bearer error_description="${IDENTITY_TOKEN}"` }
              }
            )
          )
      })

      const error = yield* Effect.flip((yield* makeClient(http)).get(API_URL))

      const response = error.response
      if (response === undefined) return assert.fail("Expected a response")
      assert.strictEqual(response.status, 401)
      assert.strictEqual(response.headers["www-authenticate"], "Bearer error_description=\"<redacted>\"")
      assert.strictEqual(
        yield* response.text,
        "{\"message\":\"Authentication failed for <redacted>\",\"<redacted>\":true}"
      )
      assert.isFalse(contains(error, IDENTITY_TOKEN))
    }))

  it.effect("keeps only the redacted messages of a transport failure", () =>
    Effect.gen(function*() {
      const http = makeHttp({
        token: (request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: `failed to send ${IDENTITY_TOKEN}`,
                cause: new Error("socket hang up", { cause: { request } })
              })
            })
          )
      })

      const error = yield* Effect.flip((yield* makeClient(http)).get(API_URL))

      assert.strictEqual(error.reason._tag, "TransportError")
      assert.include(error.message, "failed to send <redacted>: socket hang up")
      assert.isFalse(contains(error, IDENTITY_TOKEN))
    }))

  it.effect("fails with the identity token source failure as the cause, without an exchange", () =>
    Effect.gen(function*() {
      const cause = new Error("ENOENT")
      const http = makeHttp()

      const error = yield* Effect.flip((yield* makeClient(http, { identityToken: Effect.fail(cause) })).get(API_URL))

      assert.strictEqual(error.reason._tag, "EncodeError")
      assert.strictEqual(error.reason.cause, cause)
      assert.lengthOf(http.requests, 0)
    }))

  it.effect("does not follow a redirect of the exchange", () =>
    Effect.gen(function*() {
      const redirects: Array<RequestRedirect | undefined> = []
      const transform = yield* WorkloadIdentity.make({
        tokenUrl: TOKEN_URL,
        identityToken: Effect.succeed(Redacted.make(IDENTITY_TOKEN)),
        exchangeRequest
      })
      const client = transform(yield* HttpClient.HttpClient)

      const error = yield* Effect.flip(client.get(API_URL)).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          Object.assign((_input: RequestInfo | URL, init?: RequestInit) => {
            redirects.push(init?.redirect)
            return Promise.resolve(new Response(null, { status: 307, headers: { location: "https://example.com" } }))
          }, { preconnect: () => {} })
        )
      )

      assert.deepStrictEqual(redirects, ["manual"])
      assert.strictEqual(error.reason._tag, "TransportError")
      assert.isFalse(contains(error, IDENTITY_TOKEN))
    }).pipe(Effect.provide(FetchHttpClient.layer)))
})

type Options = Parameters<typeof WorkloadIdentity.make<Error, never>>[0]

type Http = ReturnType<typeof makeHttp>

const tokenResponse = (n: number) => Response.json({ access_token: `access-${n}`, expires_in: 3600 })

const makeHttp = (handlers: {
  readonly token?: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>
  readonly api?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response>
} = {}) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  let exchanges = 0
  const client = HttpClient.make((request) => {
    requests.push(request)
    const response = request.url === TOKEN_URL
      ? handlers.token?.(request) ?? Effect.succeed(tokenResponse(++exchanges))
      : handlers.api?.(request) ?? Effect.succeed(new Response())
    return Effect.map(response, (response) => HttpClientResponse.fromWeb(request, response))
  })
  return { client, requests }
}

const exchangeRequest: Options["exchangeRequest"] = (request, identityToken) =>
  request.pipe(HttpClientRequest.bodyJsonUnsafe({ subject_token: identityToken }))

const make = (http: Http, options: Partial<Options> = {}) =>
  WorkloadIdentity.make({
    tokenUrl: TOKEN_URL,
    identityToken: Effect.succeed(Redacted.make(IDENTITY_TOKEN)),
    exchangeRequest,
    ...options
  }).pipe(Effect.provideService(HttpClient.HttpClient, http.client))

const makeClient = (http: Http, options?: Partial<Options>) =>
  Effect.map(make(http, options), (transform) => transform(http.client))

const authorizations = (http: Http) => http.requests.map((request) => request.headers.authorization)

const bodyJson = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined

// Searches every string and byte array reachable from `value`, including error causes.
const contains = (value: unknown, text: string, seen = new Set<unknown>()): boolean => {
  if (typeof value === "string") return value.includes(text)
  if (value instanceof Uint8Array) return new TextDecoder().decode(value).includes(text)
  if (typeof value !== "object" || value === null || seen.has(value)) return false
  seen.add(value)
  return [String(value), ...Reflect.ownKeys(value).map((key) => Reflect.get(value, key))]
    .some((child) => contains(child, text, seen))
}
