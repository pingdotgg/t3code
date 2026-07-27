import { Generated, OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { assert, describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array, Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { HttpClient, type HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

describe("OpenRouterLanguageModel", () => {
  describe("generateText", () => {
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
    })

    describe("tool preparation", () => {
      it.effect("passes raw JSON schema for dynamic tools", () =>
        Effect.gen(function*() {
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
    })
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

const getRequestBody = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function*() {
    const body = request.body
    if (body._tag === "Uint8Array") {
      const text = new TextDecoder().decode(body.body)
      return JSON.parse(text)
    }
    return yield* Effect.die(new Error("Expected Uint8Array body"))
  })
