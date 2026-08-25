import { describe, it } from "@effect/vitest"
import { assertDefined, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Effect, Fiber, Latch, Option, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AiError, LanguageModel, Prompt, Response, ResponseIdTracker, Tool, Toolkit } from "effect/unstable/ai"
import * as TestUtils from "./utils.ts"

const MyTool = Tool.make("MyTool", {
  parameters: Schema.Struct({ testParam: Schema.String }),
  success: Schema.Struct({ testSuccess: Schema.String })
})

const MyToolkit = Toolkit.make(MyTool)

const MyToolkitLayer = MyToolkit.toLayer({
  MyTool: () =>
    Effect.succeed({ testSuccess: "test-success" }).pipe(
      Effect.delay("10 seconds")
    )
})

const ApprovalTool = Tool.make("ApprovalTool", {
  parameters: Schema.Struct({ action: Schema.String }),
  success: Schema.Struct({ result: Schema.String }),
  needsApproval: true
})

const DynamicApprovalTool = Tool.make("DynamicApprovalTool", {
  parameters: Schema.Struct({ dangerous: Schema.Boolean }),
  success: Schema.Struct({ result: Schema.String }),
  needsApproval: (params) => params.dangerous
})

const ApprovalToolkit = Toolkit.make(ApprovalTool, DynamicApprovalTool)

const ApprovalToolkitLayer = ApprovalToolkit.toLayer({
  ApprovalTool: () => Effect.succeed({ result: "approved-result" }),
  DynamicApprovalTool: () => Effect.succeed({ result: "dynamic-result" })
})

