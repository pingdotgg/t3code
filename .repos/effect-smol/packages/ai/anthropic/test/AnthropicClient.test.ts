import { AnthropicClient } from "@effect/ai-anthropic"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Redacted, type Schema } from "effect"
import {
  Headers,
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"

describe("AnthropicClient", () => {
  it.effect("redacts the API key in AI error context", () =>
    Effect.gen(function*() {
      const client = yield* AnthropicClient.AnthropicClient

      const result = yield* client.createMessage({
        payload: {
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "hello" }]
        }
      }).pipe(
        Effect.flip,
        Effect.updateService(Headers.CurrentRedactedNames, () => [])
      )

      assert.strictEqual(result.reason._tag, "InvalidRequestError")
      if (result.reason._tag !== "InvalidRequestError" || result.reason.http === undefined) {
        return yield* Effect.die(new Error("Expected InvalidRequestError with HTTP context"))
      }
      const requests = yield* MockHttpClient.requests
      assert.include(requests[0]?.url, "/v1/messages")
      assert.strictEqual(String(result.reason.http.request.headers["x-api-key"]), "<redacted>")
    }).pipe(Effect.provide(makeTestLayer({
      _tag: "Json",
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Bad request"
        },
        request_id: null
      }
    }))))
})

type MockResponse =
  | {
    readonly _tag: "Json"
    readonly body: Schema.Json
    readonly status?: number | undefined
    readonly headers?: Record<string, string> | undefined
  }
  | {
    readonly _tag: "Sse"
    readonly events: ReadonlyArray<Schema.Json>
    readonly status?: number | undefined
    readonly headers?: Record<string, string> | undefined
  }

class MockAnthropicResponse extends Context.Service<MockAnthropicResponse, {
  readonly response: MockResponse
}>()("MockAnthropicResponse") {}

class MockHttpClient extends Context.Service<MockHttpClient, {
  readonly requests: Effect.Effect<ReadonlyArray<HttpClientRequest.HttpClientRequest>>
}>()("MockHttpClient") {
  static requests = MockHttpClient.use((client) => client.requests)
}

const makeHttpClientContext = Effect.gen(function*() {
  const capturedRequests: Array<HttpClientRequest.HttpClientRequest> = []
  const mock = yield* MockAnthropicResponse

  const httpClient = HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      capturedRequests.push(request)
      return makeResponse(request, mock.response)
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )

  const mockHttpClient: MockHttpClient["Service"] = {
    requests: Effect.sync(() => capturedRequests)
  }

  return Context.make(HttpClient.HttpClient, httpClient).pipe(
    Context.add(MockHttpClient, mockHttpClient)
  )
})

const HttpClientLayer = Layer.effectContext(makeHttpClientContext)

const makeTestLayer = (
  response: MockResponse,
  options: AnthropicClient.Options = { apiKey: Redacted.make("sk-test-key") }
) =>
  AnthropicClient.layer(options).pipe(
    Layer.provideMerge(HttpClientLayer),
    Layer.provide(Layer.succeed(MockAnthropicResponse, { response }))
  )

const makeResponse = (
  request: HttpClientRequest.HttpClientRequest,
  response: MockResponse
): HttpClientResponse.HttpClientResponse => {
  const contentType = response._tag === "Json"
    ? "application/json"
    : "text/event-stream"
  const body = response._tag === "Json"
    ? JSON.stringify(response.body)
    : response.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status: response.status ?? 200,
      headers: {
        "content-type": contentType,
        ...response.headers
      }
    })
  )
}
