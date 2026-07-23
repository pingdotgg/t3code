import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

describe("OpenAiClient", () => {
  describe("request behavior", () => {
    it.effect("sets auth and OpenAI headers on /chat/completions requests", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("sk-test-key"),
          apiUrl: "https://compat.example.test/v1",
          organizationId: Redacted.make("org_123"),
          projectId: Redacted.make("proj_456")
        }).pipe(
          Effect.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(request, 200, makeChatCompletion()))
            })
          ))
        )

        yield* client.createResponse({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }]
        })

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        assert.isTrue(capturedRequest.url.endsWith("/chat/completions"))
        assert.isTrue(capturedRequest.url.startsWith("https://compat.example.test/v1"))
        assert.strictEqual(capturedRequest.headers["authorization"], "Bearer sk-test-key")
        assert.strictEqual(capturedRequest.headers["openai-organization"], "org_123")
        assert.strictEqual(capturedRequest.headers["openai-project"], "proj_456")

        const body = yield* getRequestBody(capturedRequest)
        assert.strictEqual(body.messages[0]?.role, "user")
        assert.strictEqual(body.messages[0]?.content, "hello")
      }))

    it.effect("passes custom chat-completions request properties through", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("sk-test-key")
        }).pipe(
          Effect.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(request, 200, makeChatCompletion()))
            })
          ))
        )

        yield* client.createResponse({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
          provider_feature: {
            enabled: true
          }
        })

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const body = yield* getRequestBody(capturedRequest)
        assert.deepStrictEqual(body.provider_feature, {
          enabled: true
        })
      }))

    it.effect("uses /embeddings path and decodes permissive embedding payloads", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("sk-test-key"),
          apiUrl: "https://compat.example.test/v1"
        }).pipe(
          Effect.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(request, 200, {
                data: [{
                  embedding: "YmFzZTY0LWRhdGE=",
                  index: 0,
                  object: "embedding",
                  vendor_payload: { future_field: true }
                }],
                model: "my-custom-embedding-model",
                object: "list",
                usage: {
                  prompt_tokens: 5,
                  total_tokens: 5
                },
                unknown_top_level: true
              }))
            })
          ))
        )

        const embedding = yield* client.createEmbedding({
          model: "my-custom-embedding-model",
          input: "embed this"
        })

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        assert.isTrue(capturedRequest.url.endsWith("/embeddings"))
        assert.strictEqual(embedding.model, "my-custom-embedding-model")
        assert.strictEqual(embedding.data[0]?.index, 0)
        assert.strictEqual(typeof embedding.data[0]?.embedding, "string")
      }))

    it.effect("sets stream=true for createResponseStream and returns chat chunks", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("sk-test-key")
        }).pipe(
          Effect.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(sseResponse(request, [
                {
                  id: "chatcmpl_test_1",
                  object: "chat.completion.chunk",
                  model: "gpt-4o-mini",
                  created: 1,
                  future_provider_field: { accepted: true },
                  choices: [{
                    index: 0,
                    delta: { content: "Hello" },
                    finish_reason: null
                  }]
                },
                {
                  id: "chatcmpl_test_1",
                  object: "chat.completion.chunk",
                  model: "gpt-4o-mini",
                  created: 1,
                  usage: {
                    prompt_tokens: 4,
                    completion_tokens: 2,
                    total_tokens: 6,
                    prompt_tokens_details: { cached_tokens: 1 },
                    completion_tokens_details: { reasoning_tokens: 1 }
                  },
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: "stop"
                  }]
                },
                "[DONE]"
              ]))
            })
          ))
        )

        const eventsChunk = yield* client.createResponseStream({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }]
        }).pipe(
          Effect.flatMap(([_, stream]) => Stream.runCollect(stream))
        )

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const body = yield* getRequestBody(capturedRequest)
        assert.strictEqual(body.stream, true)
        assert.strictEqual(body.stream_options.include_usage, true)
        assert.isTrue(capturedRequest.url.endsWith("/chat/completions"))

        const events = globalThis.Array.from(eventsChunk)
        const firstEvent = events[0]
        const secondEvent = events[1]
        assert.isTrue(typeof firstEvent === "object")
        assert.isTrue(typeof secondEvent === "object")
        if (
          typeof firstEvent !== "object" || firstEvent === null || typeof secondEvent !== "object" ||
          secondEvent === null
        ) {
          return
        }
        assert.strictEqual(firstEvent.id, "chatcmpl_test_1")
        assert.strictEqual(secondEvent.id, "chatcmpl_test_1")
        assert.strictEqual(events[2], "[DONE]")
      }))

    it.effect("passes chat-completions tool_choice payload through unchanged", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("sk-test-key")
        }).pipe(
          Effect.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(request, 200, makeChatCompletion()))
            })
          ))
        )

        yield* client.createResponse({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
          tool_choice: {
            type: "function",
            function: {
              name: "TestTool"
            }
          },
          tools: [{
            type: "function",
            function: {
              name: "TestTool",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  input: { type: "string" }
                },
                required: ["input"]
              }
            }
          }]
        })

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const body = yield* getRequestBody(capturedRequest)
        assert.deepStrictEqual(body.tool_choice, { type: "function", function: { name: "TestTool" } })
      }))

    it.effect("accepts assistant tool-call and tool result chat history", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("sk-test-key")
        }).pipe(
          Effect.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(request, 200, makeChatCompletion()))
            })
          ))
        )

        yield* client.createResponse({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "patch_call_1",
                type: "function",
                function: {
                  name: "apply_patch",
                  arguments: JSON.stringify({
                    call_id: "patch_call_1",
                    operation: {
                      type: "delete_file",
                      path: "src/obsolete.ts"
                    }
                  })
                }
              }]
            },
            {
              role: "tool",
              tool_call_id: "patch_call_1",
              content: "deleted"
            }
          ]
        })

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const body = yield* getRequestBody(capturedRequest)
        const assistantMessages = body.messages.filter((message: any) => message.role === "assistant")
        const patchMessage = assistantMessages.find((message: any) =>
          message.tool_calls?.[0]?.function?.name === "apply_patch"
        )

        assert.isDefined(patchMessage)

        assert.strictEqual(patchMessage.tool_calls[0].id, "patch_call_1")
        assert.deepStrictEqual(JSON.parse(patchMessage.tool_calls[0].function.arguments), {
          call_id: "patch_call_1",
          operation: {
            type: "delete_file",
            path: "src/obsolete.ts"
          }
        })

        const toolMessages = body.messages.filter((message: any) => message.role === "tool")
        const patchOutput = toolMessages.find((message: any) => message.tool_call_id === "patch_call_1")
        assert.isDefined(patchOutput)
        assert.strictEqual(patchOutput.content, "deleted")
      }))
  })

  describe("error mapping", () => {
    it.effect("maps 400 responses to InvalidRequestError", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("sk-test-key")
        }).pipe(
          Effect.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) =>
              Effect.succeed(jsonResponse(request, 400, {
                error: {
                  message: "Bad request",
                  type: "invalid_request_error",
                  code: null
                }
              }))
            )
          ))
        )

        const error = yield* client.createResponse({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }]
        }).pipe(Effect.flip)

        assert.strictEqual(error._tag, "AiError")
        assert.strictEqual(error.method, "createResponse")
        assert.strictEqual(error.reason._tag, "InvalidRequestError")
      }))

    it.effect("maps insufficient quota errors to QuotaExhaustedError", () =>
      Effect.gen(function*() {
        const client = yield* OpenAiClient.make({
          apiKey: Redacted.make("sk-test-key")
        }).pipe(
          Effect.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) =>
              Effect.succeed(jsonResponse(request, 429, {
                error: {
                  message: "You exceeded your current quota",
                  type: "insufficient_quota",
                  code: "insufficient_quota"
                }
              }))
            )
          ))
        )

        const error = yield* client.createResponse({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }]
        }).pipe(Effect.flip)

        assert.strictEqual(error._tag, "AiError")
        assert.strictEqual(error.method, "createResponse")
        assert.strictEqual(error.reason._tag, "QuotaExhaustedError")
      }))
  })
})

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
) =>
  HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      return yield* handler(request)
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )

const makeChatCompletion = () => ({
  id: "chatcmpl_test_1",
  object: "chat.completion",
  model: "gpt-4o-mini",
  created: 1,
  choices: [{
    index: 0,
    finish_reason: "stop",
    message: {
      role: "assistant",
      content: "Hello"
    }
  }],
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2
  }
})

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json"
      }
    })
  )

const sseResponse = (
  request: HttpClientRequest.HttpClientRequest,
  events: ReadonlyArray<unknown>
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(toSseBody(events), {
      status: 200,
      headers: {
        "content-type": "text/event-stream"
      }
    })
  )

const getRequestBody = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function*() {
    const body = request.body
    if (body._tag === "Uint8Array") {
      const text = new TextDecoder().decode(body.body)
      return JSON.parse(text)
    }
    return yield* Effect.die(new Error("Expected Uint8Array body"))
  })

const toSseBody = (events: ReadonlyArray<unknown>): string =>
  events.map((event) => {
    if (typeof event === "string") {
      return `data: ${event}\n\n`
    }
    return `data: ${JSON.stringify(event)}\n\n`
  }).join("")
