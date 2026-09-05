import type { OpenAiSchema } from "@effect/ai-openai"
import type * as Generated from "@effect/ai-openai/Generated"
import * as Errors from "@effect/ai-openai/internal/errors"
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient"
import * as OpenAiClientGenerated from "@effect/ai-openai/OpenAiClientGenerated"
import * as OpenAiConfig from "@effect/ai-openai/OpenAiConfig"
import { assert, describe, it } from "@effect/vitest"
import { Config, ConfigProvider, Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

describe("OpenAiClient", () => {
  describe("make", () => {
    it.effect("sets Bearer token from apiKey", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.createResponse({ model: "gpt-4o", input: "test" })

        const requests = yield* MockHttpClient.requests
        assert.strictEqual(requests[0]?.headers["authorization"], "Bearer sk-test-12345")
      }).pipe(Effect.provide(makeTestLayer({
        apiKey: Redacted.make("sk-test-12345")
      }))))

    it.effect("prepends default URL", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.createResponse({ model: "gpt-4o", input: "test" })

        const requests = yield* MockHttpClient.requests
        assert.isTrue(requests[0]?.url.startsWith("https://api.openai.com/v1"))
      }).pipe(Effect.provide(makeTestLayer())))

    it.effect("uses custom apiUrl when provided", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.createResponse({ model: "gpt-4o", input: "test" })

        const requests = yield* MockHttpClient.requests
        assert.isTrue(requests[0]?.url.startsWith("https://custom.api.com/v2"))
      }).pipe(Effect.provide(makeTestLayer({
        apiKey: Redacted.make("test-key"),
        apiUrl: "https://custom.api.com/v2"
      }))))

    it.effect("sets OpenAI-Organization header when organizationId provided", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.createResponse({ model: "gpt-4o", input: "test" })

        const requests = yield* MockHttpClient.requests
        assert.strictEqual(requests[0]?.headers["openai-organization"], "org-12345")
      }).pipe(Effect.provide(makeTestLayer({
        apiKey: Redacted.make("test-key"),
        organizationId: Redacted.make("org-12345")
      }))))

    it.effect("sets OpenAI-Project header when projectId provided", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.createResponse({ model: "gpt-4o", input: "test" })

        const requests = yield* MockHttpClient.requests
        assert.strictEqual(requests[0]?.headers["openai-project"], "proj-67890")
      }).pipe(Effect.provide(makeTestLayer({
        apiKey: Redacted.make("test-key"),
        projectId: Redacted.make("proj-67890")
      }))))

    it.effect("applies transformClient option", () => {
      let transformApplied = false
      return Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.createResponse({ model: "gpt-4o", input: "test" })
        assert.isTrue(transformApplied)
      }).pipe(Effect.provide(makeTestLayer({
        apiKey: Redacted.make("test-key"),
        transformClient: (client) => {
          transformApplied = true
          return client
        }
      })))
    })

    it.effect("exposes transformed HttpClient via client field", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.client.execute(HttpClientRequest.get("/responses"))

        const requests = yield* MockHttpClient.requests
        const request = requests[0]
        assert.isTrue(request?.url.startsWith("https://api.openai.com/v1"))
        assert.strictEqual(request?.headers["authorization"], "Bearer test-key")
        assert.strictEqual(request?.headers["x-client-field"], "enabled")
      }).pipe(Effect.provide(makeTestLayer({
        apiKey: Redacted.make("test-key"),
        transformClient: (client) =>
          client.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("x-client-field", "enabled")))
      }))))

    it.effect("applies OpenAiConfig transformClient after options transformClient", () => {
      let optionsTransformApplied = false
      let configTransformApplied = false

      return Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.createResponse({
          model: "gpt-4o",
          input: "test"
        }).pipe(
          OpenAiConfig.withClientTransform((client) => {
            configTransformApplied = true
            return client.pipe(
              HttpClient.mapRequest(HttpClientRequest.setHeader("x-openai-transform", "config"))
            )
          })
        )

        const requests = yield* MockHttpClient.requests
        assert.isTrue(optionsTransformApplied)
        assert.isTrue(configTransformApplied)
        assert.strictEqual(requests[0]?.headers["x-openai-transform"], "config")
      }).pipe(Effect.provide(makeTestLayer({
        apiKey: Redacted.make("test-key"),
        transformClient: (client) => {
          optionsTransformApplied = true
          return client.pipe(
            HttpClient.mapRequest(HttpClientRequest.setHeader("x-openai-transform", "options"))
          )
        }
      })))
    })
  })

  describe("OpenAiClientGenerated", () => {
    it.effect("sets Bearer token from apiKey", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClientGenerated.OpenAiClientGenerated
        yield* client.createResponse({
          payload: { model: "gpt-4o", input: "test" }
        })

        const requests = yield* MockHttpClient.requests
        assert.strictEqual(requests[0]?.headers["authorization"], "Bearer sk-generated-test")
      }).pipe(Effect.provide(makeGeneratedTestLayer({
        apiKey: Redacted.make("sk-generated-test")
      }))))

    it.effect("prepends custom apiUrl", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClientGenerated.OpenAiClientGenerated
        yield* client.createResponse({
          payload: { model: "gpt-4o", input: "test" }
        })

        const requests = yield* MockHttpClient.requests
        assert.isTrue(requests[0]?.url.startsWith("https://generated.example.test/v2"))
      }).pipe(Effect.provide(makeGeneratedTestLayer({
        apiKey: Redacted.make("test-key"),
        apiUrl: "https://generated.example.test/v2"
      }))))

    it.effect("applies OpenAiConfig transformClient after options transformClient", () => {
      let optionsTransformApplied = false
      let configTransformApplied = false

      return Effect.gen(function*() {
        const client = yield* OpenAiClientGenerated.OpenAiClientGenerated
        yield* client.createResponse({
          payload: { model: "gpt-4o", input: "test" }
        }).pipe(
          OpenAiConfig.withClientTransform((client) => {
            configTransformApplied = true
            return client.pipe(
              HttpClient.mapRequest(HttpClientRequest.setHeader("x-openai-transform", "config"))
            )
          })
        )

        const requests = yield* MockHttpClient.requests
        assert.isTrue(optionsTransformApplied)
        assert.isTrue(configTransformApplied)
        assert.strictEqual(requests[0]?.headers["x-openai-transform"], "config")
      }).pipe(Effect.provide(makeGeneratedTestLayer({
        apiKey: Redacted.make("test-key"),
        transformClient: (client) => {
          optionsTransformApplied = true
          return client.pipe(
            HttpClient.mapRequest(HttpClientRequest.setHeader("x-openai-transform", "options"))
          )
        }
      })))
    })
  })

  describe("layer", () => {
    it.effect("creates working service", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        assert.isNotNull(client.client)
      }).pipe(Effect.provide(makeTestLayer())))

    it.effect("layerConfig loads from Config", () => {
      const configProvider = ConfigProvider.fromEnv({
        env: {
          MY_API_KEY: "sk-config-key",
          MY_API_URL: "https://config.api.com/v1"
        }
      })

      return Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.createResponse({ model: "gpt-4o", input: "test" })

        const requests = yield* MockHttpClient.requests
        assert.strictEqual(requests[0]?.headers["authorization"], "Bearer sk-config-key")
        assert.isTrue(requests[0]?.url.startsWith("https://config.api.com/v1"))
      }).pipe(Effect.provide(makeConfigTestLayer(configProvider)))
    })
  })

  describe("request behavior", () => {
    it.effect("redacts OpenAI-specific headers in AI error context", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createResponse({
          model: "gpt-4o",
          input: "test"
        }).pipe(Effect.flip)

        assert.strictEqual(result.reason._tag, "InvalidRequestError")
        if (result.reason._tag !== "InvalidRequestError" || result.reason.http === undefined) {
          return yield* Effect.die(new Error("Expected InvalidRequestError with HTTP context"))
        }
        const headers = result.reason.http.request.headers
        assert.strictEqual(String(headers["authorization"]), "<redacted>")
        assert.strictEqual(String(headers["openai-organization"]), "<redacted>")
        assert.strictEqual(String(headers["openai-project"]), "<redacted>")
      }).pipe(Effect.provide(makeTestLayer({
        apiKey: Redacted.make("test-key"),
        organizationId: Redacted.make("org-secret"),
        projectId: Redacted.make("proj-secret")
      }, {
        _tag: "Json",
        status: 400,
        body: { error: { message: "Bad request" } }
      }))))
  })

  describe("error mapping", () => {
    it.effect("maps TransportError to NetworkError reason", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        })
        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.module, "OpenAiClient")
        assert.strictEqual(result.method, "createResponse")
        assert.strictEqual(result.reason._tag, "NetworkError")
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, makeTransportErrorHttpClient()))))

    it.effect("maps 400 status to InvalidRequestError reason", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.module, "OpenAiClient")
        assert.strictEqual(result.method, "createResponse")
        assert.strictEqual(result.reason._tag, "InvalidRequestError")
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        status: 400,
        body: { error: { message: "Bad request" } }
      }))))

    it.effect("maps 401 status to AuthenticationError reason", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "AuthenticationError")
        if (result.reason._tag === "AuthenticationError") {
          assert.strictEqual(result.reason.kind, "InvalidKey")
        }
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        status: 401,
        body: { error: { message: "Invalid API key" } }
      }))))

    it.effect("maps 403 status to AuthenticationError with InsufficientPermissions", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "AuthenticationError")
        if (result.reason._tag === "AuthenticationError") {
          assert.strictEqual(result.reason.kind, "InsufficientPermissions")
        }
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        status: 403,
        body: { error: { message: "Access denied" } }
      }))))

    it.effect("maps 429 status to RateLimitError reason", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "RateLimitError")
        assert.isTrue(result.isRetryable)
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        status: 429,
        body: { error: { message: "Rate limit exceeded", type: "rate_limit_error", code: null } }
      }))))

    it.effect("maps 429 with insufficient_quota code to QuotaExhaustedError", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "QuotaExhaustedError")
        assert.isFalse(result.isRetryable)
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        status: 429,
        body: {
          error: {
            message: "You exceeded your current quota",
            type: "insufficient_quota",
            code: "insufficient_quota"
          }
        }
      }))))

    it("mapStatusCodeToReason detects insufficient_quota as QuotaExhaustedError", () => {
      const http = {
        request: {
          method: "POST" as const,
          url: "https://api.openai.com",
          urlParams: [],
          hash: undefined,
          headers: {}
        }
      }
      const reason = Errors.mapStatusCodeToReason({
        status: 429,
        headers: {},
        message: "You exceeded your current quota",
        metadata: {
          errorCode: "insufficient_quota",
          errorType: "insufficient_quota",
          requestId: null
        },
        http
      })
      assert.strictEqual(reason._tag, "QuotaExhaustedError")
    })

    it("OpenAiErrorBody decodes error with type and code", () => {
      const json = {
        error: {
          message: "You exceeded your current quota",
          type: "insufficient_quota",
          code: "insufficient_quota"
        }
      }
      const decoded = Schema.decodeUnknownSync(Errors.OpenAiErrorBody)(json)
      assert.strictEqual(decoded.error.message, "You exceeded your current quota")
      assert.strictEqual(decoded.error.type, "insufficient_quota")
      assert.strictEqual(decoded.error.code, "insufficient_quota")
    })

    it.effect("maps 5xx status to InternalProviderError reason", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "InternalProviderError")
        assert.isTrue(result.isRetryable)
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        status: 500,
        body: { error: { message: "Internal server error" } }
      }))))

    it.effect("maps schema error to InvalidOutputError reason", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.method, "createResponse")
        assert.strictEqual(result.reason._tag, "InvalidOutputError")
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        body: { invalid: "response" } as any
      }))))
  })

  describe("createEmbedding", () => {
    it.effect("maps 400 error to AiError", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createEmbedding({
          model: "invalid-model",
          input: "test"
        }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.method, "createEmbedding")
        assert.strictEqual(result.reason._tag, "InvalidRequestError")
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        status: 400,
        body: { error: { message: "Invalid model" } }
      }))))

    it.effect("maps 429 error to RateLimitError", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createEmbedding({
          model: "text-embedding-ada-002",
          input: "test"
        }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "RateLimitError")
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        status: 429,
        body: { error: { message: "Rate limit exceeded" } }
      }))))
  })

  describe("createResponseStream", () => {
    it.effect("accepts keepalive stream events", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const [_, stream] = yield* client.createResponseStream({
          model: "gpt-4o",
          input: "test"
        })

        const events = yield* Stream.runCollect(stream)
        const parts = globalThis.Array.from(events)

        assert.strictEqual(parts.length, 3)
        const keepAlive = parts[1]
        assert.strictEqual(keepAlive.type, "keepalive")
        if (keepAlive.type === "keepalive" && "sequence_number" in keepAlive) {
          assert.strictEqual(keepAlive.sequence_number, 2)
        }

        const completed = parts[2]
        assert.isTrue(typeof completed === "object" && completed !== null && "type" in completed)
        if (typeof completed === "object" && completed !== null && "type" in completed) {
          assert.strictEqual(completed.type, "response.completed")
          if (
            completed.type === "response.completed" &&
            "response" in completed &&
            typeof completed.response === "object" &&
            completed.response !== null &&
            "id" in completed.response
          ) {
            assert.strictEqual(completed.response.id, "resp_stream")
          }
        }
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Sse",
        events: [
          {
            type: "response.created",
            sequence_number: 1,
            response: makeResponseBody({ id: "resp_stream", status: "in_progress" })
          },
          {
            type: "keepalive",
            sequence_number: 2
          },
          {
            type: "response.completed",
            sequence_number: 3,
            response: makeResponseBody({ id: "resp_stream" })
          }
        ]
      }))))

    it.effect("maps HTTP error before stream starts", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        const result = yield* client.createResponseStream({
          model: "gpt-4o",
          input: "test"
        }).pipe(
          Effect.andThen(([_, stream]) => Stream.runDrain(stream)),
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "InternalProviderError")
      }).pipe(Effect.provide(makeTestLayer(undefined, {
        _tag: "Json",
        status: 500,
        body: { error: { message: "Server error" } }
      }))))
  })
})

