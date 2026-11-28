import { Generated, OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { assert, describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array, Context, Effect, Layer, Redacted, Ref, Schema, SchemaGetter, Stream } from "effect"
import { type AiError, LanguageModel, Model, Prompt, Tool, Toolkit } from "effect/ai"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/http"

describe("OpenRouterLanguageModel", () => {
  describe("finish reason inference", () => {
    const metadata = { id: "response-1", object: "chat.completion.chunk" as const, model: "test/model", created: 1 }
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    const call = {
      index: 0,
      id: "call-1",
      type: "function" as const,
      function: { name: "ProbeTool", arguments: "{\"value\":1}" }
    }

    const toolkit = Toolkit.make(Tool.make("ProbeTool", {
      parameters: Schema.Struct({ value: Schema.Number }),
      success: Schema.Number
    }))
    const toolLayer = toolkit.toLayer({ ProbeTool: ({ value }) => Effect.succeed(value) })

    it.effect("generate executes tool calls with a null finish reason", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: "Use the tool", toolkit })
        strictEqual(response.finishReason, "tool-calls")
        deepStrictEqual(response.content.filter((part) => part.type === "tool-result").map((part) => part.result), [1])
      }).pipe(
        Effect.provide(OpenRouterLanguageModel.model(metadata.model)),
        Effect.provide(toolLayer),
        Effect.provide(makeTestLayer({
          body: {
            choices: [{
              index: 0,
              finish_reason: null,
              message: { role: "assistant", content: null, tool_calls: [call] }
            }]
          }
        }))
      ))

    it.effect("stream executes complete tool calls without a finish reason", () =>
      Effect.gen(function*() {
        const parts = yield* LanguageModel.streamText({ prompt: "Use the tool", toolkit }).pipe(Stream.runCollect)
        deepStrictEqual(parts.filter((part) => part.type === "finish").map((part) => part.reason), ["tool-calls"])
        deepStrictEqual(parts.filter((part) => part.type === "tool-result").map((part) => part.result), [1])
      }).pipe(
        Effect.provide(OpenRouterLanguageModel.model(metadata.model)),
        Effect.provide(toolLayer),
        Effect.provide(makeStreamTestLayer([
          {
            ...metadata,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  ...call,
                  function: { name: "ProbeTool", arguments: "{\"value\":" }
                }]
              }
            }]
          },
          {
            ...metadata,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "1}" } }]
              }
            }],
            usage
          }
        ]))
      ))

    it.effect("does not execute a truncated tool call alongside a complete call without a finish reason", () =>
      Effect.gen(function*() {
        const toolkit = Toolkit.make(Tool.make("ProbeTool", {
          parameters: Schema.Struct({ value: Schema.optional(Schema.Number) }),
          success: Schema.String
        }))
        const executed: Array<number | undefined> = []
        yield* LanguageModel.streamText({ prompt: "Use the probe tool", toolkit }).pipe(
          Stream.runDrain,
          Effect.result,
          Effect.provide(OpenRouterLanguageModel.model(metadata.model)),
          Effect.provide(toolkit.toLayer({
            ProbeTool: ({ value }) =>
              Effect.sync(() => {
                executed.push(value)
                return "ok"
              })
          })),
          Effect.provide(makeStreamTestLayer([
            {
              ...metadata,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [call, {
                    index: 1,
                    id: "call-2",
                    type: "function",
                    function: { name: "ProbeTool", arguments: "{\"value\":" }
                  }]
                }
              }]
            },
            { ...metadata, choices: [], usage }
          ]))
        )
        // Either rejecting the response or leaving the partial call interrupted is safe.
        assert.notInclude(executed, undefined)
      }))
  })

  describe("strictJsonSchema", () => {
    for (
      const [model, strict] of [
        ["openai/gpt-4o-mini", true],
        ["google/gemini-2.5-flash", null]
      ] as const
    ) {
      it.effect(`defaults response strictness to ${strict} for ${model}`, () =>
        Effect.gen(function*() {
          yield* LanguageModel.generateObject({
            prompt: "Give me a name",
            schema: Schema.Struct({ name: Schema.String })
          }).pipe(Effect.provide(OpenRouterLanguageModel.model(model)))

          const requests = yield* MockHttpClient.requests
          const body = yield* getRequestBody(requests[0])
          strictEqual(body.response_format.json_schema.strict, strict)
        }).pipe(Effect.provide(makeTestLayer({
          body: {
            choices: [{
              finish_reason: "stop",
              index: 0,
              message: { role: "assistant", content: JSON.stringify({ name: "Alice" }) }
            }]
          }
        }))))
    }

    it.effect("omits false from requests while preserving response strictness", () =>
      Effect.gen(function*() {
        yield* LanguageModel.generateObject({
          prompt: "Give me a name",
          schema: Schema.Struct({ name: Schema.String })
        }).pipe(Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini", { strictJsonSchema: false })))

        const requests = yield* MockHttpClient.requests
        const body = yield* getRequestBody(requests[0])
        strictEqual(body.response_format.json_schema.strict, false)
        assert.notProperty(body, "strictJsonSchema")
      }).pipe(Effect.provide(makeTestLayer({
        body: {
          choices: [{
            finish_reason: "stop",
            index: 0,
            message: { role: "assistant", content: JSON.stringify({ name: "Alice" }) }
          }]
        }
      }))))

    it.effect("omits true from streaming requests while preserving tool strictness", () =>
      Effect.gen(function*() {
        const tool = Tool.make("FlexibleTool", { parameters: Schema.Struct({ query: Schema.String }) })
          .annotate(Tool.Strict, false)
        yield* LanguageModel.streamText({
          prompt: "Use a tool",
          toolkit: Toolkit.make(tool),
          disableToolCallResolution: true
        }).pipe(
          Stream.runDrain,
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini", { strictJsonSchema: true }))
        )

        const requests = yield* MockHttpClient.requests
        const body = yield* getRequestBody(requests[0])
        strictEqual(body.stream, true)
        strictEqual(body.tools[0].function.strict, false)
        assert.notProperty(body, "strictJsonSchema")
      }).pipe(Effect.provide(makeStreamTestLayer([]))))
  })

  describe("schema codecs", () => {
    const TagsTool = Tool.make("TagsTool", {
      failureMode: "return",
      parameters: Schema.Struct({ tags: Schema.Record(Schema.String, Schema.Number) }),
      success: Schema.String
    })
    const toolkit = Toolkit.make(TagsTool)
    const handlers = toolkit.toLayer({
      TagsTool: (params) => {
        deepStrictEqual(params, { tags: { a: 1 } })
        return Effect.succeed(JSON.stringify(params.tags))
      }
    })
    const openAiArguments = JSON.stringify({ tags: [{ "0": "a", "1": 1 }] })

    it.effect("decodes tool call parameters with the codec their schema was sent with", () =>
      Effect.gen(function*() {
        const response = yield* LanguageModel.generateText({ prompt: "Use a tool", toolkit }).pipe(
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini")),
          Effect.provide(handlers)
        )

        const requests = yield* MockHttpClient.requests
        const body = yield* getRequestBody(requests[0])
        strictEqual(body.tools[0].function.parameters.properties.tags.type, "array")
        strictEqual(response.toolResults.length, 2)
        const success = response.toolResults.find((part) => part.id === "call-1")!
        const invalid = response.toolResults.find((part) => part.id === "call-2")!
        deepStrictEqual([success.isFailure, success.result], [false, "{\"a\":1}"])
        strictEqual(invalid.isFailure, true)
        const failure = invalid.result as AiError.AiError
        strictEqual(failure._tag, "AiError")
        strictEqual(failure.reason._tag, "ToolParameterValidationError")
      }).pipe(Effect.provide(makeTestLayer({
        body: {
          choices: [{
            finish_reason: "tool_calls",
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "TagsTool", arguments: openAiArguments }
              }, {
                id: "call-2",
                type: "function",
                function: { name: "TagsTool", arguments: JSON.stringify({ tags: 42 }) }
              }]
            }
          }]
        }
      }))))

    it.effect("returns encoded tool parameters without decoding services when resolution is disabled", () =>
      Effect.gen(function*() {
        class Decoder extends Context.Service<Decoder, { readonly value: number }>()("test/OpenRouterDecoder") {}
        const parameter = Schema.String.pipe(Schema.decodeTo(Schema.Number, {
          decode: SchemaGetter.transformEffect(() => Effect.map(Decoder, (decoder) => decoder.value)),
          encode: SchemaGetter.transform(String)
        }))
        const toolkit = Toolkit.make(Tool.make("Decode", {
          parameters: Schema.Struct({ n: parameter })
        }))
        const response = yield* LanguageModel.generateText({
          prompt: "Use a tool",
          toolkit,
          disableToolCallResolution: true
        }).pipe(Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini")))

        deepStrictEqual(response.toolCalls.map((part) => part.params), [{ n: "1" }])
      }).pipe(Effect.provide(makeTestLayer({
        body: {
          choices: [{
            finish_reason: "tool_calls",
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "Decode", arguments: JSON.stringify({ n: "1" }) }
              }]
            }
          }]
        }
      }))))

    it.effect("sends strict tools a strict-compatible schema for models without a provider codec", () =>
      Effect.gen(function*() {
        const StrictTool = Tool.make("StrictTool", {
          parameters: Schema.Struct({ query: Schema.String, limit: Schema.optional(Schema.Number) }),
          success: Schema.String
        }).annotate(Tool.Strict, true)
        const toolkit = Toolkit.make(StrictTool)
        const response = yield* LanguageModel.generateText({ prompt: "Use a tool", toolkit }).pipe(
          Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")),
          Effect.provide(toolkit.toLayer({
            StrictTool: (params) => {
              deepStrictEqual(params, { query: "search" })
              return Effect.succeed("ok")
            }
          }))
        )
        deepStrictEqual(response.toolResults.map((part) => [part.isFailure, part.result]), [[false, "ok"]])

        const requests = yield* MockHttpClient.requests
        const body = yield* getRequestBody(requests[0])
        const { parameters, strict } = body.tools[0].function
        strictEqual(strict, true)
        strictEqual(parameters.additionalProperties, false)
        deepStrictEqual(parameters.required, ["query", "limit"])
      }).pipe(Effect.provide(makeTestLayer({
        body: {
          choices: [{
            finish_reason: "tool_calls",
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "StrictTool", arguments: JSON.stringify({ query: "search", limit: null }) }
              }]
            }
          }]
        }
      }))))
  })

  it.effect("model provides openrouter provider metadata", () =>
    Effect.gen(function*() {
      strictEqual(yield* Model.ProviderName, "openrouter")
    }).pipe(
      Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")),
      Effect.provide(makeTestLayer())
    ))

  describe("generateText", () => {
    it.effect("generates distinct IDs for tool calls without IDs and preserves supplied IDs", () =>
      Effect.gen(function*() {
        const toolkit = Toolkit.make(Tool.make("ProbeTool", {
          parameters: Schema.Struct({ a: Schema.Number }),
          success: Schema.String
        }))
        const response = yield* LanguageModel.generateText({
          prompt: "call the tools",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini")),
          Effect.provide(toolkit.toLayer({ ProbeTool: () => Effect.succeed("ok") })),
          Effect.provide(makeTestLayer({
            body: {
              id: "response-1",
              choices: [{
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { type: "function", function: { name: "ProbeTool", arguments: "{\"a\":1}" } },
                    { type: "function", function: { name: "ProbeTool", arguments: "{\"a\":2}" } },
                    { id: "provided-id", type: "function", function: { name: "ProbeTool", arguments: "{\"a\":3}" } }
                  ]
                }
              }]
            }
          }))
        )
        deepStrictEqual(response.toolCalls.map(({ id, name, params }) => ({ id, name, params })), [
          { id: "response-1_tool_0", name: "ProbeTool", params: { a: 1 } },
          { id: "response-1_tool_1", name: "ProbeTool", params: { a: 2 } },
          { id: "provided-id", name: "ProbeTool", params: { a: 3 } }
        ])
      }))

    describe("message preparation", () => {
      describe("audio file parts", () => {
        it.effect("converts audio bytes to input_audio", () =>
          Effect.gen(function*() {
            const audioData = new Uint8Array([0x49, 0x44, 0x33, 0x04]) // ID3v2 magic bytes

            yield* LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "user",
                content: [
                  Prompt.filePart({
                    mediaType: "audio/mpeg",
                    data: audioData
                  })
                ]
              }])
            }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

            const requests = yield* MockHttpClient.requests
            const body = yield* getRequestBody(requests[0])

            const userMessage = body.messages.find((message: any) => message.role === "user")
            deepStrictEqual(userMessage.content, [{
              type: "input_audio",
              input_audio: {
                data: "SUQzBA==",
                format: "mp3"
              }
            }])
          }).pipe(Effect.provide(makeTestLayer())))

        it.effect("converts base64 data url audio to input_audio", () =>
          Effect.gen(function*() {
            yield* LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "user",
                content: [
                  Prompt.filePart({
                    mediaType: "audio/wav",
                    data: "data:audio/wav;base64,UklGRg=="
                  })
                ]
              }])
            }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

            const requests = yield* MockHttpClient.requests
            const body = yield* getRequestBody(requests[0])

            const userMessage = body.messages.find((message: any) => message.role === "user")
            deepStrictEqual(userMessage.content, [{
              type: "input_audio",
              input_audio: {
                data: "UklGRg==",
                format: "wav"
              }
            }])
          }).pipe(Effect.provide(makeTestLayer())))

        it.effect("maps audio media types to OpenRouter audio formats", () =>
          Effect.gen(function*() {
            const mediaTypes: ReadonlyArray<readonly [mediaType: string, format: string]> = [
              ["audio/aac", "aac"],
              ["audio/x-aiff", "aiff"],
              ["audio/flac", "flac"],
              ["audio/L16", "pcm16"],
              ["audio/mp4", "m4a"],
              ["audio/mp3", "mp3"],
              ["audio/ogg", "ogg"],
              ["audio/x-wav", "wav"]
            ]

            yield* LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "user",
                content: mediaTypes.map(([mediaType]) =>
                  Prompt.filePart({
                    mediaType,
                    data: new Uint8Array([0x00])
                  })
                )
              }])
            }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

            const requests = yield* MockHttpClient.requests
            const body = yield* getRequestBody(requests[0])

            const userMessage = body.messages.find((message: any) => message.role === "user")
            deepStrictEqual(
              userMessage.content.map((item: any) => item.input_audio.format),
              mediaTypes.map(([, format]) => format)
            )
          }).pipe(Effect.provide(makeTestLayer())))

        it.effect("fails on unsupported audio media types", () =>
          Effect.gen(function*() {
            const error = yield* LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "user",
                content: [
                  Prompt.filePart({
                    mediaType: "audio/webm",
                    data: new Uint8Array([0x00])
                  })
                ]
              }])
            }).pipe(
              Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")),
              Effect.flip
            )

            strictEqual(error.reason._tag, "InvalidUserInputError")
            assert.include(error.message, "audio/webm")
          }).pipe(Effect.provide(makeTestLayer())))

        it.effect("fails on audio URLs", () =>
          Effect.gen(function*() {
            const error = yield* LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "user",
                content: [
                  Prompt.filePart({
                    mediaType: "audio/mpeg",
                    data: new URL("https://example.com/audio.mp3")
                  })
                ]
              }])
            }).pipe(
              Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")),
              Effect.flip
            )

            strictEqual(error.reason._tag, "InvalidUserInputError")
          }).pipe(Effect.provide(makeTestLayer())))

        it.effect("converts non-audio files to file blocks", () =>
          Effect.gen(function*() {
            const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF

            yield* LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "user",
                content: [
                  Prompt.filePart({
                    mediaType: "application/pdf",
                    fileName: "document.pdf",
                    data: pdfData
                  })
                ]
              }])
            }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

            const requests = yield* MockHttpClient.requests
            const body = yield* getRequestBody(requests[0])

            const userMessage = body.messages.find((message: any) => message.role === "user")
            deepStrictEqual(userMessage.content, [{
              type: "file",
              file: {
                filename: "document.pdf",
                file_data: "data:application/pdf;base64,JVBERg=="
              }
            }])
          }).pipe(Effect.provide(makeTestLayer())))
      })

      it.effect("sends base64 string image and file data as data URLs", () =>
        Effect.gen(function*() {
          yield* LanguageModel.generateText({
            prompt: Prompt.make([{
              role: "user",
              content: [
                Prompt.filePart({ mediaType: "image/png", data: "iVBORw0KGgo=" }),
                Prompt.filePart({ mediaType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=" }),
                Prompt.filePart({ mediaType: "image/png", data: "https://example.com/image.png" }),
                Prompt.filePart({ mediaType: "application/pdf", fileName: "document.pdf", data: "JVBERg==" })
              ]
            }])
          }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

          const requests = yield* MockHttpClient.requests
          const body = yield* getRequestBody(requests[0])

          const userMessage = body.messages.find((message: any) => message.role === "user")
          deepStrictEqual(userMessage.content, [
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
            { type: "image_url", image_url: { url: "https://example.com/image.png" } },
            {
              type: "file",
              file: { filename: "document.pdf", file_data: "data:application/pdf;base64,JVBERg==" }
            }
          ])
        }).pipe(Effect.provide(makeTestLayer())))

      it.effect("preserves string tool results", () =>
        Effect.gen(function*() {
          yield* LanguageModel.generateText({
            prompt: Prompt.make([
              { role: "user", content: "Use the tool" },
              {
                role: "assistant",
                content: [Prompt.toolCallPart({
                  id: "call_text",
                  name: "text_tool",
                  params: {},
                  providerExecuted: false
                })]
              },
              {
                role: "tool",
                content: [Prompt.toolResultPart({
                  id: "call_text",
                  name: "text_tool",
                  result: "PLAIN_TEXT_SENTINEL\n",
                  isFailure: false,
                  providerExecuted: false
                })]
              }
            ]),
            disableToolCallResolution: true
          }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

          const requests = yield* MockHttpClient.requests
          const body = yield* getRequestBody(requests[0])
          const toolResult = body.messages.find((message: any) => message.role === "tool")

          assert.isDefined(toolResult)
          strictEqual(toolResult.content, "PLAIN_TEXT_SENTINEL\n")
        }).pipe(Effect.provide(makeTestLayer())))

      const modelOutputCases = [
        {
          label: "as ordered items with the breakpoint on the final image",
          options: { openrouter: { cacheControl: { type: "ephemeral" as const } } },
          modelOutput: [
            Prompt.textPart({ text: "Screenshot" }),
            Prompt.textPart({ text: "" }),
            Prompt.filePart({ mediaType: "image/png", data: "iVBORw0KGgo=" })
          ],
          content: [
            { type: "text", text: "Screenshot" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
              cache_control: { type: "ephemeral" }
            }
          ]
        },
        {
          label: "as joined text when it has only text",
          modelOutput: [Prompt.textPart({ text: "First" }), Prompt.textPart({ text: "Second" })],
          content: "First\nSecond"
        },
        { label: "as an empty string when it is empty", modelOutput: [], content: "" }
      ]

      for (const { content, label, modelOutput, options } of modelOutputCases) {
        it.effect(`sends tool result model output ${label}`, () =>
          Effect.gen(function*() {
            yield* LanguageModel.generateText({
              prompt: Prompt.make([
                { role: "user", content: "Use the tool" },
                {
                  role: "assistant",
                  content: [Prompt.toolCallPart({
                    id: "call_image",
                    name: "image_tool",
                    params: {},
                    providerExecuted: false
                  })]
                },
                {
                  role: "tool",
                  content: [Prompt.toolResultPart({
                    id: "call_image",
                    name: "image_tool",
                    result: { output: "APPLICATION_ONLY" },
                    options,
                    modelOutput,
                    isFailure: false,
                    providerExecuted: false
                  })]
                }
              ]),
              disableToolCallResolution: true
            }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

            const requests = yield* MockHttpClient.requests
            const body = yield* getRequestBody(requests[0])
            const toolResult = body.messages.find((message: any) => message.role === "tool")

            deepStrictEqual(toolResult?.content, content)
          }).pipe(Effect.provide(makeTestLayer())))
      }

      describe("cache control", () => {
        const ephemeral = { type: "ephemeral" } as const
        const oneHour = { type: "ephemeral", ttl: "1h" } as const
        const cached = { openrouter: { cacheControl: ephemeral } }
        const partCached = { openrouter: { cacheControl: oneHour } }

        it.effect("sends cached void tool results without throwing", () =>
          Effect.gen(function*() {
            yield* LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "tool",
                content: [Prompt.toolResultPart({
                  id: "call_void",
                  name: "void_tool",
                  result: undefined,
                  isFailure: false,
                  providerExecuted: false
                })],
                options: cached
              }]),
              disableToolCallResolution: true
            }).pipe(Effect.provide(OpenRouterLanguageModel.model("anthropic/claude-sonnet-4.5")))

            const requests = yield* MockHttpClient.requests
            const body = yield* getRequestBody(requests[0])
            const toolResult = body.messages.find((message: any) => message.role === "tool")
            strictEqual(toolResult.tool_call_id, "call_void")
          }).pipe(Effect.provide(makeTestLayer())))

        for (const partLevel of [false, true]) {
          it.effect(
            partLevel
              ? "preserves part breakpoints and prefers them to message breakpoints"
              : "puts message breakpoints on the last assistant text and tool result",
            () =>
              Effect.gen(function*() {
                yield* LanguageModel.generateText({
                  prompt: Prompt.make([
                    { role: "user", content: "Look up both" },
                    {
                      role: "assistant",
                      content: [
                        Prompt.reasoningPart({ text: "Thinking" }),
                        Prompt.textPart({ text: "First", options: partLevel ? partCached : undefined }),
                        Prompt.textPart({ text: "Second" }),
                        Prompt.textPart({ text: "Last", options: partLevel ? partCached : undefined }),
                        ...["a", "b", "c"].map((id) =>
                          Prompt.toolCallPart({ id, name: "lookup", params: {}, providerExecuted: false })
                        )
                      ],
                      options: cached
                    },
                    {
                      role: "tool",
                      content: [
                        ...["a", "b", "c"].map((id) =>
                          Prompt.toolResultPart({
                            id,
                            name: "lookup",
                            result: id === "c" ? { value: 42 } : id,
                            isFailure: false,
                            providerExecuted: false,
                            options: partLevel && id !== "b" ? partCached : undefined
                          })
                        ),
                        Prompt.toolApprovalResponsePart({ approvalId: "approval", approved: true })
                      ],
                      options: cached
                    }
                  ]),
                  disableToolCallResolution: true
                }).pipe(Effect.provide(OpenRouterLanguageModel.model("anthropic/claude-sonnet-4.5")))

                const requests = yield* MockHttpClient.requests
                const body = yield* getRequestBody(requests[0])
                const assistant = body.messages.find((message: any) => message.role === "assistant")
                deepStrictEqual(assistant.content, [
                  partLevel
                    ? { type: "text", text: "First", cache_control: oneHour }
                    : { type: "text", text: "First" },
                  { type: "text", text: "Second" },
                  { type: "text", text: "Last", cache_control: partLevel ? oneHour : ephemeral }
                ])
                strictEqual(assistant.reasoning, "Thinking")
                deepStrictEqual(assistant.tool_calls, [
                  { id: "a", type: "function", function: { name: "lookup", arguments: "{}" } },
                  { id: "b", type: "function", function: { name: "lookup", arguments: "{}" } },
                  { id: "c", type: "function", function: { name: "lookup", arguments: "{}" } }
                ])
                deepStrictEqual(body.messages.filter((message: any) => message.role === "tool"), [
                  {
                    role: "tool",
                    tool_call_id: "a",
                    content: partLevel ? [{ type: "text", text: "a", cache_control: oneHour }] : "a"
                  },
                  { role: "tool", tool_call_id: "b", content: "b" },
                  {
                    role: "tool",
                    tool_call_id: "c",
                    content: [{ type: "text", text: "{\"value\":42}", cache_control: partLevel ? oneHour : ephemeral }]
                  }
                ])
              }).pipe(Effect.provide(makeTestLayer()))
          )
        }
      })
    })

    describe("tool preparation", () => {
      it.effect("passes raw JSON schema for dynamic tools", () =>
        Effect.gen(function*() {
          const inputSchema = {
            properties: {
              query: { type: "string" }
            }
          } as const

          const DynamicTool = Tool.dynamic("DynamicTool", {
            description: "A dynamic tool",
            parameters: inputSchema
          })

          yield* LanguageModel.generateText({
            prompt: "Use the dynamic tool",
            toolkit: Toolkit.make(DynamicTool),
            disableToolCallResolution: true
          }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

          const requests = yield* MockHttpClient.requests
          const body = yield* getRequestBody(requests[0])

          const tool = body.tools?.find((entry: any) =>
            entry.type === "function" && entry.function.name === "DynamicTool"
          )
          assert.isDefined(tool)
          strictEqual(tool.function.description, "A dynamic tool")
          deepStrictEqual(tool.function.parameters, inputSchema)
        }).pipe(Effect.provide(makeTestLayer())))

      it.effect("preserves JSON content schemas for non-strict tools on default models", () =>
        Effect.gen(function*() {
          const JsonTool = Tool.make("JsonTool", {
            parameters: Schema.Struct({ payload: Schema.fromJsonString(Schema.Boolean) })
          }).annotate(Tool.Strict, false)

          yield* LanguageModel.generateText({
            prompt: "Use the tool",
            toolkit: Toolkit.make(JsonTool),
            disableToolCallResolution: true
          }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

          const requests = yield* MockHttpClient.requests
          const body = yield* getRequestBody(requests[0])
          deepStrictEqual(body.tools[0].function.parameters.properties.payload, {
            type: "string",
            contentMediaType: "application/json",
            contentSchema: { type: "boolean" }
          })
        }).pipe(Effect.provide(makeTestLayer())))

      it.effect("passes object union parameters through", () =>
        Effect.gen(function*() {
          const UnionTool = Tool.make("UnionTool", {
            parameters: Schema.Union([
              Schema.Struct({ query: Schema.String }).annotate({ identifier: "Query" }),
              Schema.Struct({ id: Schema.String })
            ])
          })

          yield* LanguageModel.generateText({
            prompt: "Use the tool",
            toolkit: Toolkit.make(UnionTool),
            disableToolCallResolution: true
          }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")))

          const requests = yield* MockHttpClient.requests
          const body = yield* getRequestBody(requests[0])

          deepStrictEqual(body.tools[0].function.parameters, {
            anyOf: [
              { $ref: "#/$defs/Query" },
              { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: true }
            ],
            $defs: {
              Query: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: true
              }
            }
          })
        }).pipe(Effect.provide(makeTestLayer())))

      it.effect("names the tool when its parameters are not an object schema", () =>
        Effect.gen(function*() {
          const error = yield* LanguageModel.generateText({
            prompt: "Use the tool",
            toolkit: Toolkit.make(Tool.make("NoParams", { parameters: Schema.Struct({}) })),
            disableToolCallResolution: true
          }).pipe(Effect.provide(OpenRouterLanguageModel.model("google/gemini-2.5-flash")), Effect.flip)

          strictEqual(error.reason._tag, "UnsupportedSchemaError")
          assert.include(error.message, `"NoParams"`)
          assert.include(error.message, "Tool.EmptyParams")
        }).pipe(Effect.provide(makeTestLayer())))
    })

    it.effect("reports a refusal through the finish part", () =>
      Effect.gen(function*() {
        const result = yield* LanguageModel.generateText({ prompt: "Do something bad" }).pipe(
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o"))
        )

        const finishPart = result.content.find((part) => part.type === "finish")
        deepStrictEqual({
          text: result.text,
          finishReason: result.finishReason,
          refusal: finishPart?.metadata.openrouter?.refusal
        }, {
          text: "",
          finishReason: "content-filter",
          refusal: "I cannot do that"
        })
      }).pipe(Effect.provide(makeTestLayer({
        body: {
          choices: [{
            finish_reason: "stop",
            index: 0,
            message: { role: "assistant", content: null, refusal: "I cannot do that" }
          }]
        }
      }))))

    describe("usage", () => {
      it.effect("derives text and uncached tokens when details are subsets of their totals", () =>
        Effect.gen(function*() {
          const result = yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
            Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini"))
          )

          deepStrictEqual(
            result.usage.inputTokens,
            { uncached: 70, total: 100, cacheRead: 30, cacheWrite: 0 },
            "subset input usage"
          )
          deepStrictEqual(result.usage.outputTokens, { total: 50, text: 30, reasoning: 20 }, "subset output usage")
        }).pipe(Effect.provide(makeTestLayer({
          body: {
            usage: {
              prompt_tokens: 100,
              prompt_tokens_details: { cached_tokens: 30 },
              completion_tokens: 50,
              completion_tokens_details: { reasoning_tokens: 20 },
              total_tokens: 150
            }
          }
        }))))

      it.effect("preserves totals when detail counts equal their parent counts", () =>
        Effect.gen(function*() {
          const result = yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
            Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini"))
          )

          deepStrictEqual(
            result.usage.inputTokens,
            { uncached: 0, total: 100, cacheRead: 100, cacheWrite: 0 },
            "input usage at equality"
          )
          deepStrictEqual(result.usage.outputTokens, { total: 20, text: 0, reasoning: 20 }, "output usage at equality")
        }).pipe(Effect.provide(makeTestLayer({
          body: {
            usage: {
              prompt_tokens: 100,
              prompt_tokens_details: { cached_tokens: 100 },
              completion_tokens: 20,
              completion_tokens_details: { reasoning_tokens: 20 },
              total_tokens: 120
            }
          }
        }))))

      it.effect("treats reasoning tokens as disjoint when they exceed completion tokens", () =>
        Effect.gen(function*() {
          const result = yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
            Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini"))
          )

          deepStrictEqual(result.usage.outputTokens, { total: 30, text: 10, reasoning: 20 }, "disjoint reasoning usage")
        }).pipe(Effect.provide(makeTestLayer({
          body: {
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              completion_tokens_details: { reasoning_tokens: 20 },
              total_tokens: 110
            }
          }
        }))))

      it.effect("treats cached tokens as disjoint when they exceed prompt tokens", () =>
        Effect.gen(function*() {
          const result = yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
            Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini"))
          )

          deepStrictEqual(
            result.usage.inputTokens,
            { uncached: 100, total: 400, cacheRead: 300, cacheWrite: 0 },
            "disjoint cached usage"
          )
        }).pipe(Effect.provide(makeTestLayer({
          body: {
            usage: {
              prompt_tokens: 100,
              prompt_tokens_details: { cached_tokens: 300 },
              completion_tokens: 10,
              total_tokens: 110
            }
          }
        }))))
    })
  })

  describe("streamText", () => {
    it.effect("retains the serving provider when the final usage chunk omits it", () =>
      Effect.gen(function*() {
        const chunk = { id: "response-1", object: "chat.completion.chunk", model: "openai/gpt-4o", created: 1 } as const
        const parts = yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runCollect,
          Effect.provide(OpenRouterLanguageModel.model(chunk.model)),
          Effect.provide(makeStreamTestLayer([
            {
              ...chunk,
              provider: "OpenAI",
              choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }]
            },
            { ...chunk, choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }
          ]))
        )

        strictEqual(parts.find((part) => part.type === "finish")?.metadata.openrouter?.provider, "OpenAI")
      }))

    describe("usage", () => {
      it.effect("treats streamed reasoning tokens as disjoint when they exceed completion tokens", () =>
        Effect.gen(function*() {
          const parts = yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
            Stream.runCollect,
            Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini")),
            Effect.provide(makeStreamTestLayer([{
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o-mini",
              created: 1,
              choices: [],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                completion_tokens_details: { reasoning_tokens: 20 },
                total_tokens: 110
              }
            }]))
          )

          const finishPart = parts.find((part) => part.type === "finish")
          deepStrictEqual(
            finishPart?.usage.outputTokens,
            { total: 30, text: 10, reasoning: 20 },
            "streamed disjoint reasoning usage"
          )
        }))
    })

    it.effect("preserves streamed citation start and end indexes", () =>
      Effect.gen(function*() {
        const parts = yield* LanguageModel.streamText({ prompt: "cite a source" }).pipe(
          Stream.runCollect,
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini")),
          Effect.provide(makeStreamTestLayer([{
            id: "response-1",
            object: "chat.completion.chunk",
            model: "openai/gpt-4o-mini",
            created: 1,
            choices: [{
              index: 0,
              delta: {
                annotations: [{
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.com/source",
                    title: "source",
                    start_index: 2,
                    end_index: 9
                  }
                }]
              }
            }]
          }]))
        )

        const source = globalThis.Array.from(parts).find((part) => part.type === "source")
        assert.isDefined(source)
        if (source?.type === "source") {
          assert.deepStrictEqual(source.metadata, {
            openrouter: { startIndex: 2, endIndex: 9 }
          })
        }
      }))

    it.effect("uses lowercase openrouter reasoning-end metadata", () =>
      Effect.gen(function*() {
        const reasoningDetails = [{
          type: "reasoning.text",
          text: "thinking",
          signature: "signature-final",
          format: "unknown"
        }] as const
        const parts = yield* LanguageModel.streamText({ prompt: "reason then answer" }).pipe(
          Stream.runCollect,
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini")),
          Effect.provide(makeStreamTestLayer([
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o-mini",
              created: 1,
              choices: [{ index: 0, delta: { reasoning_details: reasoningDetails } }]
            },
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o-mini",
              created: 1,
              choices: [{ index: 0, finish_reason: "stop", delta: { content: "answer" } }]
            }
          ]))
        )

        const reasoningEnd = parts.find((part) => part.type === "reasoning-end")
        deepStrictEqual(reasoningEnd?.metadata, { openrouter: { reasoningDetails } })
      }))

    it.effect("keeps streamed reasoning in one part when content deltas are empty", () =>
      Effect.gen(function*() {
        const parts = yield* LanguageModel.streamText({ prompt: "reason then answer" }).pipe(
          Stream.runCollect,
          Effect.provide(OpenRouterLanguageModel.model("deepseek/deepseek-v4-flash")),
          Effect.provide(makeStreamTestLayer([
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "deepseek/deepseek-v4-flash",
              created: 1,
              choices: [{ index: 0, delta: { content: "", reasoning: "Thinking" } }]
            },
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "deepseek/deepseek-v4-flash",
              created: 1,
              choices: [{ index: 0, delta: { content: "", reasoning: " it over" } }]
            },
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "deepseek/deepseek-v4-flash",
              created: 1,
              choices: [{ index: 0, finish_reason: "stop", delta: { content: "Answer" } }],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
            }
          ]))
        )

        deepStrictEqual(
          parts.flatMap((part) =>
            part.type.startsWith("reasoning-") || part.type.startsWith("text-")
              ? ["delta" in part ? `${part.type}:${part.delta}` : part.type]
              : []
          ),
          [
            "reasoning-start",
            "reasoning-delta:Thinking",
            "reasoning-delta: it over",
            "reasoning-end",
            "text-start",
            "text-delta:Answer",
            "text-end"
          ]
        )
      }))

    it.effect("streams a refusal through the finish part", () =>
      Effect.gen(function*() {
        const parts = yield* LanguageModel.streamText({ prompt: "Do something bad" }).pipe(
          Stream.runCollect,
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o")),
          Effect.provide(makeStreamTestLayer([
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o",
              created: 1,
              choices: [{ index: 0, delta: { content: "", refusal: "I cannot", role: "assistant" } }]
            },
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o",
              created: 1,
              choices: [{ index: 0, delta: { content: "", refusal: " do that" } }]
            },
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o",
              created: 1,
              choices: [{ index: 0, finish_reason: "stop", delta: { content: "" } }],
              usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
            }
          ]))
        )

        const finishPart = parts.find((part) => part.type === "finish")
        deepStrictEqual({
          textParts: parts.filter((part) => part.type.startsWith("text-")).map((part) => part.type),
          reason: finishPart?.reason,
          refusal: finishPart?.metadata.openrouter?.refusal
        }, {
          textParts: [],
          reason: "content-filter",
          refusal: "I cannot do that"
        })
      }))

    it.effect("streams parallel tool calls without indices exactly once", () =>
      Effect.gen(function*() {
        const toolkit = Toolkit.make(Tool.make("ProbeTool", {
          parameters: Schema.Struct({ a: Schema.Number }),
          success: Schema.String
        }))
        const metadata = {
          id: "response-1",
          object: "chat.completion.chunk" as const,
          model: "openai/gpt-4o-mini",
          created: 1
        }
        const parts = yield* LanguageModel.streamText({
          prompt: "call the tools",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runCollect,
          Effect.provide(OpenRouterLanguageModel.model(metadata.model)),
          Effect.provide(toolkit.toLayer({ ProbeTool: () => Effect.succeed("ok") })),
          Effect.provide(makeStreamTestLayer([
            {
              ...metadata,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [
                    { id: "call-1", type: "function", function: { name: "ProbeTool", arguments: "{\"a\":" } },
                    { id: "call-2", type: "function", function: { name: "ProbeTool", arguments: "{\"a\":" } }
                  ]
                }
              }]
            },
            {
              ...metadata,
              choices: [{
                index: 0,
                finish_reason: "tool_calls",
                delta: {
                  tool_calls: [
                    { function: { arguments: "1}" } },
                    { function: { arguments: "2}" } }
                  ]
                }
              }]
            },
            {
              ...metadata,
              choices: [],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
            }
          ]))
        )
        deepStrictEqual(
          parts.filter((part) => part.type === "tool-call").map(({ id, name, params }) => ({ id, name, params })),
          [
            { id: "call-1", name: "ProbeTool", params: { a: 1 } },
            { id: "call-2", name: "ProbeTool", params: { a: 2 } }
          ]
        )
      }))

    it.effect("emits incremental tool parameter fragments", () =>
      Effect.gen(function*() {
        const ProbeTool = Tool.make("ProbeTool", {
          parameters: Schema.Struct({ tags: Schema.Record(Schema.String, Schema.Number) }),
          success: Schema.String
        })
        const toolkit = Toolkit.make(ProbeTool)
        const parts = yield* LanguageModel.streamText({
          prompt: "call the tool",
          toolkit
        }).pipe(
          Stream.runCollect,
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini")),
          Effect.provide(toolkit.toLayer({
            ProbeTool: (params) => {
              deepStrictEqual(params, { tags: { a: 1 } })
              return Effect.succeed("ok")
            }
          })),
          Effect.provide(makeStreamTestLayer([
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o-mini",
              created: 1,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "ProbeTool", arguments: "{\"tags\":[{\"0\":\"a\"," }
                  }]
                }
              }]
            },
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o-mini",
              created: 1,
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0 }] }
              }]
            },
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o-mini",
              created: 1,
              choices: [{
                index: 0,
                finish_reason: "tool_calls",
                delta: { tool_calls: [{ index: 0, function: { arguments: "\"1\":1}]}" } }] }
              }]
            }
          ]))
        )

        deepStrictEqual(
          globalThis.Array.from(parts)
            .filter((part) => part.type === "tool-params-delta")
            .map((part) => part.delta),
          ["{\"tags\":[{\"0\":\"a\",", "\"1\":1}]}"]
        )
        deepStrictEqual(
          parts.filter((part) => part.type === "tool-result").map((part) => [part.isFailure, part.result]),
          [[false, "ok"]]
        )
      }))

    it.effect("fails when the response ends before a tool call's parameters are complete", () =>
      Effect.gen(function*() {
        const ProbeTool = Tool.make("ProbeTool", {
          parameters: Schema.Struct({ a: Schema.String }),
          success: Schema.String
        })
        const toolkit = Toolkit.make(ProbeTool)
        const error = yield* LanguageModel.streamText({
          prompt: "call the tool",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini")),
          Effect.provide(toolkit.toLayer({ ProbeTool: () => Effect.succeed("ok") })),
          Effect.provide(makeStreamTestLayer([
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o-mini",
              created: 1,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "ProbeTool", arguments: "{\"a\":\"trunc" }
                  }]
                }
              }]
            },
            {
              id: "response-1",
              object: "chat.completion.chunk",
              model: "openai/gpt-4o-mini",
              created: 1,
              choices: [{ index: 0, finish_reason: "length", delta: {} }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            }
          ]))
        )

        strictEqual(error.reason._tag, "ToolParameterValidationError")
      }))

    it.effect("ignores an empty fragment after a tool call completes", () =>
      Effect.gen(function*() {
        const ProbeTool = Tool.make("ProbeTool", {
          parameters: Schema.Struct({ a: Schema.Number }),
          success: Schema.String
        })
        const toolkit = Toolkit.make(ProbeTool)
        const parts = yield* LanguageModel.streamText({
          prompt: "call the tool",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runCollect,
          Effect.provide(OpenRouterLanguageModel.model("openai/gpt-4o-mini")),
          Effect.provide(toolkit.toLayer({ ProbeTool: () => Effect.succeed("ok") })),
          Effect.provide(makeStreamTestLayer([
            {
              index: 0,
              id: "call-1",
              type: "function" as const,
              function: { name: "ProbeTool", arguments: "{\"a\":1}" }
            },
            { index: 0, function: { arguments: "" } }
          ].map((toolCall) => ({
            id: "response-1",
            object: "chat.completion.chunk" as const,
            model: "openai/gpt-4o-mini",
            created: 1,
            choices: [{ index: 0, delta: { tool_calls: [toolCall] } }]
          }))))
        )

        deepStrictEqual(
          parts.filter((part) => part.type === "tool-call").map((part) => [part.id, part.params]),
          [["call-1", { a: 1 }]]
        )
      }))
  })
})

