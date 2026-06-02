import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

describe("AnthropicLanguageModel", () => {
  describe("streamText", () => {
    it.effect("decodes tool call params in content_block_stop", () =>
      Effect.gen(function*() {
        const toolParams = { pattern: "*.ts" }

        const layer = AnthropicClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) =>
              Effect.succeed(sseResponse(request, [
                {
                  type: "message_start",
                  message: {
                    id: "msg_test_1",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-4-20250514",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                      cache_creation: null,
                      cache_creation_input_tokens: null,
                      cache_read_input_tokens: null,
                      inference_geo: null,
                      input_tokens: 10,
                      output_tokens: 0,
                      service_tier: null
                    }
                  }
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: {
                    type: "tool_use",
                    id: "toolu_test_1",
                    name: "GlobTool",
                    input: {}
                  }
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(toolParams)
                  }
                },
                {
                  type: "content_block_stop",
                  index: 0
                },
                {
                  type: "message_delta",
                  delta: {
                    stop_reason: "tool_use",
                    stop_sequence: null
                  },
                  usage: {
                    cache_creation_input_tokens: null,
                    cache_read_input_tokens: null,
                    input_tokens: null,
                    output_tokens: 5
                  }
                },
                {
                  type: "message_stop"
                }
              ]))
            )
          ))
        )

        const GlobTool = Tool.make("GlobTool", {
          description: "Search for files",
          parameters: Schema.Struct({ pattern: Schema.String }),
          success: Schema.String
        })

        const toolkit = Toolkit.make(GlobTool)
        const toolkitLayer = toolkit.toLayer({
          GlobTool: () => Effect.succeed("found.ts")
        })

        const partsChunk = yield* LanguageModel.streamText({
          prompt: "find ts files",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runCollect,
          Effect.provide(AnthropicLanguageModel.model("claude-sonnet-4-20250514")),
          Effect.provide(toolkitLayer),
          Effect.provide(layer)
        )

        const parts = globalThis.Array.from(partsChunk)
        const toolCall = parts.find((part) => part.type === "tool-call")
        assert.isDefined(toolCall)
        if (toolCall?.type !== "tool-call") {
          return
        }

        assert.strictEqual(toolCall.name, "GlobTool")
        assert.deepStrictEqual(toolCall.params, toolParams)
      }))
  })

  describe("generateText", () => {
    it.effect("encodes dynamic tools", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined = undefined
        const layer = AnthropicClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(request, {
                id: "msg_test_1",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-20250514",
                content: [{ type: "text", text: "Done" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: {
                  cache_creation: null,
                  cache_creation_input_tokens: null,
                  cache_read_input_tokens: null,
                  inference_geo: null,
                  input_tokens: 10,
                  output_tokens: 5,
                  service_tier: null
                }
              }))
            })
          ))
        )

        const inputSchema = {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" }
          },
          required: ["query"],
          additionalProperties: false
        } as const

        const DynamicTool = Tool.dynamic("DynamicTool", {
          description: "A dynamic tool",
          parameters: inputSchema
        })

        yield* LanguageModel.generateText({
          prompt: "Use the dynamic tool",
          toolkit: Toolkit.make(DynamicTool),
          disableToolCallResolution: true
        }).pipe(
          Effect.provide(AnthropicLanguageModel.model("claude-sonnet-4-20250514")),
          Effect.provide(layer)
        )

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const body = yield* getRequestBody(capturedRequest)
        const dynamicTool = body.tools.find((tool: any) => tool.name === "DynamicTool")

        assert.isDefined(dynamicTool)
        if (dynamicTool === undefined) {
          return
        }

        assert.strictEqual(dynamicTool.description, "A dynamic tool")
        assert.deepStrictEqual(dynamicTool.input_schema, inputSchema)
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

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    })
  )

const getRequestBody = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function*() {
    const body = request.body
    if (body._tag !== "Uint8Array") {
      return yield* Effect.die(new Error("Expected Uint8Array body"))
    }
    return JSON.parse(new TextDecoder().decode(body.body))
  })

const toSseBody = (events: ReadonlyArray<unknown>): string =>
  events.map((event) => `event: message_stream\ndata: ${JSON.stringify(event)}\n\n`).join("")
