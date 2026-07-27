import { OpenRouterClient } from "@effect/ai-openrouter"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Redacted, type Schema } from "effect"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

describe("OpenRouterClient", () => {
  it.effect("redacts the API key in AI error context", () =>
    Effect.gen(function*() {
      const client = yield* OpenRouterClient.OpenRouterClient

      const result = yield* client.createChatCompletion({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }]
      }).pipe(Effect.flip)

      assert.strictEqual(result.reason._tag, "InvalidRequestError")
      if (result.reason._tag !== "InvalidRequestError" || result.reason.http === undefined) {
        return yield* Effect.die(new Error("Expected InvalidRequestError with HTTP context"))
      }
      const requests = yield* MockHttpClient.requests
      assert.include(requests[0]?.url, "/chat/completions")
      assert.strictEqual(String(result.reason.http.request.headers["authorization"]), "<redacted>")
    }).pipe(Effect.provide(makeTestLayer({
      _tag: "Json",
      status: 400,
      body: {
        error: {
          code: 400,
          message: "Bad request"
        }
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

class MockOpenRouterResponse extends Context.Service<MockOpenRouterResponse, {
  readonly response: MockResponse
}>()("MockOpenRouterResponse") {}

class MockHttpClient extends Context.Service<MockHttpClient, {
  readonly requests: Effect.Effect<ReadonlyArray<HttpClientRequest.HttpClientRequest>>
}>()("MockHttpClient") {
  static requests = MockHttpClient.use((client) => client.requests)
}

const makeHttpClientContext = Effect.gen(function*() {
  const capturedRequests: Array<HttpClientRequest.HttpClientRequest> = []
  const mock = yield* MockOpenRouterResponse

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
  options: OpenRouterClient.Options = { apiKey: Redacted.make("sk-test-key") }
) =>
  OpenRouterClient.layer(options).pipe(
    Layer.provideMerge(HttpClientLayer),
    Layer.provide(Layer.succeed(MockOpenRouterResponse, { response }))
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