// =============================================================================
// Test Infrastructure
// =============================================================================

class MockOpenRouterResponse extends Context.Service<MockOpenRouterResponse, {
  readonly status: number
  readonly body: typeof Generated.SendChatCompletionRequest200.Type
  readonly headers?: Record<string, string> | undefined
}>()("MockOpenRouterResponse") {}

class MockHttpClient extends Context.Service<MockHttpClient, {
  readonly requests: Effect.Effect<ReadonlyArray<HttpClientRequest.HttpClientRequest>>
}>()("MockHttpClient") {
  static requests = Effect.service(MockHttpClient).pipe(
    Effect.flatMap((client) => client.requests)
  )
}

const encodeResponse = Schema.encodeEffect(Generated.SendChatCompletionRequest200)

const makeHttpClient = Effect.gen(function*() {
  const capturedRequests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([])
  const response = yield* MockOpenRouterResponse
  const body = yield* Effect.orDie(encodeResponse(response.body))

  const httpClient = HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      yield* Ref.update(capturedRequests, Array.append(request))
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          headers: response.headers ?? {},
          status: response.status
        })
      )
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )

  return Context.make(HttpClient.HttpClient, httpClient).pipe(
    Context.add(MockHttpClient, MockHttpClient.of({ requests: Ref.get(capturedRequests) }))
  )
})

