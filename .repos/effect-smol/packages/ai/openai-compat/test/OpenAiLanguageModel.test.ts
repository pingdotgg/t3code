import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

describe("OpenAiLanguageModel", () => {
  describe("generateText", () => {
    it.effect("sends model in request and decodes text output", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: "Hello, compat!"
                    }
                  }]
                })
              ))
            })
          ))
        )

        const result = yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(layer)
        )

        assert.strictEqual(result.text, "Hello, compat!")
        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)
        assert.strictEqual(requestBody.model, "gpt-4o-mini")
        assert.strictEqual(requestBody.messages[0]?.content, "hello")
      }))

    it.effect("forwards reasoning config to chat completions request", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: "Done"
                    }
                  }]
                })
              ))
            })
          ))
        )

        yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-5", {
            reasoning: {
              effort: "medium",
              summary: "auto"
            }
          })),
          Effect.provide(layer)
        )

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)
        assert.deepStrictEqual(requestBody.reasoning, {
          effort: "medium",
          summary: "auto"
        })
      }))

    it.effect("forwards custom model config properties to chat completions request", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: "Done"
                    }
                  }]
                })
              ))
            })
          ))
        )

        yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini", {
            vendor_setting: {
              mode: "strict"
            }
          })),
          Effect.provide(layer)
        )

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)
        assert.deepStrictEqual(requestBody.vendor_setting, {
          mode: "strict"
        })
      }))

    it.effect("preserves multimodal user content order in chat payload", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: "done"
                    }
                  }]
                })
              ))
            })
          ))
        )

        yield* LanguageModel.generateText({
          prompt: Prompt.make([{
            role: "user",
            content: [
              Prompt.textPart({ text: "first text" }),
              Prompt.filePart({
                mediaType: "image/png",
                data: new URL("https://example.com/image.png")
              }),
              Prompt.textPart({ text: "second text" })
            ]
          }])
        }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(layer)
        )

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)
        const content = requestBody.messages[0]?.content
        assert.isTrue(Array.isArray(content))
        assert.deepStrictEqual(content, [
          {
            type: "text",
            text: "first text"
          },
          {
            type: "image_url",
            image_url: {
              url: "https://example.com/image.png",
              detail: "auto"
            }
          },
          {
            type: "text",
            text: "second text"
          }
        ])
      }))

    it.effect("maps function_call output to tool-call part and sends function tool schema", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "tool_calls",
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [{
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "TestTool",
                          arguments: JSON.stringify({ input: "hello" })
                        }
                      }]
                    }
                  }]
                })
              ))
            })
          ))
        )

        const result = yield* LanguageModel.generateText({
          prompt: "use the tool",
          toolkit: TestToolkit,
          disableToolCallResolution: true
        }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(TestToolkitLayer),
          Effect.provide(layer)
        )

        const toolCall = result.content.find((part) => part.type === "tool-call")
        assert.isDefined(toolCall)
        if (toolCall?.type !== "tool-call") {
          return
        }

        assert.strictEqual(toolCall.name, "TestTool")
        assert.deepStrictEqual(toolCall.params, { input: "hello" })

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)
        const functionTool = requestBody.tools.find((tool: any) => tool.type === "function")
        assert.isDefined(functionTool)
        assert.strictEqual(functionTool.function.name, "TestTool")
        assert.strictEqual(functionTool.function.strict, true)
      }))

    it.effect("converts dynamic tools to function type", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: "Done"
                    }
                  }]
                })
              ))
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
          prompt: "use dynamic tool",
          toolkit: Toolkit.make(DynamicTool),
          disableToolCallResolution: true
        }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(layer)
        )

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)
        const functionTool = requestBody.tools?.find((tool: any) =>
          tool.type === "function" && tool.function?.name === "DynamicTool"
        )
        assert.isDefined(functionTool)
        assert.strictEqual(functionTool.function.description, "A dynamic tool")
        assert.deepStrictEqual(functionTool.function.parameters, inputSchema)
      }))

    it.effect("maps provider apply_patch function call back to custom provider-defined tool", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "tool_calls",
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [{
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "apply_patch",
                          arguments: JSON.stringify({
                            call_id: "call_1",
                            operation: {
                              type: "delete_file",
                              path: "src/obsolete.ts"
                            }
                          })
                        }
                      }]
                    }
                  }]
                })
              ))
            })
          ))
        )

        const toolkit = Toolkit.make(CompatApplyPatchTool({}))
        const toolkitLayer = toolkit.toLayer({
          CompatApplyPatch: () =>
            Effect.succeed({
              status: "completed",
              output: "deleted"
            })
        })

        const result = yield* LanguageModel.generateText({
          prompt: "delete src/obsolete.ts",
          toolkit,
          toolChoice: { tool: "CompatApplyPatch" },
          disableToolCallResolution: true
        }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(toolkitLayer),
          Effect.provide(layer)
        )

        const toolCall = result.content.find((part) => part.type === "tool-call")
        assert.isDefined(toolCall)
        if (toolCall?.type !== "tool-call") {
          return
        }

        assert.strictEqual(toolCall.name, "CompatApplyPatch")
        assert.deepStrictEqual(toolCall.params, {
          call_id: "call_1",
          operation: {
            type: "delete_file",
            path: "src/obsolete.ts"
          }
        })

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)

        const functionTool = requestBody.tools.find((tool: any) => tool.type === "function")
        assert.isDefined(functionTool)
        assert.strictEqual(functionTool.function.name, "apply_patch")
        assert.deepStrictEqual(requestBody.tool_choice, {
          type: "function",
          function: {
            name: "apply_patch"
          }
        })
      }))

    it.effect("decodes usage when token detail fields are absent", () =>
      Effect.gen(function*() {
        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) =>
              Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: "Hello"
                    }
                  }],
                  usage: {
                    prompt_tokens: 4,
                    completion_tokens: 5,
                    total_tokens: 9,
                    provider_future_field: true
                  }
                })
              ))
            )
          ))
        )

        const result = yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(layer)
        )

        const finish = result.content.find((part) => part.type === "finish")
        assert.isDefined(finish)
        if (finish?.type !== "finish") {
          return
        }

        assert.deepStrictEqual(finish.usage.inputTokens, {
          uncached: 4,
          total: 4,
          cacheRead: 0,
          cacheWrite: undefined
        })
        assert.deepStrictEqual(finish.usage.outputTokens, {
          total: 5,
          text: 5,
          reasoning: 0
        })
      }))
  })

  describe("generateObject", () => {
    it.effect("uses json_schema format for structured output", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: JSON.stringify({ name: "Ada", age: 37 })
                    }
                  }]
                })
              ))
            })
          ))
        )

        const person = yield* LanguageModel.generateObject({
          prompt: "Return a person",
          schema: Schema.Struct({
            name: Schema.String,
            age: Schema.Number
          })
        }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(layer)
        )

        assert.strictEqual(person.value.name, "Ada")
        assert.strictEqual(person.value.age, 37)

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)
        assert.strictEqual(requestBody.response_format.type, "json_schema")
        assert.strictEqual(requestBody.response_format.json_schema.strict, true)
      }))

    it.effect("uses OpenAI codec transformer for optional structured fields", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(
                request,
                makeChatCompletion({
                  choices: [{
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: JSON.stringify({ name: "Ada", nickname: null })
                    }
                  }]
                })
              ))
            })
          ))
        )

        const person = yield* LanguageModel.generateObject({
          prompt: "Return a person",
          schema: Schema.Struct({
            name: Schema.String,
            nickname: Schema.optionalKey(Schema.String)
          })
        }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(layer)
        )

        assert.strictEqual(person.value.name, "Ada")
        assert.isUndefined(person.value.nickname)

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)
        assert.deepStrictEqual(requestBody.response_format.json_schema.schema.required, ["name", "nickname"])
        assert.deepStrictEqual(requestBody.response_format.json_schema.schema.properties.nickname, {
          anyOf: [{ type: "string" }, { type: "null" }]
        })
      }))
  })

  describe("streamText", () => {
    it.effect("handles chat completion stream chunks", () =>
      Effect.gen(function*() {
        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) =>
              Effect.succeed(sseResponse(request, [
                {
                  id: "chatcmpl_test123",
                  object: "chat.completion.chunk",
                  model: "gpt-4o-mini",
                  created: 1,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: "stop"
                  }]
                },
                "[DONE]"
              ]))
            )
          ))
        )

        const partsChunk = yield* LanguageModel.streamText({ prompt: "test" }).pipe(
          Stream.runCollect,
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(layer)
        )

        const parts = Array.from(partsChunk)

        assert.isTrue(parts.some((part) => part.type === "response-metadata"))

        const finish = parts.find((part) => part.type === "finish")
        assert.isDefined(finish)
        if (finish?.type === "finish") {
          assert.strictEqual(finish.reason, "stop")
        }
      }))

    it.effect("maps local shell stream tool calls to local_shell call outputs", () =>
      Effect.gen(function*() {
        const capturedRequests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([])
        const requestCount = yield* Ref.make(0)

        const httpClient = HttpClient.makeWith(
          Effect.fnUntraced(function*(requestEffect) {
            const request = yield* requestEffect
            yield* Ref.update(capturedRequests, (requests) => [...requests, request])
            const index = yield* Ref.getAndUpdate(requestCount, (value) => value + 1)

            if (index === 0) {
              return sseResponse(request, [makeLocalShellChunk(), "[DONE]"])
            }

            return jsonResponse(request, makeChatCompletion())
          }),
          Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>
        )

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient))
        )

        const toolkit = Toolkit.make(CompatLocalShellTool({}))
        const toolkitLayer = toolkit.toLayer({
          CompatLocalShell: () => Effect.succeed("done")
        })

        const partsChunk = yield* LanguageModel.streamText({
          prompt: "Run pwd",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runCollect,
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(toolkitLayer),
          Effect.provide(layer)
        )

        const toolCall = globalThis.Array.from(partsChunk).find((part) => part.type === "tool-call")
        assert.isDefined(toolCall)
        if (toolCall?.type !== "tool-call") {
          return
        }

        assert.strictEqual(toolCall.name, "CompatLocalShell")
        assert.deepStrictEqual(toolCall.params, { action: localShellAction })

        yield* LanguageModel.generateText({
          prompt: Prompt.make([
            { role: "user", content: "Run pwd" },
            {
              role: "assistant",
              content: [Prompt.toolCallPart({
                id: toolCall.id,
                name: toolCall.name,
                params: { action: localShellAction },
                providerExecuted: false,
                options: {
                  openai: {
                    itemId: "ls_call_1"
                  }
                }
              })]
            },
            {
              role: "tool",
              content: [Prompt.toolResultPart({
                id: toolCall.id,
                name: toolCall.name,
                isFailure: false,
                result: "done"
              })]
            }
          ]),
          toolkit
        }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(toolkitLayer),
          Effect.provide(layer)
        )

        const requests = yield* Ref.get(capturedRequests)
        const followUpRequest = requests[1]
        assert.isDefined(followUpRequest)
        if (followUpRequest === undefined) {
          return
        }

        const followUpBody = yield* getRequestBody(followUpRequest)

        const localShellCall = followUpBody.messages.find((item: any) =>
          item.role === "assistant" && item.tool_calls?.[0]?.function?.name === "local_shell"
        )
        assert.isDefined(localShellCall)
        assert.strictEqual(localShellCall.tool_calls[0].id, toolCall.id)

        const localShellOutput = followUpBody.messages.find((item: any) => item.role === "tool")
        assert.isDefined(localShellOutput)
        assert.strictEqual(localShellOutput.tool_call_id, toolCall.id)
        assert.strictEqual(localShellOutput.content, "done")
      }))

    it.effect("maps apply_patch stream tool calls to custom provider-defined tool", () =>
      Effect.gen(function*() {
        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) =>
              Effect.succeed(sseResponse(request, [
                {
                  id: "chatcmpl_apply_patch_1",
                  object: "chat.completion.chunk",
                  model: "gpt-4o-mini",
                  created: 1,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: 0,
                        id: "patch_call_1",
                        type: "function",
                        function: {
                          name: "apply_patch",
                          arguments: JSON.stringify({
                            call_id: "patch_call_1",
                            operation: {
                              type: "delete_file",
                              path: "src/legacy.ts"
                            }
                          })
                        }
                      }]
                    },
                    finish_reason: "tool_calls"
                  }]
                },
                "[DONE]"
              ]))
            )
          ))
        )

        const toolkit = Toolkit.make(CompatApplyPatchTool({}))
        const toolkitLayer = toolkit.toLayer({
          CompatApplyPatch: () =>
            Effect.succeed({
              status: "completed",
              output: "deleted"
            })
        })

        const partsChunk = yield* LanguageModel.streamText({
          prompt: "Delete src/legacy.ts",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runCollect,
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(toolkitLayer),
          Effect.provide(layer)
        )

        const toolCall = globalThis.Array.from(partsChunk).find((part) => part.type === "tool-call")
        assert.isDefined(toolCall)
        if (toolCall?.type !== "tool-call") {
          return
        }

        assert.strictEqual(toolCall.name, "CompatApplyPatch")
        assert.deepStrictEqual(toolCall.params, {
          call_id: "patch_call_1",
          operation: {
            type: "delete_file",
            path: "src/legacy.ts"
          }
        })
      }))

    it.effect("preserves fragmented stream tool call ids and names", () =>
      Effect.gen(function*() {
        const expectedParams = {
          call_id: "patch_call_2",
          operation: {
            type: "delete_file",
            path: "src/fragmented.ts"
          }
        }
        const toolArguments = JSON.stringify(expectedParams)

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) =>
              Effect.succeed(sseResponse(request, [
                {
                  id: "chatcmpl_apply_patch_fragmented_1",
                  object: "chat.completion.chunk",
                  model: "gpt-4o-mini",
                  created: 1,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: 0,
                        id: "patch_call_2",
                        type: "function",
                        function: {
                          name: "apply_patch",
                          arguments: toolArguments.slice(0, 24)
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                },
                {
                  id: "chatcmpl_apply_patch_fragmented_1",
                  object: "chat.completion.chunk",
                  model: "gpt-4o-mini",
                  created: 1,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: 0,
                        function: {
                          arguments: toolArguments.slice(24, 48)
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                },
                {
                  id: "chatcmpl_apply_patch_fragmented_1",
                  object: "chat.completion.chunk",
                  model: "gpt-4o-mini",
                  created: 1,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: 0,
                        function: {
                          arguments: toolArguments.slice(48)
                        }
                      }]
                    },
                    finish_reason: "tool_calls"
                  }]
                },
                "[DONE]"
              ]))
            )
          ))
        )

        const toolkit = Toolkit.make(CompatApplyPatchTool({}))
        const toolkitLayer = toolkit.toLayer({
          CompatApplyPatch: () =>
            Effect.succeed({
              status: "completed",
              output: "deleted"
            })
        })

        const partsChunk = yield* LanguageModel.streamText({
          prompt: "Delete src/fragmented.ts",
          toolkit,
          disableToolCallResolution: true
        }).pipe(
          Stream.runCollect,
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(toolkitLayer),
          Effect.provide(layer)
        )

        const parts = globalThis.Array.from(partsChunk)

        const start = parts.find((part) => part.type === "tool-params-start" && part.id === "patch_call_2")
        assert.isDefined(start)
        if (start?.type !== "tool-params-start") {
          return
        }
        assert.strictEqual(start.name, "CompatApplyPatch")

        assert.deepStrictEqual(decodeToolParamsFromStream(parts, "patch_call_2"), expectedParams)

        const toolCall = parts.find((part) => part.type === "tool-call")
        assert.isDefined(toolCall)
        if (toolCall?.type !== "tool-call") {
          return
        }

        assert.strictEqual(toolCall.id, "patch_call_2")
        assert.strictEqual(toolCall.name, "CompatApplyPatch")
        assert.deepStrictEqual(toolCall.params, expectedParams)
      }))

    it.effect("streams known events and ignores unknown ones", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const events = [
          {
            id: "chatcmpl_stream_1",
            object: "chat.completion.chunk",
            model: "gpt-4o-mini",
            created: 1,
            choices: [{
              index: 0,
              delta: { content: "Hello" },
              finish_reason: null
            }]
          },
          {
            id: "chatcmpl_stream_1",
            object: "chat.completion.chunk",
            model: "gpt-4o-mini",
            created: 1,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop"
            }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 7,
              total_tokens: 17,
              prompt_tokens_details: {
                cached_tokens: 3
              },
              completion_tokens_details: {
                reasoning_tokens: 2
              }
            },
            provider_future_field: { accepted: true }
          },
          "[DONE]"
        ]

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(sseResponse(request, events))
            })
          ))
        )

        const partsChunk = yield* LanguageModel.streamText({ prompt: "hello" }).pipe(
          Stream.runCollect,
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini")),
          Effect.provide(layer)
        )

        const parts = globalThis.Array.from(partsChunk)
        const metadata = parts.find((part) => part.type === "response-metadata")
        const finish = parts.find((part) => part.type === "finish")
        const deltas = parts.filter((part) => part.type === "text-delta")

        assert.isDefined(metadata)
        assert.isDefined(finish)
        assert.strictEqual(deltas.length, 1)
        assert.strictEqual(deltas[0]?.delta, "Hello")
        if (finish?.type === "finish") {
          assert.strictEqual(finish.reason, "stop")
          assert.deepStrictEqual(finish.usage.inputTokens, {
            uncached: 7,
            total: 10,
            cacheRead: 3,
            cacheWrite: undefined
          })
          assert.deepStrictEqual(finish.usage.outputTokens, {
            total: 7,
            text: 5,
            reasoning: 2
          })
        }

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) {
          return
        }

        const requestBody = yield* getRequestBody(capturedRequest)
        assert.strictEqual(requestBody.stream, true)
        assert.isTrue(capturedRequest.url.endsWith("/chat/completions"))
      }))
  })

  describe("config", () => {
    it.effect("does not leak library-only fields into request body", () =>
      Effect.gen(function*() {
        let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

        const layer = OpenAiClient.layer({ apiKey: Redacted.make("sk-test-key") }).pipe(
          Layer.provide(Layer.succeed(
            HttpClient.HttpClient,
            makeHttpClient((request) => {
              capturedRequest = request
              return Effect.succeed(jsonResponse(request, makeChatCompletion()))
            })
          ))
        )

        yield* LanguageModel.generateText({ prompt: "test" }).pipe(
          Effect.provide(OpenAiLanguageModel.model("gpt-4o-mini", {
            fileIdPrefixes: ["file-"],
            strictJsonSchema: false,
            temperature: 0.5
          })),
          Effect.provide(layer)
        )

        assert.isDefined(capturedRequest)
        if (capturedRequest === undefined) return

        const requestBody = yield* getRequestBody(capturedRequest)
        assert.strictEqual(requestBody.fileIdPrefixes, undefined)
        assert.strictEqual(requestBody.strictJsonSchema, undefined)
        assert.strictEqual(requestBody.temperature, 0.5)
      }))
  })
})

