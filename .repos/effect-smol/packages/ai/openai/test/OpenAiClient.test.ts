import type * as Generated from "@effect/ai-openai/Generated"
import * as Errors from "@effect/ai-openai/internal/errors"
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient"
import * as OpenAiClientGenerated from "@effect/ai-openai/OpenAiClientGenerated"
import * as OpenAiConfig from "@effect/ai-openai/OpenAiConfig"
import { assert, describe, it } from "@effect/vitest"
import { Config, ConfigProvider, Effect, Layer, Redacted, Schema, Stream } from "effect"
import type * as AiError from "effect/unstable/ai/AiError"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

// =============================================================================
// Mock Helpers
// =============================================================================

const makeMockResponse = (options: {
  readonly status: number
  readonly body: unknown
  readonly request?: HttpClientRequest.HttpClientRequest
}): HttpClientResponse.HttpClientResponse => {
  // Always use a plain request for the response to avoid Redacted headers in error contexts
  const request = HttpClientRequest.get(options.request?.url ?? "/")
  const json = JSON.stringify(options.body)
  return HttpClientResponse.fromWeb(
    request,
    new Response(json, {
      status: options.status,
      headers: { "content-type": "application/json" }
    })
  )
}

const makeMockStreamResponse = (options: {
  readonly events: ReadonlyArray<unknown>
  readonly request?: HttpClientRequest.HttpClientRequest
}): HttpClientResponse.HttpClientResponse => {
  const request = HttpClientRequest.get(options.request?.url ?? "/")
  const body = options.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })
  )
}

const makeMockHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): HttpClient.HttpClient =>
  HttpClient.makeWith<HttpClientError.HttpClientError, never, HttpClientError.HttpClientError, never>(
    (effect) =>
      Effect.flatMap(effect, handler) as Effect.Effect<
        HttpClientResponse.HttpClientResponse,
        HttpClientError.HttpClientError,
        never
      >,
    Effect.succeed
  )

const makeResponseBody = (
  overrides: Partial<typeof Generated.Response.Encoded> = {}
): typeof Generated.Response.Encoded => ({
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
})

// =============================================================================
// Tests
// =============================================================================