type MockResponse =
  | {
    readonly _tag: "Json"
    readonly body: typeof Generated.Response.Encoded | {
      readonly error: {
        readonly message: string
        readonly type?: string
        readonly code?: string | null
      }
    }
    readonly status?: number | undefined
    readonly headers?: Record<string, string> | undefined
  }
  | {
    readonly _tag: "Sse"
    readonly events: ReadonlyArray<typeof OpenAiSchema.ResponseStreamEvent.Encoded>
    readonly status?: number | undefined
    readonly headers?: Record<string, string> | undefined
  }

class MockOpenAiResponse extends Context.Service<MockOpenAiResponse, {
  readonly response: MockResponse
}>()("MockOpenAiResponse") {}

class MockHttpClient extends Context.Service<MockHttpClient, {
  readonly requests: Effect.Effect<ReadonlyArray<HttpClientRequest.HttpClientRequest>>
}>()("MockHttpClient") {
  static requests = MockHttpClient.use((client) => client.requests)
}

const makeHttpClientContext = Effect.gen(function*() {
  const capturedRequests: Array<HttpClientRequest.HttpClientRequest> = []
  const mock = yield* MockOpenAiResponse

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

const defaultResponse: MockResponse = {
  _tag: "Json",
  body: makeResponseBody()
}

const makeTestLayer = (
  options: OpenAiClient.Options = { apiKey: Redacted.make("test-key") },
  response: MockResponse = defaultResponse
) =>
  OpenAiClient.layer(options).pipe(
    Layer.provideMerge(HttpClientLayer),
    Layer.provide(Layer.succeed(MockOpenAiResponse, { response }))
  )

const makeGeneratedTestLayer = (
  options: OpenAiClientGenerated.Options,
  response: MockResponse = defaultResponse
) =>
  OpenAiClientGenerated.layer(options).pipe(
    Layer.provideMerge(HttpClientLayer),
    Layer.provide(Layer.succeed(MockOpenAiResponse, { response }))
  )

const makeConfigTestLayer = (configProvider: ConfigProvider.ConfigProvider) =>
  OpenAiClient.layerConfig({
    apiKey: Config.redacted("MY_API_KEY"),
    apiUrl: Config.string("MY_API_URL")
  }).pipe(
    Layer.provideMerge(HttpClientLayer),
    Layer.provide(Layer.succeed(MockOpenAiResponse, { response: defaultResponse })),
    Layer.provide(ConfigProvider.layer(configProvider))
  )

const makeTransportErrorHttpClient = (): HttpClient.HttpClient =>
  HttpClient.makeWith<HttpClientError.HttpClientError, never, HttpClientError.HttpClientError, never>(
    (requestEffect) =>
      Effect.flatMap(requestEffect, (request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("Connection refused")
            })
          })
        )),
    Effect.succeed
  )

function makeResponseBody(
  overrides: Partial<typeof Generated.Response.Encoded> = {}
): typeof Generated.Response.Encoded {
  return {
    id: "resp_test123",
    object: "response",
    created_at: 1,
    model: "gpt-4o-mini",
    status: "completed",
    output: [],
    metadata: null,
    temperature: null,
    top_p: null,
    tools: [],
    tool_choice: "auto",
    error: null,
    incomplete_details: null,
    instructions: null,
    parallel_tool_calls: false,
    ...overrides
  }
}

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
