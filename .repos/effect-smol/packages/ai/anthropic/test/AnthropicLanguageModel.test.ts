import { AnthropicClient, AnthropicLanguageModel, AnthropicTool } from "@effect/ai-anthropic"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import {
  AnthropicStructuredOutput,
  LanguageModel,
  Prompt,
  Response as AiResponse,
  Tool,
  Toolkit
} from "effect/unstable/ai"
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

    const codeExecutionCases = [
      {
        providerName: "bash_code_execution",
        toolParams: { command: "pwd" },
        expectedParams: { type: "bash_code_execution", command: "pwd" }
      },
      {
        providerName: "text_editor_code_execution",
        toolParams: { command: "view", path: "/tmp/example.txt" },
        expectedParams: {
          type: "text_editor_code_execution",
          command: "view",
          path: "/tmp/example.txt"
        }
      }
    ] as const

    for (const { expectedParams, providerName, toolParams } of codeExecutionCases) {
      it.effect(`emits valid JSON for streamed ${providerName} parameters`, () =>
        Effect.gen(function*() {
          const toolkit = Toolkit.make(AnthropicTool.CodeExecution_20250522())
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
                        input_tokens: 1,
                        output_tokens: 0,
                        service_tier: null
                      }
                    }
                  },
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: {
                      type: "server_tool_use",
                      id: "srvtoolu_test_1",
                      name: providerName,
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
                      output_tokens: 1
                    }
                  },
                  {
                    type: "message_stop"
                  }
                ]))
              )
            ))
          )

          const partsChunk = yield* LanguageModel.streamText({
            prompt: "run pwd",
            toolkit,
            disableToolCallResolution: true
          }).pipe(
            Stream.runCollect,
            Effect.provide(AnthropicLanguageModel.model("claude-sonnet-4-20250514")),
            Effect.provide(layer)
          )

          const parts = globalThis.Array.from(partsChunk)

          const delta = parts.find((part) => part.type === "tool-params-delta")
          assert.isDefined(delta)
          if (delta?.type === "tool-params-delta") {
            assert.deepStrictEqual(JSON.parse(delta.delta), expectedParams)
          }

          const toolCall = parts.find((part) => part.type === "tool-call")
          assert.isDefined(toolCall)
          if (toolCall?.type === "tool-call") {
            assert.deepStrictEqual(toolCall.params, expectedParams)
          }
        }))
    }

    // `Model` is an open enum in Anthropic's spec (`anyOf: [{ type: string }, ...consts]`), and it is
    // $ref'd by response schemas. Responses must therefore decode for model ids that are newer than the
    // generated literals, and the id must survive decoding unchanged.
    it.effect("decodes responses for a model id that is not a known literal", () =>
      Effect.gen(function*() {
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
                    model: "claude-not-a-known-model-id",
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
                  content_block: { type: "text", text: "" }
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Hello" }
                },
                {
                  type: "content_block_stop",
                  index: 0
                },
                {
                  type: "message_delta",
                  delta: {
                    stop_reason: "end_turn",
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

        const partsChunk = yield* LanguageModel.streamText({
          prompt: "say hello"
        }).pipe(
          Stream.runCollect,
          Effect.provide(AnthropicLanguageModel.model("claude-not-a-known-model-id")),
          Effect.provide(layer)
        )

        const parts = globalThis.Array.from(partsChunk)
        const metadata = parts.find((part) => part.type === "response-metadata")
        assert.isDefined(metadata)
        if (metadata?.type !== "response-metadata") {
          return
        }

        assert.strictEqual(metadata.modelId, "claude-not-a-known-model-id")

        const text = parts.find((part) => part.type === "text-delta")
        assert.isDefined(text)
        if (text?.type !== "text-delta") {
          return
        }

        assert.strictEqual(text.delta, "Hello")
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

    it.effect("serializes provider-executed web_search parts from the assistant message", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined = undefined
        const layer = AnthropicClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(request, {
                id: "msg_test_2",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-20250514",
                content: [{ type: "text", text: "You're welcome" }],
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

        const searchResults = [{
          type: "web_search_result",
          url: "https://example.com/gold",
          title: "Gold price",
          encrypted_content: "encrypted",
          page_age: null
        }]

        const history = Prompt.fromResponseParts([
          AiResponse.makePart("tool-call", {
            id: "srvtoolu_1",
            name: "AnthropicWebSearch",
            params: { query: "gold price today" },
            providerExecuted: true
          }),
          AiResponse.makePart("tool-result", {
            id: "srvtoolu_1",
            name: "AnthropicWebSearch",
            isFailure: false,
            result: searchResults,
            encodedResult: searchResults,
            preliminary: false,
            providerExecuted: true
          }),
          AiResponse.makePart("text", { text: "Gold is around $4,000." })
        ])

        const prompt = Prompt.concat(
          Prompt.concat(Prompt.make("what is the gold price?"), history),
          Prompt.make("thanks")
        )

        yield* LanguageModel.generateText({
          prompt,
          toolkit: Toolkit.make(AnthropicTool.WebSearch_20250305({})),
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
        const assistantMessage = body.messages.find((message: any) => message.role === "assistant")
        assert.isDefined(assistantMessage)

        const serverToolUse = assistantMessage.content.find((block: any) => block.type === "server_tool_use")
        assert.isDefined(serverToolUse)
        assert.strictEqual(serverToolUse.id, "srvtoolu_1")
        assert.strictEqual(serverToolUse.name, "web_search")

        const searchResult = assistantMessage.content.find((block: any) => block.type === "web_search_tool_result")
        assert.isDefined(searchResult)
        assert.strictEqual(searchResult.tool_use_id, "srvtoolu_1")

        const clientToolResults = body.messages.flatMap((message: any) =>
          Array.isArray(message.content)
            ? message.content.filter((block: any) => block.type === "tool_result")
            : []
        )
        assert.strictEqual(clientToolResults.length, 0)
      }))

    it.effect("encodes plaintext bytes as UTF-8 text", () =>
      Effect.gen(function*() {
        let body: any
        const client = AnthropicClient.layer({ apiKey: Redacted.make("test") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.makeWith(
              Effect.fnUntraced(function*(requestEffect) {
                const request = yield* requestEffect
                body = JSON.parse(new TextDecoder().decode((request.body as any).body))
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      id: "msg_1",
                      type: "message",
                      role: "assistant",
                      model: "claude-sonnet-4-20250514",
                      content: [{ type: "text", text: "ok" }],
                      stop_reason: "end_turn",
                      stop_sequence: null,
                      usage: {
                        cache_creation: null,
                        cache_creation_input_tokens: null,
                        cache_read_input_tokens: null,
                        inference_geo: null,
                        input_tokens: 1,
                        output_tokens: 1,
                        service_tier: null
                      }
                    }),
                    { status: 200 }
                  )
                )
              }),
              Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
            )
          ))
        )

        yield* LanguageModel.generateText({
          prompt: Prompt.make([{
            role: "user",
            content: [Prompt.filePart({ mediaType: "text/plain", data: new TextEncoder().encode("hello") })]
          }])
        }).pipe(
          Effect.provide(AnthropicLanguageModel.model("claude-sonnet-4-20250514")),
          Effect.provide(client)
        )

        assert.strictEqual(body.messages[0].content[0].source.data, "hello")
      }))
  })

  describe("generateObject", () => {
    const getRequest = (
      model: string,
      config?: { readonly structuredOutputs?: boolean | undefined }
    ) =>
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
                model,
                content: [{ type: "text", text: JSON.stringify({ name: "John", age: 30 }) }],
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

        // Assert the request shape; the response outcome is irrelevant here.
        yield* LanguageModel.generateObject({
          prompt: "Give me a person",
          schema: Schema.Struct({ name: Schema.String, age: Schema.Number })
        }).pipe(
          Effect.provide(AnthropicLanguageModel.model(model, config)),
          Effect.provide(layer),
          Effect.ignore
        )

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return yield* Effect.die(new Error("Expected a captured request"))
        }

        return yield* getRequestBody(capturedRequest)
      })

    it.effect("uses native structured output and 128K for Claude 4.6", () =>
      Effect.gen(function*() {
        const body = yield* getRequest("claude-opus-4-6")

        assert.strictEqual(body.max_tokens, 128000)
        assert.strictEqual(body.output_config?.format?.type, "json_schema")
      }))

    it.effect("uses optimistic modern defaults for an unknown future model", () =>
      Effect.gen(function*() {
        const body = yield* getRequest("claude-sonnet-6-0")

        assert.strictEqual(body.max_tokens, 128000)
        assert.strictEqual(body.output_config?.format?.type, "json_schema")
      }))

    it.effect("preserves frozen legacy model exceptions", () =>
      Effect.gen(function*() {
        const body = yield* getRequest("claude-sonnet-4-20250514")

        assert.strictEqual(body.max_tokens, 64000)
        assert.isUndefined(body.output_config)
      }))

    it.effect("can disable structured outputs for a modern model", () =>
      Effect.gen(function*() {
        const body = yield* getRequest("claude-sonnet-6-0", { structuredOutputs: false })

        assert.strictEqual(body.max_tokens, 128000)
        assert.isUndefined(body.output_config)
        assert.notProperty(body, "structuredOutputs")
      }))

    it.effect("can enable structured outputs for a legacy model", () =>
      Effect.gen(function*() {
        const body = yield* getRequest("claude-sonnet-4-20250514", { structuredOutputs: true })

        assert.strictEqual(body.max_tokens, 64000)
        assert.strictEqual(body.output_config?.format?.type, "json_schema")
        assert.notProperty(body, "structuredOutputs")
      }))
  })

  // The packaged `Memory_20250818` tool ships `customName: "AnthropicMemory"` /
  // `providerName: "memory"`, and is a client-executed provider tool. These
  // tests cover the round-trip that was broken on beta.98 (see #2615):
  //  - the provider wire name ("memory") must resolve to the toolkit's custom
  //    name ("AnthropicMemory"), otherwise `makeResponse` raises ToolNotFound
  //  - `view_range` uses `Schema.optionalKey`, otherwise the Anthropic codec
  //    rejects the tool schema with "Unsupported AST Undefined"
  //  - `create` must carry `file_text`, otherwise the file body is dropped
  describe("Memory tool", () => {
    const memoryResponse = (request: HttpClientRequest.HttpClientRequest, input: unknown) =>
      jsonResponse(request, {
        id: "msg_test_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "tool_use", id: "toolu_mem_1", name: "memory", input }],
        stop_reason: "tool_use",
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
      })

    it.effect("resolves the provider wire name to the tool's custom name (view)", () =>
      Effect.gen(function*() {
        let receivedParams: unknown = undefined
        const toolkit = Toolkit.make(AnthropicTool.Memory_20250818({}))
        const toolkitLayer = toolkit.toLayer({
          AnthropicMemory: (params) => {
            receivedParams = params
            return Effect.succeed("memory listing")
          }
        })

        const layer = AnthropicClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => Effect.succeed(memoryResponse(request, { command: "view", path: "/memories" })))
          ))
        )

        const response = yield* LanguageModel.generateText({
          prompt: "check memory",
          toolkit
        }).pipe(
          Effect.provide(AnthropicLanguageModel.model("claude-sonnet-4-20250514")),
          Effect.provide(toolkitLayer),
          Effect.provide(layer)
        )

        // Handler was resolved under the custom name and received the decoded command
        assert.deepStrictEqual(receivedParams, { command: "view", path: "/memories" })

        const toolResult = response.toolResults[0]
        assert.isDefined(toolResult)
        assert.strictEqual(toolResult.name, "AnthropicMemory")
        assert.strictEqual(toolResult.result, "memory listing")
      }))

    it.effect("decodes the create command including file_text", () =>
      Effect.gen(function*() {
        let receivedParams: unknown = undefined
        const toolkit = Toolkit.make(AnthropicTool.Memory_20250818({}))
        const toolkitLayer = toolkit.toLayer({
          AnthropicMemory: (params) => {
            receivedParams = params
            return Effect.succeed("File created successfully at: /memories/notes.txt")
          }
        })

        const layer = AnthropicClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) =>
              Effect.succeed(memoryResponse(request, {
                command: "create",
                path: "/memories/notes.txt",
                file_text: "hello world"
              }))
            )
          ))
        )

        const response = yield* LanguageModel.generateText({
          prompt: "save a note",
          toolkit
        }).pipe(
          Effect.provide(AnthropicLanguageModel.model("claude-sonnet-4-20250514")),
          Effect.provide(toolkitLayer),
          Effect.provide(layer)
        )

        assert.deepStrictEqual(receivedParams, {
          command: "create",
          path: "/memories/notes.txt",
          file_text: "hello world"
        })
        assert.strictEqual(response.toolResults[0]?.name, "AnthropicMemory")
      }))
  })

  // Client-executed (`requiresHandler`) provider tools have their `parameters`
  // decoded via `toCodecAnthropic` when the model calls them. Optional
  // parameters must use `Schema.optionalKey` (not `Schema.optional`), otherwise
  // the codec rejects the schema with "Unsupported AST Undefined" (see #2615).
  describe("client provider tool parameters compile with the Anthropic codec", () => {
    const displayArgs = { displayWidthPx: 800, displayHeightPx: 600 }
    const clientTools: ReadonlyArray<readonly [string, Tool.AnyProviderDefined]> = [
      ["Bash_20241022", AnthropicTool.Bash_20241022({})],
      ["Bash_20250124", AnthropicTool.Bash_20250124({})],
      ["ComputerUse_20241022", AnthropicTool.ComputerUse_20241022(displayArgs)],
      ["ComputerUse_20250124", AnthropicTool.ComputerUse_20250124(displayArgs)],
      ["ComputerUse_20251124", AnthropicTool.ComputerUse_20251124(displayArgs)],
      ["Memory_20250818", AnthropicTool.Memory_20250818({})],
      ["TextEditor_20241022", AnthropicTool.TextEditor_20241022({})],
      ["TextEditor_20250124", AnthropicTool.TextEditor_20250124({})],
      ["TextEditor_20250429", AnthropicTool.TextEditor_20250429({})],
      ["TextEditor_20250728", AnthropicTool.TextEditor_20250728({})]
    ]

    for (const [name, tool] of clientTools) {
      it(name, () => {
        const codec = AnthropicStructuredOutput.toCodecAnthropic(tool.parametersSchema)
        assert.isDefined(codec)
      })
    }
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