describe("OpenAiClient", () => {
  describe("make", () => {
    it.effect("sets Bearer token from apiKey", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined
        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: {}, request }))
        })

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("sk-test-12345")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        // Call method and ignore response parsing errors - we only care about the request
        yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.ignore)

        assert.isDefined(capturedRequest)
        const authHeader = capturedRequest!.headers["authorization"]
        assert.strictEqual(authHeader, "Bearer sk-test-12345")
      }))

    it.effect("prepends default URL", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined
        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: {}, request }))
        })

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.ignore)

        assert.isDefined(capturedRequest)
        assert.isTrue(capturedRequest!.url.startsWith("https://api.openai.com/v1"))
      }))

    it.effect("uses custom apiUrl when provided", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined
        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: {}, request }))
        })

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key"),
          apiUrl: "https://custom.api.com/v2"
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.ignore)

        assert.isDefined(capturedRequest)
        assert.isTrue(capturedRequest!.url.startsWith("https://custom.api.com/v2"))
      }))

    it.effect("sets OpenAI-Organization header when organizationId provided", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined
        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: {}, request }))
        })

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key"),
          organizationId: Redacted.make("org-12345")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.ignore)

        assert.isDefined(capturedRequest)
        assert.strictEqual(capturedRequest!.headers["openai-organization"], "org-12345")
      }))

    it.effect("sets OpenAI-Project header when projectId provided", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined
        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: {}, request }))
        })

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key"),
          projectId: Redacted.make("proj-67890")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.ignore)

        assert.isDefined(capturedRequest)
        assert.strictEqual(capturedRequest!.headers["openai-project"], "proj-67890")
      }))

    it.effect("applies transformClient option", () =>
      Effect.gen(function*() {
        let transformApplied = false
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({ status: 200, body: {}, request }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key"),
          transformClient: (client) => {
            transformApplied = true
            return client
          }
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.ignore)
        assert.isTrue(transformApplied)
      }))

    it.effect("exposes transformed HttpClient via client field", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined
        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: {}, request }))
        })

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key"),
          transformClient: (client) =>
            client.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("x-client-field", "enabled")))
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        yield* client.client.execute(HttpClientRequest.get("/responses")).pipe(Effect.ignore)

        assert.isDefined(capturedRequest)
        assert.isTrue(capturedRequest!.url.startsWith("https://api.openai.com/v1"))
        assert.strictEqual(capturedRequest!.headers["authorization"], "Bearer test-key")
        assert.strictEqual(capturedRequest!.headers["x-client-field"], "enabled")
      }))

    it.effect("applies OpenAiConfig transformClient after options transformClient", () =>
      Effect.gen(function*() {
        let optionsTransformApplied = false
        let configTransformApplied = false
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: makeResponseBody(), request }))
        })

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key"),
          transformClient: (client) => {
            optionsTransformApplied = true
            return client.pipe(
              HttpClient.mapRequest(HttpClientRequest.setHeader("x-openai-transform", "options"))
            )
          }
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

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

        assert.isTrue(optionsTransformApplied)
        assert.isTrue(configTransformApplied)
        assert.isDefined(capturedRequest)
        assert.strictEqual(capturedRequest!.headers["x-openai-transform"], "config")
      }))
  })

  describe("OpenAiClientGenerated", () => {
    it.effect("sets Bearer token from apiKey", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined
        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: makeResponseBody(), request }))
        })

        const client = yield* OpenAiClientGenerated.make({
          apiKey: Redacted.make("sk-generated-test")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        yield* client.createResponse({
          payload: {
            model: "gpt-4o",
            input: "test"
          }
        })

        assert.isDefined(capturedRequest)
        assert.strictEqual(capturedRequest!.headers["authorization"], "Bearer sk-generated-test")
      }))

    it.effect("prepends custom apiUrl", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined
        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: makeResponseBody(), request }))
        })

        const client = yield* OpenAiClientGenerated.make({
          apiKey: Redacted.make("test-key"),
          apiUrl: "https://generated.example.test/v2"
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        yield* client.createResponse({
          payload: {
            model: "gpt-4o",
            input: "test"
          }
        })

        assert.isDefined(capturedRequest)
        assert.isTrue(capturedRequest!.url.startsWith("https://generated.example.test/v2"))
      }))

    it.effect("applies OpenAiConfig transformClient after options transformClient", () =>
      Effect.gen(function*() {
        let optionsTransformApplied = false
        let configTransformApplied = false
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const mockClient = makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: makeResponseBody(), request }))
        })

        const client = yield* OpenAiClientGenerated.make({
          apiKey: Redacted.make("test-key"),
          transformClient: (client) => {
            optionsTransformApplied = true
            return client.pipe(
              HttpClient.mapRequest(HttpClientRequest.setHeader("x-openai-transform", "options"))
            )
          }
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        yield* client.createResponse({
          payload: {
            model: "gpt-4o",
            input: "test"
          }
        }).pipe(
          OpenAiConfig.withClientTransform((client) => {
            configTransformApplied = true
            return client.pipe(
              HttpClient.mapRequest(HttpClientRequest.setHeader("x-openai-transform", "config"))
            )
          })
        )

        assert.isTrue(optionsTransformApplied)
        assert.isTrue(configTransformApplied)
        assert.isDefined(capturedRequest)
        assert.strictEqual(capturedRequest!.headers["x-openai-transform"], "config")
      }))
  })

  describe("layer", () => {
    it.effect("creates working service", () => {
      const HttpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        makeMockHttpClient(() => Effect.succeed(makeMockResponse({ status: 200, body: {} })))
      )

      const MainLayer = OpenAiClient.layer({
        apiKey: Redacted.make("test-key")
      }).pipe(Layer.provide(HttpClientLayer))

      return Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        assert.isNotNull(client.client)
      }).pipe(Effect.provide(MainLayer))
    })

    it.effect("layerConfig loads from Config", () => {
      let capturedRequest: HttpClientRequest.HttpClientRequest | undefined
      const HttpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        makeMockHttpClient((request) => {
          capturedRequest = request
          return Effect.succeed(makeMockResponse({ status: 200, body: {}, request }))
        })
      )

      const configProvider = ConfigProvider.fromEnv({
        env: {
          MY_API_KEY: "sk-config-key",
          MY_API_URL: "https://config.api.com/v1"
        }
      })

      // Use explicit config values to test the layerConfig mechanism
      // Provide explicit configs that won't fail for optional fields
      const MainLayer = OpenAiClient.layerConfig({
        apiKey: Config.redacted("MY_API_KEY"),
        apiUrl: Config.string("MY_API_URL")
      }).pipe(
        Layer.provide(HttpClientLayer),
        Layer.provide(ConfigProvider.layer(configProvider))
      )

      return Effect.gen(function*() {
        const client = yield* OpenAiClient.OpenAiClient
        yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(Effect.ignore)

        assert.isDefined(capturedRequest)
        assert.strictEqual(capturedRequest!.headers["authorization"], "Bearer sk-config-key")
        assert.isTrue(capturedRequest!.url.startsWith("https://config.api.com/v1"))
      }).pipe(Effect.provide(MainLayer))
    })
  })

  describe("error mapping", () => {
    it.effect("maps TransportError to NetworkError reason", () =>
      Effect.gen(function*() {
        const mockClient = makeMockHttpClient(() =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request: HttpClientRequest.get("/"),
                cause: new Error("Connection refused")
              })
            })
          )
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.module, "OpenAiClient")
        assert.strictEqual(result.method, "createResponse")
        assert.strictEqual(result.reason._tag, "NetworkError")
      }))

    it.effect("maps 400 status to InvalidRequestError reason", () =>
      Effect.gen(function*() {
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({
            status: 400,
            body: { error: { message: "Bad request" } },
            request
          }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.module, "OpenAiClient")
        assert.strictEqual(result.method, "createResponse")
        assert.strictEqual(result.reason._tag, "InvalidRequestError")
      }))

    it.effect("maps 401 status to AuthenticationError reason", () =>
      Effect.gen(function*() {
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({
            status: 401,
            body: { error: { message: "Invalid API key" } },
            request
          }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "AuthenticationError")
        assert.strictEqual((result.reason as AiError.AuthenticationError).kind, "InvalidKey")
      }))

    it.effect("maps 403 status to AuthenticationError with InsufficientPermissions", () =>
      Effect.gen(function*() {
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({
            status: 403,
            body: { error: { message: "Access denied" } },
            request
          }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "AuthenticationError")
        assert.strictEqual((result.reason as AiError.AuthenticationError).kind, "InsufficientPermissions")
      }))

    it.effect("maps 429 status to RateLimitError reason", () =>
      Effect.gen(function*() {
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({
            status: 429,
            body: { error: { message: "Rate limit exceeded", type: "rate_limit_error", code: null } },
            request
          }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "RateLimitError")
        assert.isTrue(result.isRetryable)
      }))

    it.effect("maps 429 with insufficient_quota code to QuotaExhaustedError", () =>
      Effect.gen(function*() {
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({
            status: 429,
            body: {
              error: {
                message: "You exceeded your current quota",
                type: "insufficient_quota",
                code: "insufficient_quota"
              }
            },
            request
          }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "QuotaExhaustedError")
        assert.isFalse(result.isRetryable)
      }))

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
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({
            status: 500,
            body: { error: { message: "Internal server error" } },
            request
          }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "InternalProviderError")
        assert.isTrue(result.isRetryable)
      }))

    it.effect("maps schema error to InvalidOutputError reason", () =>
      Effect.gen(function*() {
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({
            status: 200,
            body: { invalid: "response" },
            request
          }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createResponse({ model: "gpt-4o", input: "test" }).pipe(
          Effect.flip
        )

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.method, "createResponse")
        assert.strictEqual(result.reason._tag, "InvalidOutputError")
      }))
  })

  describe("createEmbedding", () => {
    it.effect("maps 400 error to AiError", () =>
      Effect.gen(function*() {
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({
            status: 400,
            body: { error: { message: "Invalid model" } },
            request
          }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createEmbedding({
          model: "invalid-model",
          input: "test"
        }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.method, "createEmbedding")
        assert.strictEqual(result.reason._tag, "InvalidRequestError")
      }))

    it.effect("maps 429 error to RateLimitError", () =>
      Effect.gen(function*() {
        const mockClient = makeMockHttpClient((request) =>
          Effect.succeed(makeMockResponse({
            status: 429,
            body: { error: { message: "Rate limit exceeded" } },
            request
          }))
        )

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("test-key")
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient)))

        const result = yield* client.createEmbedding({
          model: "text-embedding-ada-002",
          input: "test"
        }).pipe(Effect.flip)

        assert.strictEqual(result._tag, "AiError")
        assert.strictEqual(result.reason._tag, "RateLimitError")
      }))
  })

  describe("createResponseStream", () => {
    it.effect("accepts keepalive stream events", () => {
      const mockClient = makeMockHttpClient((request) =>
        Effect.succeed(makeMockStreamResponse({
          request,
          events: [
            {
              type: "response.created",
              sequence_number: 1,
              response: makeResponseBody({
                id: "resp_stream",
                status: "in_progress"
              })
            },
            {
              type: "keepalive",
              sequence_number: 2
            },
            {
              type: "response.completed",
              sequence_number: 3,
              response: makeResponseBody({
                id: "resp_stream"
              })
            }
          ]
        }))
      )

      const HttpClientLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

      const MainLayer = OpenAiClient.layer({
        apiKey: Redacted.make("test-key")
      }).pipe(Layer.provide(HttpClientLayer))

      return Effect.gen(function*() {
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
      }).pipe(Effect.provide(MainLayer))
    })

    it.effect("maps HTTP error before stream starts", () => {
      const mockClient = makeMockHttpClient((request) =>
        Effect.succeed(makeMockResponse({
          status: 500,
          body: { error: { message: "Server error" } },
          request
        }))
      )

      const HttpClientLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

      const MainLayer = OpenAiClient.layer({
        apiKey: Redacted.make("test-key")
      }).pipe(Layer.provide(HttpClientLayer))

      return Effect.gen(function*() {
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
      }).pipe(Effect.provide(MainLayer))
    })
  })
})