const HttpClientLayer = Layer.effectContext(makeHttpClient)

const makeDefaultResponse = (
  overrides: Partial<typeof Generated.SendChatCompletionRequest200.Type> = {}
): typeof Generated.SendChatCompletionRequest200.Type => ({
  id: "gen-test123",
  choices: [{
    finish_reason: "stop",
    index: 0,
    message: {
      role: "assistant",
      content: "Hello!"
    }
  }],
  created: 1234567890,
  model: "google/gemini-2.5-flash",
  object: "chat.completion",
  system_fingerprint: null,
  ...overrides
})

const makeTestLayer = (options: {
  readonly body?: Partial<typeof Generated.SendChatCompletionRequest200.Type>
  readonly status?: number
  readonly headers?: Record<string, string>
} = {}) =>
  OpenRouterClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
    Layer.provideMerge(HttpClientLayer),
    Layer.provide(Layer.succeed(MockOpenRouterResponse, {
      body: makeDefaultResponse(options.body),
      status: options.status ?? 200,
      headers: options.headers ?? {}
    }))
  )

const getRequestBody = Effect.fnUntraced(function*(request: HttpClientRequest.HttpClientRequest) {
  const body = request.body
  if (body._tag === "Uint8Array") {
    const text = new TextDecoder().decode(body.body)
    return JSON.parse(text)
  }
  return yield* Effect.die(new Error("Expected Uint8Array body"))
})

const makeStreamTestLayer = (events: ReadonlyArray<typeof Generated.ChatStreamChunk.Encoded>) => {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
  const httpClientLayer = Layer.effectContext(Effect.gen(function*() {
    const capturedRequests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([])
    const httpClient = HttpClient.makeWith(
      Effect.fnUntraced(function*(requestEffect) {
        const request = yield* requestEffect
        yield* Ref.update(capturedRequests, Array.append(request))
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
      }),
      Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
    )
    return Context.make(HttpClient.HttpClient, httpClient).pipe(
      Context.add(MockHttpClient, MockHttpClient.of({ requests: Ref.get(capturedRequests) }))
    )
  }))
  return OpenRouterClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
    Layer.provideMerge(httpClientLayer)
  )
}