const TestTool = Tool.make("TestTool", {
  description: "A test tool",
  parameters: Schema.Struct({ input: Schema.String }),
  success: Schema.Struct({ output: Schema.String })
})

const TestToolkit = Toolkit.make(TestTool)

const TestToolkitLayer = TestToolkit.toLayer({
  TestTool: ({ input }) => Effect.succeed({ output: input })
})

const CompatApplyPatchTool = Tool.providerDefined({
  id: "compat.apply_patch",
  customName: "CompatApplyPatch",
  providerName: "apply_patch",
  requiresHandler: true,
  parameters: Schema.Struct({
    call_id: Schema.String,
    operation: Schema.Any
  }),
  success: Schema.Struct({
    status: Schema.Literals(["completed", "failed"]),
    output: Schema.optionalKey(Schema.NullOr(Schema.String))
  })
})

const localShellAction = {
  type: "exec",
  command: ["pwd"],
  env: {}
}

const CompatLocalShellTool = Tool.providerDefined({
  id: "compat.local_shell",
  customName: "CompatLocalShell",
  providerName: "local_shell",
  requiresHandler: true,
  parameters: Schema.Struct({
    action: Schema.Any
  }),
  success: Schema.String
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

const makeChatCompletion = (overrides: Record<string, unknown> = {}) => ({
  id: "chatcmpl_test_1",
  object: "chat.completion",
  model: "gpt-4o-mini",
  created: 1,
  choices: [{
    index: 0,
    finish_reason: "stop",
    message: {
      role: "assistant",
      content: ""
    }
  }],
  ...overrides
})

const makeLocalShellChunk = () => ({
  id: "chatcmpl_local_shell_1",
  object: "chat.completion.chunk",
  model: "gpt-4o-mini",
  created: 1,
  choices: [{
    index: 0,
    delta: {
      tool_calls: [{
        index: 0,
        id: "local_shell_call_1",
        type: "function",
        function: {
          name: "local_shell",
          arguments: JSON.stringify({ action: localShellAction })
        }
      }]
    },
    finish_reason: "tool_calls"
  }]
})

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

const decodeToolParamsFromStream = (
  parts: ReadonlyArray<any>,
  toolCallId: string
): Record<string, unknown> => {
  const start = parts.find((part) => part.type === "tool-params-start" && part.id === toolCallId)
  const end = parts.find((part) => part.type === "tool-params-end" && part.id === toolCallId)
  assert.isDefined(start)
  assert.isDefined(end)

  const deltas = parts
    .filter((part) => part.type === "tool-params-delta" && part.id === toolCallId)
    .map((part) => part.delta)
    .join("")

  return JSON.parse(deltas) as Record<string, unknown>
}

const toSseBody = (events: ReadonlyArray<unknown>): string =>
  events.map((event) => {
    if (typeof event === "string") {
      return `data: ${event}\n\n`
    }
    return `data: ${JSON.stringify(event)}\n\n`
  }).join("")