describe("LanguageModel", () => {
  const finishPart: Response.FinishPartEncoded = {
    type: "finish",
    reason: "stop",
    usage: {
      inputTokens: { uncached: 5, total: 5, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined }
    },
    response: undefined
  }

  describe("streamText", () => {
    it.effect("should emit tool calls before executing tool handlers", () =>
      Effect.gen(function*() {
        const parts: Array<Response.StreamPart<Toolkit.Tools<typeof MyToolkit>>> = []
        const latch = yield* Latch.make()

        const toolCallId = "tool-abc123"
        const toolName = "MyTool"
        const toolParams = { testParam: "test-param" }
        const toolResult = { testSuccess: "test-success" }

        const fiber = yield* LanguageModel.streamText({
          prompt: [],
          toolkit: MyToolkit
        }).pipe(
          Stream.runForEach((part) =>
            Effect.andThen(
              latch.open,
              Effect.sync(() => {
                parts.push(part)
              })
            )
          ),
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: toolCallId,
                name: toolName,
                params: toolParams
              }
            ]
          }),
          Effect.provide(MyToolkitLayer),
          Effect.forkScoped
        )

        yield* latch.await

        const toolCallPart = Response.makePart("tool-call", {
          id: toolCallId,
          name: toolName,
          params: toolParams,
          providerExecuted: false
        })

        const toolResultPart = Response.toolResultPart({
          id: toolCallId,
          name: toolName,
          result: toolResult,
          encodedResult: toolResult,
          isFailure: false,
          providerExecuted: false,
          preliminary: false
        })

        deepStrictEqual(parts, [toolCallPart])

        // `TestClock.adjust` wakes the sleeping tool handler but returns before
        // its result has propagated all the way downstream, so join the stream
        // fiber to observe the completed sequence of parts.
        yield* TestClock.adjust("10 seconds")
        yield* Fiber.join(fiber)

        deepStrictEqual(parts, [toolCallPart, toolResultPart])
      }))

    it.effect("emits finish after resolved tool results", () =>
      Effect.gen(function*() {
        const parts: Array<Response.StreamPart<Toolkit.Tools<typeof MyToolkit>>> = []
        const latch = yield* Latch.make()

        const fiber = yield* LanguageModel.streamText({
          prompt: [],
          toolkit: MyToolkit
        }).pipe(
          Stream.runForEach((part) =>
            Effect.andThen(
              latch.open,
              Effect.sync(() => {
                parts.push(part)
              })
            )
          ),
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: "tool-finish-order",
                name: "MyTool",
                params: { testParam: "test-param" }
              },
              finishPart
            ]
          }),
          Effect.provide(MyToolkitLayer),
          Effect.forkScoped
        )

        yield* latch.await

        strictEqual(parts[0]?.type, "tool-call")
        strictEqual(parts.some((part) => part.type === "finish"), false)

        yield* TestClock.adjust("10 seconds")
        yield* Fiber.join(fiber)

        strictEqual(parts.length, 3)
        strictEqual(parts[0]?.type, "tool-call")
        strictEqual(parts[1]?.type, "tool-result")
        strictEqual(parts[2]?.type, "finish")
      }))

    it.effect("runs tool handlers sequentially with concurrency: 1", () =>
      Effect.gen(function*() {
        const active = yield* Ref.make(0)
        const maxActive = yield* Ref.make(0)
        const started = yield* Latch.make()
        const release = yield* Latch.make()

        const handlers = MyToolkit.toLayer({
          MyTool: () =>
            Effect.gen(function*() {
              const current = yield* Ref.updateAndGet(active, (n) => n + 1)
              yield* Ref.update(maxActive, (n) => Math.max(n, current))
              yield* started.open
              yield* release.await
              return { testSuccess: "test-success" }
            }).pipe(Effect.ensuring(Ref.update(active, (n) => n - 1)))
        })

        const fiber = yield* LanguageModel.streamText({
          prompt: [],
          toolkit: MyToolkit,
          concurrency: 1
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: "tool-1",
                name: "MyTool",
                params: { testParam: "test-1" }
              },
              {
                type: "tool-call",
                id: "tool-2",
                name: "MyTool",
                params: { testParam: "test-2" }
              },
              {
                type: "tool-call",
                id: "tool-3",
                name: "MyTool",
                params: { testParam: "test-3" }
              }
            ]
          }),
          Effect.provide(handlers),
          Effect.forkScoped
        )

        yield* started.await
        strictEqual(yield* Ref.get(active), 1)
        strictEqual(yield* Ref.get(maxActive), 1)

        yield* release.open
        yield* Fiber.join(fiber)

        strictEqual(yield* Ref.get(active), 0)
        strictEqual(yield* Ref.get(maxActive), 1)
      }))

    it.effect("allows tool handler overlap up to a bounded concurrency", () =>
      Effect.gen(function*() {
        const active = yield* Ref.make(0)
        const maxActive = yield* Ref.make(0)
        const twoStarted = yield* Latch.make()
        const release = yield* Latch.make()

        const handlers = MyToolkit.toLayer({
          MyTool: () =>
            Effect.gen(function*() {
              const current = yield* Ref.updateAndGet(active, (n) => n + 1)
              yield* Ref.update(maxActive, (n) => Math.max(n, current))
              if (current === 2) {
                yield* twoStarted.open
              }
              yield* release.await
              return { testSuccess: "test-success" }
            }).pipe(Effect.ensuring(Ref.update(active, (n) => n - 1)))
        })

        const fiber = yield* LanguageModel.streamText({
          prompt: [],
          toolkit: MyToolkit,
          concurrency: 2
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: "tool-1",
                name: "MyTool",
                params: { testParam: "test-1" }
              },
              {
                type: "tool-call",
                id: "tool-2",
                name: "MyTool",
                params: { testParam: "test-2" }
              },
              {
                type: "tool-call",
                id: "tool-3",
                name: "MyTool",
                params: { testParam: "test-3" }
              }
            ]
          }),
          Effect.provide(handlers),
          Effect.forkScoped
        )

        yield* twoStarted.await
        strictEqual(yield* Ref.get(active), 2)
        strictEqual(yield* Ref.get(maxActive), 2)

        yield* release.open
        yield* Fiber.join(fiber)

        strictEqual(yield* Ref.get(active), 0)
        strictEqual(yield* Ref.get(maxActive), 2)
      }))

    it.effect("provides tool call IDs to concurrent identical tool handlers", () =>
      Effect.gen(function*() {
        const toolCallIds = yield* Ref.make<Array<string>>([])
        const twoStarted = yield* Latch.make()
        const release = yield* Latch.make()

        const handlers = MyToolkit.toLayer({
          MyTool: (_, context) =>
            Effect.gen(function*() {
              const toolCallId = context.toolCallId
              assertDefined(toolCallId)
              const ids = yield* Ref.updateAndGet(toolCallIds, (ids) => [...ids, toolCallId])
              if (ids.length === 2) {
                yield* twoStarted.open
              }
              yield* release.await
              return { testSuccess: "test-success" }
            })
        })

        const fiber = yield* LanguageModel.streamText({
          prompt: [],
          toolkit: MyToolkit
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: "tool-1",
                name: "MyTool",
                params: { testParam: "identical" }
              },
              {
                type: "tool-call",
                id: "tool-2",
                name: "MyTool",
                params: { testParam: "identical" }
              }
            ]
          }),
          Effect.provide(handlers),
          Effect.forkScoped
        )

        yield* twoStarted.await
        deepStrictEqual((yield* Ref.get(toolCallIds)).sort(), ["tool-1", "tool-2"])

        yield* release.open
        yield* Fiber.join(fiber)
      }))

    it.effect("bounds needsApproval evaluation with the tool handler concurrency", () =>
      Effect.gen(function*() {
        const active = yield* Ref.make(0)
        const maxActive = yield* Ref.make(0)
        const started = yield* Latch.make()
        const release = yield* Latch.make()

        const tool = Tool.make("ApprovalConcurrencyTool", {
          parameters: Schema.Struct({ input: Schema.String }),
          success: Schema.Struct({ output: Schema.String }),
          needsApproval: () =>
            Effect.gen(function*() {
              const current = yield* Ref.updateAndGet(active, (n) => n + 1)
              yield* Ref.update(maxActive, (n) => Math.max(n, current))
              yield* started.open
              yield* release.await
              return false
            }).pipe(Effect.ensuring(Ref.update(active, (n) => n - 1)))
        })
        const toolkit = Toolkit.make(tool)
        const handlers = toolkit.toLayer({
          ApprovalConcurrencyTool: () => Effect.succeed({ output: "done" })
        })

        const fiber = yield* LanguageModel.streamText({
          prompt: [],
          toolkit,
          concurrency: 1
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: "tool-1",
                name: "ApprovalConcurrencyTool",
                params: { input: "test-1" }
              },
              {
                type: "tool-call",
                id: "tool-2",
                name: "ApprovalConcurrencyTool",
                params: { input: "test-2" }
              }
            ]
          }),
          Effect.provide(handlers),
          Effect.forkScoped
        )

        yield* started.await
        strictEqual(yield* Ref.get(active), 1)
        strictEqual(yield* Ref.get(maxActive), 1)

        yield* release.open
        yield* Fiber.join(fiber)

        strictEqual(yield* Ref.get(active), 0)
        strictEqual(yield* Ref.get(maxActive), 1)
      }))
  })

  describe("generateObject", () => {
    it.effect("includes full generated text in StructuredOutputError", () =>
      Effect.gen(function*() {
        const error = yield* LanguageModel.generateObject({
          prompt: [],
          schema: Schema.Struct({ count: Schema.Number })
        }).pipe(
          TestUtils.withLanguageModel({
            generateText: [{
              type: "text",
              text: "{\"count\":\"oops\"}"
            }]
          }),
          Effect.flip
        )

        strictEqual(error.reason._tag, "StructuredOutputError")
        if (error.reason._tag === "StructuredOutputError") {
          strictEqual(error.reason.responseText, "{\"count\":\"oops\"}")
        }
      }))

    it("resolves the canonical top-level $ref for class schemas in defaultCodecTransformer", () => {
      class Person extends Schema.Class<Person>("Person")({
        name: Schema.String
      }) {}

      const transformed = LanguageModel.defaultCodecTransformer(Person)

      deepStrictEqual(transformed.jsonSchema, {
        type: "object",
        properties: {
          name: {
            type: "string"
          }
        },
        required: ["name"],
        additionalProperties: false,
        $defs: {
          "PersonJsonEncoding": {
            type: "object",
            properties: {
              name: {
                type: "string"
              }
            },
            required: ["name"],
            additionalProperties: false
          }
        }
      })
    })
  })

  describe("provider options", () => {
    it.effect("initialize incremental fields as undefined in generateText", () =>
      Effect.gen(function*() {
        let capturedOptions: LanguageModel.ProviderOptions | undefined

        yield* LanguageModel.generateText({
          prompt: []
        }).pipe(
          TestUtils.withLanguageModel({
            generateText: (options) => {
              capturedOptions = options
              return Effect.succeed([finishPart])
            }
          })
        )

        assertDefined(capturedOptions)
        strictEqual(capturedOptions.previousResponseId, undefined)
        strictEqual(capturedOptions.incrementalPrompt, undefined)
      }))

    it.effect("initialize incremental fields as undefined in generateObject", () =>
      Effect.gen(function*() {
        let capturedOptions: LanguageModel.ProviderOptions | undefined

        yield* LanguageModel.generateObject({
          prompt: [],
          schema: Schema.Struct({ count: Schema.Number })
        }).pipe(
          TestUtils.withLanguageModel({
            generateText: (options) => {
              capturedOptions = options
              return Effect.succeed([
                {
                  type: "text",
                  text: "{\"count\":1}"
                },
                finishPart
              ])
            }
          })
        )

        assertDefined(capturedOptions)
        strictEqual(capturedOptions.previousResponseId, undefined)
        strictEqual(capturedOptions.incrementalPrompt, undefined)
      }))

    it.effect("initialize incremental fields as undefined in streamText", () =>
      Effect.gen(function*() {
        let capturedOptions: LanguageModel.ProviderOptions | undefined

        yield* LanguageModel.streamText({
          prompt: []
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: (options) => {
              capturedOptions = options
              return [finishPart]
            }
          })
        )

        assertDefined(capturedOptions)
        strictEqual(capturedOptions.previousResponseId, undefined)
        strictEqual(capturedOptions.incrementalPrompt, undefined)
      }))

    it.effect("falls back to full prompt in generateText when incremental request fails", () =>
      Effect.gen(function*() {
        const fullPrompt = Prompt.make([
          Prompt.systemMessage({ content: "system" }),
          Prompt.userMessage({ content: [Prompt.textPart({ text: "user" })] }),
          Prompt.assistantMessage({ content: [Prompt.textPart({ text: "assistant" })] }),
          Prompt.userMessage({ content: [Prompt.textPart({ text: "next" })] })
        ])

        const incrementalPrompt = Prompt.make([
          Prompt.userMessage({ content: [Prompt.textPart({ text: "next" })] })
        ])

        const calls: Array<LanguageModel.ProviderOptions> = []

        yield* LanguageModel.generateText({
          prompt: fullPrompt
        }).pipe(
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: (options) => {
                calls.push(options)
                if (calls.length === 1) {
                  ;(options as any).prompt = options.incrementalPrompt ?? options.prompt
                  return Effect.fail(AiError.make({
                    module: "LanguageModelTest",
                    method: "generateText",
                    reason: new AiError.InvalidRequestError({
                      description: "invalid previous response id"
                    })
                  }))
                }
                return Effect.succeed([finishPart])
              },
              streamText: () => Stream.empty
            })
          ),
          Effect.provideService(ResponseIdTracker.ResponseIdTracker, {
            clearUnsafe() {},
            markParts() {},
            prepareUnsafe: () =>
              Option.some({
                previousResponseId: "resp_prev",
                prompt: incrementalPrompt
              })
          })
        )

        strictEqual(calls.length, 2)
        strictEqual(calls[0]!.previousResponseId, "resp_prev")
        strictEqual(calls[0]!.incrementalPrompt, incrementalPrompt)
        strictEqual(calls[1]!.previousResponseId, undefined)
        strictEqual(calls[1]!.incrementalPrompt, undefined)
        deepStrictEqual(calls[1]!.prompt, fullPrompt)
      }))

    it.effect("falls back to full prompt in streamText when incremental request fails", () =>
      Effect.gen(function*() {
        const fullPrompt = Prompt.make([
          Prompt.systemMessage({ content: "system" }),
          Prompt.userMessage({ content: [Prompt.textPart({ text: "user" })] }),
          Prompt.assistantMessage({ content: [Prompt.textPart({ text: "assistant" })] }),
          Prompt.userMessage({ content: [Prompt.textPart({ text: "next" })] })
        ])

        const incrementalPrompt = Prompt.make([
          Prompt.userMessage({ content: [Prompt.textPart({ text: "next" })] })
        ])

        const calls: Array<LanguageModel.ProviderOptions> = []

        yield* LanguageModel.streamText({
          prompt: fullPrompt
        }).pipe(
          Stream.runDrain,
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () => Effect.succeed([finishPart]),
              streamText: (options) => {
                calls.push(options)
                if (calls.length === 1) {
                  ;(options as any).prompt = options.incrementalPrompt ?? options.prompt
                  return Stream.fail(AiError.make({
                    module: "LanguageModelTest",
                    method: "streamText",
                    reason: new AiError.InvalidRequestError({
                      description: "invalid previous response id"
                    })
                  }))
                }
                return Stream.fromIterable([finishPart])
              }
            })
          ),
          Effect.provideService(ResponseIdTracker.ResponseIdTracker, {
            clearUnsafe() {},
            markParts() {},
            prepareUnsafe: () =>
              Option.some({
                previousResponseId: "resp_prev",
                prompt: incrementalPrompt
              })
          })
        )

        strictEqual(calls.length, 2)
        strictEqual(calls[0]!.previousResponseId, "resp_prev")
        strictEqual(calls[0]!.incrementalPrompt, incrementalPrompt)
        strictEqual(calls[1]!.previousResponseId, undefined)
        strictEqual(calls[1]!.incrementalPrompt, undefined)
        deepStrictEqual(calls[1]!.prompt, fullPrompt)
      }))

    it.effect("uses tracker prepareUnsafe and markParts in generateText without toolkit", () =>
      Effect.gen(function*() {
        let capturedOptions: LanguageModel.ProviderOptions | undefined
        let preparedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined
        let markedParts: ReadonlyArray<object> | undefined
        let markedResponseId: string | undefined

        const incrementalPrompt = Prompt.make([
          Prompt.userMessage({ content: [Prompt.textPart({ text: "incremental" })] })
        ])

        yield* LanguageModel.generateText({
          prompt: [Prompt.userMessage({ content: [Prompt.textPart({ text: "hello" })] })]
        }).pipe(
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: (options) => {
                capturedOptions = options
                return Effect.succeed([
                  {
                    type: "response-metadata",
                    id: "resp_next",
                    modelId: undefined,
                    timestamp: undefined,
                    request: undefined
                  },
                  finishPart
                ])
              },
              streamText: () => Stream.empty
            })
          ),
          Effect.provideService(ResponseIdTracker.ResponseIdTracker, {
            clearUnsafe() {},
            markParts: (parts, responseId) => {
              markedParts = parts
              markedResponseId = responseId
            },
            prepareUnsafe: (prompt) => {
              preparedPrompt = prompt
              return Option.some({
                previousResponseId: "resp_prev",
                prompt: incrementalPrompt
              })
            }
          })
        )

        assertDefined(capturedOptions)
        assertDefined(preparedPrompt)
        strictEqual(preparedPrompt, capturedOptions.prompt)
        strictEqual(capturedOptions.previousResponseId, "resp_prev")
        strictEqual(capturedOptions.incrementalPrompt, incrementalPrompt)
        assertDefined(markedParts)
        strictEqual(markedParts, capturedOptions.prompt.content)
        strictEqual(markedResponseId, "resp_next")
      }))

    it.effect("uses tracker prepareUnsafe and markParts in generateText with empty toolkit", () =>
      Effect.gen(function*() {
        let capturedOptions: LanguageModel.ProviderOptions | undefined
        let prepareCalls = 0
        let markCalls = 0

        yield* LanguageModel.generateText({
          prompt: [Prompt.userMessage({ content: [Prompt.textPart({ text: "hello" })] })],
          toolkit: Toolkit.empty
        }).pipe(
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: (options) => {
                capturedOptions = options
                return Effect.succeed([
                  {
                    type: "response-metadata",
                    id: "resp_next",
                    modelId: undefined,
                    timestamp: undefined,
                    request: undefined
                  },
                  finishPart
                ])
              },
              streamText: () => Stream.empty
            })
          ),
          Effect.provideService(ResponseIdTracker.ResponseIdTracker, {
            clearUnsafe() {},
            markParts: () => {
              markCalls++
            },
            prepareUnsafe: () => {
              prepareCalls++
              return Option.some({
                previousResponseId: "resp_prev",
                prompt: Prompt.make([])
              })
            }
          })
        )

        assertDefined(capturedOptions)
        strictEqual(capturedOptions.previousResponseId, "resp_prev")
        strictEqual(prepareCalls, 1)
        strictEqual(markCalls, 1)
      }))

    it.effect("calls tracker.prepareUnsafe after stripping resolved approvals in toolkit flow", () =>
      Effect.gen(function*() {
        const toolCallId = "call-tracker"
        const approvalId = "approval-tracker"

        let preparedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined
        let markedParts: ReadonlyArray<object> | undefined

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: true
              }),
              Prompt.toolResultPart({
                id: toolCallId,
                name: "ApprovalTool",
                result: { result: "approved-result" },
                isFailure: false
              })
            ]
          }),
          Prompt.userMessage({ content: [Prompt.textPart({ text: "continue" })] })
        ]

        yield* LanguageModel.generateText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () =>
                Effect.succeed([
                  {
                    type: "response-metadata",
                    id: "resp_next",
                    modelId: undefined,
                    timestamp: undefined,
                    request: undefined
                  },
                  finishPart
                ]),
              streamText: () => Stream.empty
            })
          ),
          Effect.provideService(ResponseIdTracker.ResponseIdTracker, {
            clearUnsafe() {},
            markParts(parts) {
              markedParts = parts
            },
            prepareUnsafe(prompt) {
              preparedPrompt = prompt
              return Option.none()
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        assertDefined(preparedPrompt)
        for (const msg of preparedPrompt.content) {
          if (msg.role === "assistant") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-request").length, 0)
          }
          if (msg.role === "tool") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-response").length, 0)
          }
        }
        assertDefined(markedParts)
        strictEqual(markedParts, preparedPrompt.content)
      }))

    it.effect("uses tracker prepareUnsafe and markParts in streamText without toolkit", () =>
      Effect.gen(function*() {
        let capturedOptions: LanguageModel.ProviderOptions | undefined
        let preparedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined
        let markedParts: ReadonlyArray<object> | undefined
        let markedResponseId: string | undefined

        const incrementalPrompt = Prompt.make([
          Prompt.userMessage({ content: [Prompt.textPart({ text: "incremental" })] })
        ])

        yield* LanguageModel.streamText({
          prompt: [Prompt.userMessage({ content: [Prompt.textPart({ text: "hello" })] })]
        }).pipe(
          Stream.runDrain,
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () => Effect.succeed([]),
              streamText: (options) => {
                capturedOptions = options
                return Stream.fromIterable([
                  {
                    type: "response-metadata",
                    id: "resp_next",
                    modelId: undefined,
                    timestamp: undefined,
                    request: undefined
                  },
                  finishPart
                ])
              }
            })
          ),
          Effect.provideService(ResponseIdTracker.ResponseIdTracker, {
            clearUnsafe() {},
            markParts: (parts, responseId) => {
              markedParts = parts
              markedResponseId = responseId
            },
            prepareUnsafe: (prompt) => {
              preparedPrompt = prompt
              return Option.some({
                previousResponseId: "resp_prev",
                prompt: incrementalPrompt
              })
            }
          })
        )

        assertDefined(capturedOptions)
        assertDefined(preparedPrompt)
        strictEqual(preparedPrompt, capturedOptions.prompt)
        strictEqual(capturedOptions.previousResponseId, "resp_prev")
        strictEqual(capturedOptions.incrementalPrompt, incrementalPrompt)
        assertDefined(markedParts)
        strictEqual(markedParts, capturedOptions.prompt.content)
        strictEqual(markedResponseId, "resp_next")
      }))

    it.effect("uses tracker prepareUnsafe and markParts in streamText with empty toolkit", () =>
      Effect.gen(function*() {
        let capturedOptions: LanguageModel.ProviderOptions | undefined
        let preparedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined
        let markedParts: ReadonlyArray<object> | undefined
        let markedResponseId: string | undefined

        const incrementalPrompt = Prompt.make([
          Prompt.userMessage({ content: [Prompt.textPart({ text: "incremental" })] })
        ])

        yield* LanguageModel.streamText({
          prompt: [Prompt.userMessage({ content: [Prompt.textPart({ text: "hello" })] })],
          toolkit: Toolkit.empty
        }).pipe(
          Stream.runDrain,
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () => Effect.succeed([]),
              streamText: (options) => {
                capturedOptions = options
                return Stream.fromIterable([
                  {
                    type: "response-metadata",
                    id: "resp_next",
                    modelId: undefined,
                    timestamp: undefined,
                    request: undefined
                  },
                  finishPart
                ])
              }
            })
          ),
          Effect.provideService(ResponseIdTracker.ResponseIdTracker, {
            clearUnsafe() {},
            markParts: (parts, responseId) => {
              markedParts = parts
              markedResponseId = responseId
            },
            prepareUnsafe: (prompt) => {
              preparedPrompt = prompt
              return Option.some({
                previousResponseId: "resp_prev",
                prompt: incrementalPrompt
              })
            }
          })
        )

        assertDefined(capturedOptions)
        assertDefined(preparedPrompt)
        strictEqual(preparedPrompt, capturedOptions.prompt)
        strictEqual(capturedOptions.previousResponseId, "resp_prev")
        strictEqual(capturedOptions.incrementalPrompt, incrementalPrompt)
        assertDefined(markedParts)
        strictEqual(markedParts, capturedOptions.prompt.content)
        strictEqual(markedResponseId, "resp_next")
      }))

    it.effect("calls tracker.prepareUnsafe after stripping resolved approvals in streamText toolkit flow", () =>
      Effect.gen(function*() {
        const toolCallId = "call-tracker-stream"
        const approvalId = "approval-tracker-stream"

        let preparedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined
        let markedParts: ReadonlyArray<object> | undefined

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: true
              }),
              Prompt.toolResultPart({
                id: toolCallId,
                name: "ApprovalTool",
                result: { result: "approved-result" },
                isFailure: false
              })
            ]
          }),
          Prompt.userMessage({ content: [Prompt.textPart({ text: "continue" })] })
        ]

        yield* LanguageModel.streamText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runDrain,
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () => Effect.succeed([]),
              streamText: () =>
                Stream.fromIterable([
                  {
                    type: "response-metadata",
                    id: "resp_next",
                    modelId: undefined,
                    timestamp: undefined,
                    request: undefined
                  },
                  finishPart
                ])
            })
          ),
          Effect.provideService(ResponseIdTracker.ResponseIdTracker, {
            clearUnsafe() {},
            markParts: (parts) => {
              markedParts = parts
            },
            prepareUnsafe: (prompt) => {
              preparedPrompt = prompt
              return Option.none()
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        assertDefined(preparedPrompt)
        for (const msg of preparedPrompt.content) {
          if (msg.role === "assistant") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-request").length, 0)
          }
          if (msg.role === "tool") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-response").length, 0)
          }
        }
        assertDefined(markedParts)
        strictEqual(markedParts, preparedPrompt.content)
      }))

    it.effect("uses tracker prepareUnsafe and markParts when disableToolCallResolution is true", () =>
      Effect.gen(function*() {
        const toolCallId = "call-tracker-stream-disable"
        const approvalId = "approval-tracker-stream-disable"

        let capturedOptions: LanguageModel.ProviderOptions | undefined
        let preparedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined
        let markedParts: ReadonlyArray<object> | undefined
        let markedResponseId: string | undefined

        const incrementalPrompt = Prompt.make([
          Prompt.userMessage({ content: [Prompt.textPart({ text: "incremental" })] })
        ])

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: true
              }),
              Prompt.toolResultPart({
                id: toolCallId,
                name: "ApprovalTool",
                result: { result: "approved-result" },
                isFailure: false
              })
            ]
          }),
          Prompt.userMessage({ content: [Prompt.textPart({ text: "continue" })] })
        ]

        yield* LanguageModel.streamText({
          prompt,
          toolkit: ApprovalToolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runDrain,
          Effect.provideServiceEffect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () => Effect.succeed([]),
              streamText: (options) => {
                capturedOptions = options
                return Stream.fromIterable([
                  {
                    type: "response-metadata",
                    id: "resp_next",
                    modelId: undefined,
                    timestamp: undefined,
                    request: undefined
                  },
                  finishPart
                ])
              }
            })
          ),
          Effect.provideService(ResponseIdTracker.ResponseIdTracker, {
            markParts: (parts, responseId) => {
              markedParts = parts
              markedResponseId = responseId
            },
            prepareUnsafe: (prompt) => {
              preparedPrompt = prompt
              return Option.some({
                previousResponseId: "resp_prev",
                prompt: incrementalPrompt
              })
            },
            clearUnsafe() {}
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        assertDefined(capturedOptions)
        assertDefined(preparedPrompt)
        strictEqual(preparedPrompt, capturedOptions.prompt)
        strictEqual(capturedOptions.previousResponseId, "resp_prev")
        strictEqual(capturedOptions.incrementalPrompt, incrementalPrompt)
        for (const msg of preparedPrompt.content) {
          if (msg.role === "assistant") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-request").length, 0)
          }
          if (msg.role === "tool") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-response").length, 0)
          }
        }
        assertDefined(markedParts)
        strictEqual(markedParts, capturedOptions.prompt.content)
        strictEqual(markedResponseId, "resp_next")
      }))
  })

  describe("tool approval", () => {
    it.effect("emits tool-approval-request when tool has needsApproval: true", () =>
      Effect.gen(function*() {
        const parts: Array<Response.StreamPart<Toolkit.Tools<typeof ApprovalToolkit>>> = []

        const toolCallId = "call-123"
        const toolName = "ApprovalTool"
        const toolParams = { action: "delete" }

        yield* LanguageModel.streamText({
          prompt: [],
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runForEach((part) =>
            Effect.sync(() => {
              parts.push(part)
            })
          ),
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: toolCallId,
                name: toolName,
                params: toolParams
              }
            ]
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        strictEqual(parts.length, 2)
        deepStrictEqual(
          parts[0],
          Response.makePart("tool-call", {
            id: toolCallId,
            name: toolName,
            params: toolParams,
            providerExecuted: false
          })
        )

        const approvalPart = parts[1]
        strictEqual(approvalPart.type, "tool-approval-request")
        if (approvalPart.type === "tool-approval-request") {
          strictEqual(approvalPart.toolCallId, toolCallId)
          assertDefined(approvalPart.approvalId)
        }
      }))

    it.effect("pre-resolves approved tool calls before calling LLM", () =>
      Effect.gen(function*() {
        const toolCallId = "call-456"
        const approvalId = "approval-456"
        let capturedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: true
              })
            ]
          })
        ]

        yield* LanguageModel.streamText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: (opts) => {
              capturedPrompt = opts.prompt
              return [finishPart]
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        // Verify the prompt sent to LLM contains pre-resolved tool result
        assertDefined(capturedPrompt)
        const messages = capturedPrompt.content
        const lastMessage = messages[messages.length - 1]
        strictEqual(lastMessage.role, "tool")
        assertTrue(Array.isArray(lastMessage.content))
        const toolResults = (lastMessage.content as Array<Prompt.ToolMessagePart>).filter(
          (p): p is Prompt.ToolResultPart => p.type === "tool-result"
        )
        strictEqual(toolResults.length, 1)
        strictEqual(toolResults[0].id, toolCallId)
        deepStrictEqual(toolResults[0].result, { result: "approved-result" })
        strictEqual(toolResults[0].isFailure, false)
      }))

    it.effect("pre-resolves denied tool calls with execution-denied before calling LLM", () =>
      Effect.gen(function*() {
        const toolCallId = "call-789"
        const approvalId = "approval-789"
        let capturedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: false,
                reason: "User declined"
              })
            ]
          })
        ]

        yield* LanguageModel.streamText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: (opts) => {
              capturedPrompt = opts.prompt
              return [finishPart]
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        // Verify the prompt sent to LLM contains pre-resolved denial result
        assertDefined(capturedPrompt)
        const messages = capturedPrompt.content
        const lastMessage = messages[messages.length - 1]
        strictEqual(lastMessage.role, "tool")
        assertTrue(Array.isArray(lastMessage.content))
        const toolResults = (lastMessage.content as Array<Prompt.ToolMessagePart>).filter(
          (p): p is Prompt.ToolResultPart => p.type === "tool-result"
        )
        strictEqual(toolResults.length, 1)
        strictEqual(toolResults[0].id, toolCallId)
        const result = toolResults[0].result as { type: string; reason: string }
        strictEqual(result.type, "execution-denied")
        strictEqual(result.reason, "User declined")
        strictEqual(toolResults[0].isFailure, true)
      }))

    it.effect("strips approved approval artifacts from prompt sent to provider (streamText)", () =>
      Effect.gen(function*() {
        const toolCallId = "call-strip"
        const approvalId = "approval-strip"
        let capturedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: true
              })
            ]
          })
        ]

        yield* LanguageModel.streamText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: (opts) => {
              capturedPrompt = opts.prompt
              return [finishPart]
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        assertDefined(capturedPrompt)
        const messages = capturedPrompt.content

        // Assistant message should retain tool-call but not tool-approval-request
        const assistantMsg = messages.find((m) => m.role === "assistant")
        assertDefined(assistantMsg)
        if (assistantMsg.role === "assistant") {
          strictEqual(assistantMsg.content.filter((p) => p.type === "tool-approval-request").length, 0)
          strictEqual(assistantMsg.content.filter((p) => p.type === "tool-call").length, 1)
        }

        // No tool message should contain tool-approval-response parts
        for (const msg of messages) {
          if (msg.role === "tool") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-response").length, 0)
          }
        }
      }))

    it.effect("strips denied approval artifacts from prompt sent to provider", () =>
      Effect.gen(function*() {
        const toolCallId = "call-strip-deny"
        const approvalId = "approval-strip-deny"
        let capturedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: false,
                reason: "Denied"
              })
            ]
          })
        ]

        yield* LanguageModel.streamText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: (opts) => {
              capturedPrompt = opts.prompt
              return [finishPart]
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        assertDefined(capturedPrompt)
        const messages = capturedPrompt.content

        // Approval artifacts stripped
        for (const msg of messages) {
          if (msg.role === "assistant") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-request").length, 0)
          }
          if (msg.role === "tool") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-response").length, 0)
          }
        }

        // Denial result should still be present
        const lastMessage = messages[messages.length - 1]
        strictEqual(lastMessage.role, "tool")
        if (lastMessage.role === "tool") {
          const toolResults = lastMessage.content.filter(
            (p): p is Prompt.ToolResultPart => p.type === "tool-result"
          )
          strictEqual(toolResults.length, 1)
          strictEqual(toolResults[0].isFailure, true)
        }
      }))

    it.effect("strips only resolved approvals, preserves unrelated parts", () =>
      Effect.gen(function*() {
        const resolvedCallId = "call-resolved"
        const resolvedApprovalId = "approval-resolved"
        const unresolvedCallId = "call-unresolved"
        const unresolvedApprovalId = "approval-unresolved"
        let capturedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: resolvedCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId: resolvedApprovalId,
                toolCallId: resolvedCallId
              }),
              Prompt.makePart("tool-call", {
                id: unresolvedCallId,
                name: "ApprovalTool",
                params: { action: "read" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId: unresolvedApprovalId,
                toolCallId: unresolvedCallId
              })
            ]
          }),
          // Only resolve one of the two approvals
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId: resolvedApprovalId,
                approved: true
              })
            ]
          })
        ]

        yield* LanguageModel.streamText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: (opts) => {
              capturedPrompt = opts.prompt
              return [finishPart]
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        assertDefined(capturedPrompt)
        const messages = capturedPrompt.content

        // The assistant message should have the resolved approval-request stripped
        // but the unresolved one preserved
        const assistantMsg = messages.find((m) => m.role === "assistant")
        assertDefined(assistantMsg)
        if (assistantMsg.role === "assistant") {
          const approvalRequests = assistantMsg.content.filter(
            (p) => p.type === "tool-approval-request"
          )
          strictEqual(approvalRequests.length, 1)
          if (approvalRequests[0].type === "tool-approval-request") {
            strictEqual(approvalRequests[0].approvalId, unresolvedApprovalId)
          }
          // Both tool-calls should survive
          strictEqual(assistantMsg.content.filter((p) => p.type === "tool-call").length, 2)
        }
      }))

    it.effect("strips approval artifacts via generateText path", () =>
      Effect.gen(function*() {
        const toolCallId = "call-gen"
        const approvalId = "approval-gen"
        let capturedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: true
              })
            ]
          })
        ]

        yield* LanguageModel.generateText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          TestUtils.withLanguageModel({
            generateText: (opts) => {
              capturedPrompt = opts.prompt
              return Effect.succeed([finishPart])
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        assertDefined(capturedPrompt)
        const messages = capturedPrompt.content

        for (const msg of messages) {
          if (msg.role === "assistant") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-request").length, 0)
            strictEqual(msg.content.filter((p) => p.type === "tool-call").length, 1)
          }
          if (msg.role === "tool") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-response").length, 0)
          }
        }
      }))

    it.effect("dynamic needsApproval returns true when condition met", () =>
      Effect.gen(function*() {
        const parts: Array<Response.StreamPart<Toolkit.Tools<typeof ApprovalToolkit>>> = []

        const toolCallId = "call-dyn-1"

        yield* LanguageModel.streamText({
          prompt: [],
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runForEach((part) =>
            Effect.sync(() => {
              parts.push(part)
            })
          ),
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: toolCallId,
                name: "DynamicApprovalTool",
                params: { dangerous: true }
              }
            ]
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        strictEqual(parts.length, 2)
        strictEqual(parts[0].type, "tool-call")
        strictEqual(parts[1].type, "tool-approval-request")
        if (parts[1].type === "tool-approval-request") {
          strictEqual(parts[1].toolCallId, toolCallId)
        }
      }))

    it.effect("dynamic needsApproval returns false when condition not met", () =>
      Effect.gen(function*() {
        const parts: Array<Response.StreamPart<Toolkit.Tools<typeof ApprovalToolkit>>> = []

        const toolCallId = "call-dyn-2"

        yield* LanguageModel.streamText({
          prompt: [],
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runForEach((part) =>
            Effect.sync(() => {
              parts.push(part)
            })
          ),
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: toolCallId,
                name: "DynamicApprovalTool",
                params: { dangerous: false }
              }
            ]
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        strictEqual(parts.length, 2)
        strictEqual(parts[0].type, "tool-call")
        strictEqual(parts[1].type, "tool-result")
        if (parts[1].type === "tool-result") {
          deepStrictEqual(parts[1].result, { result: "dynamic-result" })
        }
      }))

    it.effect("tool without needsApproval executes normally", () =>
      Effect.gen(function*() {
        const parts: Array<Response.StreamPart<Toolkit.Tools<typeof MyToolkit>>> = []

        const toolCallId = "call-normal"
        const latch = yield* Latch.make()

        const fiber = yield* LanguageModel.streamText({
          prompt: [],
          toolkit: MyToolkit
        }).pipe(
          Stream.runForEach((part) =>
            Effect.andThen(
              latch.open,
              Effect.sync(() => {
                parts.push(part)
              })
            )
          ),
          TestUtils.withLanguageModel({
            streamText: [
              {
                type: "tool-call",
                id: toolCallId,
                name: "MyTool",
                params: { testParam: "test" }
              }
            ]
          }),
          Effect.provide(MyToolkitLayer),
          Effect.forkScoped
        )

        yield* latch.await
        yield* TestClock.adjust("10 seconds")
        yield* Fiber.join(fiber)

        strictEqual(parts.length, 2)
        strictEqual(parts[0].type, "tool-call")
        strictEqual(parts[1].type, "tool-result")
        if (parts[1].type === "tool-result") {
          deepStrictEqual(parts[1].result, { testSuccess: "test-success" })
        }
      }))

    it.effect("strips previous-round approval artifacts even when no new pending approvals (streamText)", () =>
      Effect.gen(function*() {
        const toolCallId = "call-prev"
        const approvalId = "approval-prev"
        let capturedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined

        // Simulate a prompt where a previous round's approval was already
        // resolved (tool-result exists), but the approval artifacts remain.
        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: true
              }),
              Prompt.toolResultPart({
                id: toolCallId,
                name: "ApprovalTool",
                result: { result: "approved-result" },
                isFailure: false
              })
            ]
          }),
          // A new user message triggers another round with no new approvals
          Prompt.userMessage({ content: [Prompt.textPart({ text: "continue" })] })
        ]

        yield* LanguageModel.streamText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runDrain,
          TestUtils.withLanguageModel({
            streamText: (opts) => {
              capturedPrompt = opts.prompt
              return [finishPart]
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        assertDefined(capturedPrompt)
        const messages = capturedPrompt.content

        // Previous-round approval artifacts should be stripped
        for (const msg of messages) {
          if (msg.role === "assistant") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-request").length, 0)
          }
          if (msg.role === "tool") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-response").length, 0)
          }
        }

        // The tool-result and tool-call should be preserved
        const assistantMsg = messages.find((m) => m.role === "assistant")
        assertDefined(assistantMsg)
        if (assistantMsg.role === "assistant") {
          strictEqual(assistantMsg.content.filter((p) => p.type === "tool-call").length, 1)
        }
        const toolMsg = messages.find((m) => m.role === "tool")
        assertDefined(toolMsg)
        if (toolMsg.role === "tool") {
          strictEqual(toolMsg.content.filter((p) => p.type === "tool-result").length, 1)
        }
      }))

    it.effect("strips previous-round approval artifacts even when no new pending approvals (generateText)", () =>
      Effect.gen(function*() {
        const toolCallId = "call-prev-gen"
        const approvalId = "approval-prev-gen"
        let capturedPrompt: LanguageModel.ProviderOptions["prompt"] | undefined

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: true
              }),
              Prompt.toolResultPart({
                id: toolCallId,
                name: "ApprovalTool",
                result: { result: "approved-result" },
                isFailure: false
              })
            ]
          }),
          Prompt.userMessage({ content: [Prompt.textPart({ text: "continue" })] })
        ]

        yield* LanguageModel.generateText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          TestUtils.withLanguageModel({
            generateText: (opts) => {
              capturedPrompt = opts.prompt
              return Effect.succeed([finishPart])
            }
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        assertDefined(capturedPrompt)
        const messages = capturedPrompt.content

        for (const msg of messages) {
          if (msg.role === "assistant") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-request").length, 0)
          }
          if (msg.role === "tool") {
            strictEqual(msg.content.filter((p) => p.type === "tool-approval-response").length, 0)
          }
        }
      }))

    it.effect("streamText emits pre-resolved tool results as stream parts", () =>
      Effect.gen(function*() {
        const toolCallId = "call-emit"
        const approvalId = "approval-emit"
        const parts: Array<Response.StreamPart<Toolkit.Tools<typeof ApprovalToolkit>>> = []

        const prompt: Array<Prompt.Message> = [
          Prompt.assistantMessage({
            content: [
              Prompt.makePart("tool-call", {
                id: toolCallId,
                name: "ApprovalTool",
                params: { action: "delete" },
                providerExecuted: false
              }),
              Prompt.makePart("tool-approval-request", {
                approvalId,
                toolCallId
              })
            ]
          }),
          Prompt.toolMessage({
            content: [
              Prompt.toolApprovalResponsePart({
                approvalId,
                approved: true
              })
            ]
          })
        ]

        yield* LanguageModel.streamText({
          prompt,
          toolkit: ApprovalToolkit
        }).pipe(
          Stream.runForEach((part) =>
            Effect.sync(() => {
              parts.push(part)
            })
          ),
          TestUtils.withLanguageModel({
            streamText: [finishPart]
          }),
          Effect.provide(ApprovalToolkitLayer)
        )

        // Should contain the pre-resolved tool-result as a stream part
        const toolResultParts = parts.filter((p) => p.type === "tool-result")
        strictEqual(toolResultParts.length, 1)
        if (toolResultParts[0].type === "tool-result") {
          strictEqual(toolResultParts[0].id, toolCallId)
          strictEqual(toolResultParts[0].name, "ApprovalTool")
          deepStrictEqual(toolResultParts[0].result, { result: "approved-result" })
          strictEqual(toolResultParts[0].isFailure, false)
        }
      }))
  })
})
