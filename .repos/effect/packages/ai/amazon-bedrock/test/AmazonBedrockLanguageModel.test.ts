import { AmazonBedrockClient, AmazonBedrockLanguageModel } from "@effect/ai-amazon-bedrock"
import { assert, describe, it } from "@effect/vitest"
import { assertDefined } from "@effect/vitest/utils"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Prompt, type Response as AiResponse, Tool, Toolkit } from "effect/ai"
import { Digest, Mac, SecureRandom } from "effect/crypto"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { concat, eventFrame } from "./utils.ts"

const model = "anthropic.claude-3-haiku-20240307-v1:0"
const encodedModel = "anthropic.claude-3-haiku-20240307-v1%3A0"

const usage: Record<string, number> = { inputTokens: 7, outputTokens: 3, totalTokens: 10 }

const converseResponse = (content: ReadonlyArray<unknown>, stopReason = "end_turn", responseUsage = usage) => ({
  output: { message: { role: "assistant", content } },
  stopReason,
  usage: responseUsage,
  metrics: { latencyMs: 1 }
})

const Weather = Tool.make("Weather", {
  description: "Get the weather",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.String
})

const toolkit = Toolkit.make(Weather)

describe("AmazonBedrockLanguageModel", () => {
  describe("generateText", () => {
    it.effect("sends the prompt and config as a Converse request and decodes the reply", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(
            request,
            converseResponse([{ text: "Hi" }], "end_turn", {
              ...usage,
              cacheReadInputTokens: 2,
              cacheWriteInputTokens: 1
            })
          ))
        )

        const response = yield* LanguageModel.generateText({
          prompt: Prompt.make([
            { role: "system", content: "Be brief" },
            { role: "user", content: "Hello" }
          ])
        }).pipe(
          Effect.provide(AmazonBedrockLanguageModel.model(model, {
            inferenceConfig: { maxTokens: 100, temperature: 0.5 },
            additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 1024 } }
          })),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        assert.isTrue(request.url.endsWith(`/model/${encodedModel}/converse`))
        const body = yield* getRequestBody(request)
        assert.notProperty(body, "modelId")
        assert.deepStrictEqual(body.system, [{ text: "Be brief" }])
        assert.deepStrictEqual(body.messages, [{ role: "user", content: [{ text: "Hello" }] }])
        assert.deepStrictEqual(body.inferenceConfig, { maxTokens: 100, temperature: 0.5 })
        assert.deepStrictEqual(body.additionalModelRequestFields, {
          thinking: { type: "enabled", budget_tokens: 1024 }
        })

        assert.strictEqual(response.text, "Hi")
        assert.strictEqual(response.finishReason, "stop")
        assert.deepStrictEqual(response.usage.inputTokens, { uncached: 7, total: 10, cacheRead: 2, cacheWrite: 1 })
        assert.strictEqual(response.usage.outputTokens.total, 3)
      }))

    const toolChoices: ReadonlyArray<{
      readonly label: string
      readonly toolChoice: LanguageModel.ToolChoice<"Weather">
      readonly expected: unknown
    }> = [
      { label: "auto", toolChoice: "auto", expected: { auto: {} } },
      { label: "required", toolChoice: "required", expected: { any: {} } },
      { label: "a named tool", toolChoice: { tool: "Weather" }, expected: { tool: { name: "Weather" } } }
    ]

    for (const { expected, label, toolChoice } of toolChoices) {
      it.effect(`encodes the toolkit with tool choice ${label}`, () =>
        Effect.gen(function*() {
          const http = makeHttpClient((request) =>
            Effect.succeed(jsonResponse(request, converseResponse([{ text: "Hi" }])))
          )

          yield* LanguageModel.generateText({
            prompt: "What is the weather in SF?",
            toolkit,
            toolChoice,
            disableToolCallResolution: true
          }).pipe(
            Effect.provide(AmazonBedrockLanguageModel.model(model)),
            Effect.provide(http.layer)
          )

          const request = http.requests[0]
          assertDefined(request)
          const body = yield* getRequestBody(request)
          assert.strictEqual(body.toolConfig.tools.length, 1)
          const toolSpec = body.toolConfig.tools[0].toolSpec
          assert.strictEqual(toolSpec.name, "Weather")
          assert.strictEqual(toolSpec.description, "Get the weather")
          assert.strictEqual(toolSpec.inputSchema.json.properties.city.type, "string")
          assert.include(toolSpec.inputSchema.json.required, "city")
          assert.deepStrictEqual(body.toolConfig.toolChoice, expected)
        }))
    }

    it.effect("omits the tool configuration when tool choice is none", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(request, converseResponse([{ text: "Hi" }])))
        )

        yield* LanguageModel.generateText({
          prompt: "Hello",
          toolkit,
          toolChoice: "none",
          disableToolCallResolution: true
        }).pipe(
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        const body = yield* getRequestBody(request)
        assert.notProperty(body, "toolConfig")
      }))

    it.effect("decodes tool use blocks as tool calls", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(
            request,
            converseResponse([
              { text: "Let me check." },
              { toolUse: { toolUseId: "tooluse_1", name: "Weather", input: { city: "SF" } } }
            ], "tool_use")
          ))
        )

        const response = yield* LanguageModel.generateText({
          prompt: "What is the weather in SF?",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        assert.strictEqual(response.text, "Let me check.")
        assert.strictEqual(response.finishReason, "tool-calls")
        assert.strictEqual(response.toolCalls.length, 1)
        assert.strictEqual(response.toolCalls[0].id, "tooluse_1")
        assert.strictEqual(response.toolCalls[0].name, "Weather")
        assert.deepStrictEqual(response.toolCalls[0].params, { city: "SF" })
      }))

    it.effect("sends tool calls and results back as toolUse and toolResult blocks", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(request, converseResponse([{ text: "Done" }])))
        )

        yield* LanguageModel.generateText({
          prompt: Prompt.make([
            { role: "user", content: "Weather in SF, LA, NY and DC?" },
            {
              role: "assistant",
              content: [
                Prompt.toolCallPart({
                  id: "tooluse_1",
                  name: "Weather",
                  params: { city: "SF" },
                  providerExecuted: false
                }),
                Prompt.toolCallPart({
                  id: "tooluse_2",
                  name: "Weather",
                  params: { city: "LA" },
                  providerExecuted: false
                }),
                Prompt.toolCallPart({
                  id: "tooluse_3",
                  name: "Weather",
                  params: { city: "NY" },
                  providerExecuted: false
                }),
                Prompt.toolCallPart({
                  id: "tooluse_4",
                  name: "Weather",
                  params: { city: "DC" },
                  providerExecuted: false
                })
              ]
            },
            {
              role: "tool",
              content: [
                Prompt.toolResultPart({
                  id: "tooluse_1",
                  name: "Weather",
                  result: { temperature: 20 },
                  isFailure: false,
                  providerExecuted: false
                }),
                Prompt.toolResultPart({
                  id: "tooluse_2",
                  name: "Weather",
                  result: "service unavailable",
                  isFailure: true,
                  providerExecuted: false
                }),
                Prompt.toolResultPart({
                  id: "tooluse_3",
                  name: "Weather",
                  result: [],
                  isFailure: false,
                  providerExecuted: false
                }),
                Prompt.toolResultPart({
                  id: "tooluse_4",
                  name: "Weather",
                  result: null,
                  isFailure: false,
                  providerExecuted: false
                })
              ]
            }
          ]),
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        const body = yield* getRequestBody(request)
        assert.deepStrictEqual(body.messages, [
          { role: "user", content: [{ text: "Weather in SF, LA, NY and DC?" }] },
          {
            role: "assistant",
            content: [
              { toolUse: { toolUseId: "tooluse_1", name: "Weather", input: { city: "SF" } } },
              { toolUse: { toolUseId: "tooluse_2", name: "Weather", input: { city: "LA" } } },
              { toolUse: { toolUseId: "tooluse_3", name: "Weather", input: { city: "NY" } } },
              { toolUse: { toolUseId: "tooluse_4", name: "Weather", input: { city: "DC" } } }
            ]
          },
          {
            role: "user",
            content: [
              { toolResult: { toolUseId: "tooluse_1", content: [{ json: { temperature: 20 } }] } },
              { toolResult: { toolUseId: "tooluse_2", content: [{ text: "service unavailable" }], status: "error" } },
              { toolResult: { toolUseId: "tooluse_3", content: [{ text: "[]" }] } },
              { toolResult: { toolUseId: "tooluse_4", content: [{ text: "null" }] } }
            ]
          }
        ])
      }))

    const modelOutputCases = [
      { label: "as text", modelOutput: [Prompt.textPart({ text: "Sunny" })], text: "Sunny" },
      { label: "as empty text when it is empty", modelOutput: [], text: "" }
    ]

    for (const { label, modelOutput, text } of modelOutputCases) {
      it.effect(`sends tool result model output ${label}`, () =>
        Effect.gen(function*() {
          const http = makeHttpClient((request) =>
            Effect.succeed(jsonResponse(request, converseResponse([{ text: "Done" }])))
          )

          yield* LanguageModel.generateText({
            prompt: Prompt.make([
              { role: "user", content: "Weather in SF?" },
              {
                role: "assistant",
                content: [Prompt.toolCallPart({
                  id: "tooluse_1",
                  name: "Weather",
                  params: { city: "SF" },
                  providerExecuted: false
                })]
              },
              {
                role: "tool",
                content: [Prompt.toolResultPart({
                  id: "tooluse_1",
                  name: "Weather",
                  result: { temperature: 20 },
                  modelOutput,
                  isFailure: false,
                  providerExecuted: false
                })]
              }
            ]),
            toolkit,
            disableToolCallResolution: true
          }).pipe(
            Effect.provide(AmazonBedrockLanguageModel.model(model)),
            Effect.provide(http.layer)
          )

          const request = http.requests[0]
          assertDefined(request)
          const body = yield* getRequestBody(request)
          assert.deepStrictEqual(body.messages[2].content, [{
            toolResult: { toolUseId: "tooluse_1", content: [{ text }] }
          }])
        }))
    }

    it.effect("round-trips reasoning blocks with their signature and redacted content", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(
            request,
            converseResponse([
              { reasoningContent: { reasoningText: { text: "Think", signature: "sig" } } },
              { reasoningContent: { redactedContent: "aGlkZGVu" } },
              { text: "Hi" }
            ])
          ))
        )
        const bedrock = AmazonBedrockLanguageModel.model(model)

        const response = yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
          Effect.provide(bedrock),
          Effect.provide(http.layer)
        )

        assert.strictEqual(response.text, "Hi")
        assert.strictEqual(response.reasoning.length, 2)
        assert.strictEqual(response.reasoning[0].text, "Think")
        assert.deepStrictEqual(response.reasoning[0].metadata["amazon-bedrock"], { signature: "sig" })
        assert.strictEqual(response.reasoning[1].text, "")
        assert.deepStrictEqual(response.reasoning[1].metadata["amazon-bedrock"], { redactedContent: "aGlkZGVu" })

        yield* LanguageModel.generateText({
          prompt: Prompt.make([
            { role: "user", content: "Hello" },
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "Think", options: { "amazon-bedrock": { signature: "sig" } } },
                { type: "reasoning", text: "", options: { "amazon-bedrock": { redactedContent: "aGlkZGVu" } } },
                { type: "text", text: "Hi" }
              ]
            },
            { role: "user", content: "Next" }
          ])
        }).pipe(Effect.provide(bedrock), Effect.provide(http.layer))

        const request = http.requests[1]
        assertDefined(request)
        const body = yield* getRequestBody(request)
        assert.deepStrictEqual(body.messages[1], {
          role: "assistant",
          content: [
            { reasoningContent: { reasoningText: { text: "Think", signature: "sig" } } },
            { reasoningContent: { redactedContent: "aGlkZGVu" } },
            { text: "Hi" }
          ]
        })
      }))

    it.effect("appends cache points after system and message content", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(request, converseResponse([{ text: "Hi" }])))
        )
        const cachePoint = { "amazon-bedrock": { cachePoint: { type: "default" as const } } }

        yield* LanguageModel.generateText({
          prompt: Prompt.make([
            { role: "system", content: "Be brief", options: cachePoint },
            { role: "user", content: "Hello", options: cachePoint }
          ])
        }).pipe(
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        const body = yield* getRequestBody(request)
        assert.deepStrictEqual(body.system, [{ text: "Be brief" }, { cachePoint: { type: "default" } }])
        assert.deepStrictEqual(body.messages[0].content, [{ text: "Hello" }, { cachePoint: { type: "default" } }])
      }))

    it.effect("encodes image and document file parts", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(request, converseResponse([{ text: "Hi" }])))
        )
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII="

        yield* LanguageModel.generateText({
          prompt: Prompt.make([
            Prompt.userMessage({
              content: [
                Prompt.filePart({ mediaType: "image/png", data: png }),
                Prompt.filePart({
                  mediaType: "application/pdf",
                  data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
                  fileName: "report"
                }),
                Prompt.textPart({ text: "Summarize these" })
              ]
            })
          ])
        }).pipe(
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        const body = yield* getRequestBody(request)
        assert.deepStrictEqual(body.messages[0].content, [
          { image: { format: "png", source: { bytes: png } } },
          { document: { format: "pdf", name: "report", source: { bytes: "JVBERg==" } } },
          { text: "Summarize these" }
        ])
      }))

    it.effect("rejects unsupported file media types", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(request, converseResponse([{ text: "Hi" }])))
        )

        const error = yield* LanguageModel.generateText({
          prompt: Prompt.make([
            Prompt.userMessage({
              content: [Prompt.filePart({ mediaType: "audio/mpeg", data: new Uint8Array([1, 2, 3]) })]
            })
          ])
        }).pipe(
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer),
          Effect.flip
        )

        assert.strictEqual(error.reason._tag, "InvalidUserInputError")
        assert.strictEqual(http.requests.length, 0)
      }))

    const stopReasons: ReadonlyArray<readonly [string, AiResponse.FinishReason]> = [
      ["end_turn", "stop"],
      ["stop_sequence", "stop"],
      ["tool_use", "tool-calls"],
      ["max_tokens", "length"],
      ["model_context_window_exceeded", "length"],
      ["guardrail_intervened", "content-filter"],
      ["content_filtered", "content-filter"],
      ["some_future_reason", "other"]
    ]

    for (const [stopReason, finishReason] of stopReasons) {
      it.effect(`maps stop reason ${stopReason} to ${finishReason}`, () =>
        Effect.gen(function*() {
          const http = makeHttpClient((request) =>
            Effect.succeed(jsonResponse(request, converseResponse([{ text: "Hi" }], stopReason)))
          )

          const response = yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
            Effect.provide(AmazonBedrockLanguageModel.model(model)),
            Effect.provide(http.layer)
          )

          assert.strictEqual(response.finishReason, finishReason)
        }))
    }
  })

  describe("generateObject", () => {
    const Summary = Schema.Struct({ title: Schema.String })

    it.effect("forces a tool for structured output by default", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(
            request,
            converseResponse([
              { toolUse: { toolUseId: "tooluse_summary", name: "summary", input: { title: "Rain" } } }
            ], "tool_use")
          ))
        )

        const response = yield* LanguageModel.generateObject({
          prompt: "Give a title for a story about rain.",
          objectName: "summary",
          schema: Summary
        }).pipe(
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        const body = yield* getRequestBody(request)
        assert.deepStrictEqual(body.toolConfig.tools.map((tool: any) => tool.toolSpec.name), ["summary"])
        assert.deepStrictEqual(body.toolConfig.toolChoice, { tool: { name: "summary" } })
        assert.notProperty(body, "outputConfig")

        assert.deepStrictEqual(response.value, { title: "Rain" })
        assert.strictEqual(response.finishReason, "stop")
      }))

    it.effect("uses native structured output when structuredOutputs is enabled", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(jsonResponse(request, converseResponse([{ text: JSON.stringify({ title: "Rain" }) }])))
        )

        const response = yield* LanguageModel.generateObject({
          prompt: "Give a title for a story about rain.",
          objectName: "summary",
          schema: Summary
        }).pipe(
          Effect.provide(AmazonBedrockLanguageModel.model(model, { structuredOutputs: true })),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        const body = yield* getRequestBody(request)
        assert.notProperty(body, "toolConfig")
        assert.strictEqual(body.outputConfig.textFormat.type, "json_schema")
        const jsonSchema = body.outputConfig.textFormat.structure.jsonSchema
        assert.strictEqual(jsonSchema.name, "summary")
        assert.strictEqual(JSON.parse(jsonSchema.schema).properties.title.type, "string")

        assert.deepStrictEqual(response.value, { title: "Rain" })
      }))
  })

  describe("streamText", () => {
    it.effect("streams text, tool calls and usage from ConverseStream events", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(eventStreamResponse(request, [
            eventFrame("messageStart", { role: "assistant" }),
            eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }),
            eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: ", world" } }),
            eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
            eventFrame("contentBlockStart", {
              contentBlockIndex: 1,
              start: { toolUse: { toolUseId: "tooluse_1", name: "Weather" } }
            }),
            eventFrame("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: "{\"city\":" } } }),
            eventFrame("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: "\"SF\"}" } } }),
            eventFrame("contentBlockStop", { contentBlockIndex: 1 }),
            eventFrame("messageStop", { stopReason: "tool_use" }),
            eventFrame("metadata", {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 4 },
              metrics: { latencyMs: 1 }
            })
          ]))
        )

        const parts = yield* LanguageModel.streamText({
          prompt: "What is the weather in SF?",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        const request = http.requests[0]
        assertDefined(request)
        assert.isTrue(request.url.endsWith(`/model/${encodedModel}/converse-stream`))

        const text = parts.flatMap((part) => part.type === "text-delta" ? [part.delta] : []).join("")
        assert.strictEqual(text, "Hello, world")

        const toolCall = parts.find((part) => part.type === "tool-call")
        assertDefined(toolCall)
        if (toolCall.type !== "tool-call") return
        assert.strictEqual(toolCall.id, "tooluse_1")
        assert.strictEqual(toolCall.name, "Weather")
        assert.deepStrictEqual(toolCall.params, { city: "SF" })

        const finish = parts.find((part) => part.type === "finish")
        assertDefined(finish)
        if (finish.type !== "finish") return
        assert.strictEqual(finish.reason, "tool-calls")
        assert.deepStrictEqual(finish.usage.inputTokens, {
          uncached: 10,
          total: 14,
          cacheRead: 4,
          cacheWrite: undefined
        })
        assert.strictEqual(finish.usage.outputTokens.total, 5)
      }))

    it.effect("joins redacted reasoning streamed as several base64 chunks", () =>
      Effect.gen(function*() {
        // The bytes 01 02 03 04, streamed as two chunks that are not a
        // multiple of 3 bytes, so each chunk's base64 carries its own padding.
        const http = makeHttpClient((request) =>
          Effect.succeed(eventStreamResponse(request, [
            eventFrame("messageStart", { role: "assistant" }),
            eventFrame("contentBlockDelta", {
              contentBlockIndex: 0,
              delta: { reasoningContent: { redactedContent: "AQI=" } }
            }),
            eventFrame("contentBlockDelta", {
              contentBlockIndex: 0,
              delta: { reasoningContent: { redactedContent: "AwQ=" } }
            }),
            eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
            eventFrame("messageStop", { stopReason: "end_turn" }),
            eventFrame("metadata", {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              metrics: { latencyMs: 1 }
            })
          ]))
        )

        const parts = yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        const reasoningMetadata = parts.flatMap((part) =>
          part.type === "reasoning-start" || part.type === "reasoning-delta" || part.type === "reasoning-end"
            ? [part.metadata["amazon-bedrock"]]
            : []
        )
        assert.deepInclude(reasoningMetadata, { redactedContent: "AQIDBA==" })
      }))

    it.effect("ignores stream events it does not model", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(eventStreamResponse(request, [
            eventFrame("messageStart", { role: "assistant" }),
            eventFrame("someFutureEvent", { detail: 1 }),
            eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } }),
            eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
            eventFrame("messageStop", { stopReason: "end_turn" }),
            eventFrame("metadata", {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              metrics: { latencyMs: 1 }
            })
          ]))
        )

        const parts = yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        const text = parts.flatMap((part) => part.type === "text-delta" ? [part.delta] : []).join("")
        assert.strictEqual(text, "Hi")
        const finish = parts.find((part) => part.type === "finish")
        assertDefined(finish)
        if (finish.type !== "finish") return
        assert.strictEqual(finish.reason, "stop")
      }))

    it.effect("streams reasoning deltas with their signature", () =>
      Effect.gen(function*() {
        const http = makeHttpClient((request) =>
          Effect.succeed(eventStreamResponse(request, [
            eventFrame("messageStart", { role: "assistant" }),
            eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Think" } } }),
            eventFrame("contentBlockDelta", {
              contentBlockIndex: 0,
              delta: { reasoningContent: { signature: "sig" } }
            }),
            eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
            eventFrame("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Hi" } }),
            eventFrame("contentBlockStop", { contentBlockIndex: 1 }),
            eventFrame("messageStop", { stopReason: "end_turn" }),
            eventFrame("metadata", {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              metrics: { latencyMs: 1 }
            })
          ]))
        )

        const parts = yield* LanguageModel.streamText({ prompt: "Hello" }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(AmazonBedrockLanguageModel.model(model)),
          Effect.provide(http.layer)
        )

        const reasoning = parts.flatMap((part) => part.type === "reasoning-delta" ? [part.delta] : []).join("")
        assert.strictEqual(reasoning, "Think")
        const reasoningMetadata = parts.flatMap((part) =>
          part.type === "reasoning-start" || part.type === "reasoning-delta" || part.type === "reasoning-end"
            ? [part.metadata["amazon-bedrock"]]
            : []
        )
        assert.deepInclude(reasoningMetadata, { signature: "sig" })
        const text = parts.flatMap((part) => part.type === "text-delta" ? [part.delta] : []).join("")
        assert.strictEqual(text, "Hi")
      }))
  })
})

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.makeWith(
    Effect.fnUntraced(function*(requestEffect) {
      const request = yield* requestEffect
      requests.push(request)
      return yield* handler(request)
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
  )
  const layer = AmazonBedrockClient.layer({
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: Redacted.make("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
  }).pipe(
    Layer.provide([
      Layer.succeed(HttpClient.HttpClient, client),
      Digest.layerWebCrypto,
      Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
    ])
  )
  return { requests, layer }
}

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  )

const eventStreamResponse = (
  request: HttpClientRequest.HttpClientRequest,
  frames: ReadonlyArray<Uint8Array>
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(concat(frames), {
      status: 200,
      headers: { "content-type": "application/vnd.amazon.eventstream" }
    })
  )

const getRequestBody = Effect.fnUntraced(function*(request: HttpClientRequest.HttpClientRequest) {
  const body = request.body
  if (body._tag !== "Uint8Array") {
    return yield* Effect.die(new Error("Expected Uint8Array body"))
  }
  return JSON.parse(new TextDecoder().decode(body.body))
})
