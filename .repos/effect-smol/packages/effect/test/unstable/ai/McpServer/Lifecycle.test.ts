import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import * as McpServer from "effect/unstable/ai/McpServer"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import { makeRawHttpHarness, makeServerLayer } from "./utils.ts"

const ServerLayer = makeServerLayer({ name: "LifecycleServer" })
const makeHarness = makeRawHttpHarness(ServerLayer)

const initializeRequest = (protocolVersion: string, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: {
      name: "LifecycleClient",
      version: "1.0.0"
    }
  }
})

const initializedNotification = {
  jsonrpc: "2.0",
  method: "notifications/initialized"
}

const pingRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "ping",
  params: {}
}

const InitializeResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  result: McpSchema.InitializeResult
})

const ErrorResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.NullOr(Schema.Number),
  error: McpSchema.McpError
})

const decodeInitializeResponse = Schema.decodeUnknownEffect(InitializeResponse)
const decodeErrorResponse = Schema.decodeUnknownEffect(ErrorResponse)

type Post = (body: unknown, headers?: HeadersInit) => Effect.Effect<Response>

const initialize = Effect.fnUntraced(function*(
  post: Post,
  protocolVersion: string,
  id = 1
) {
  const response = yield* post(initializeRequest(protocolVersion, id))
  const body = yield* Effect.promise<unknown>(() => response.json())
  return {
    response,
    message: yield* decodeInitializeResponse(body)
  } as const
})

const TestTool = Tool.make("TestTool", {
  success: Schema.String
})
const TestToolkit = Toolkit.make(TestTool)
const TestToolkitLayer = McpServer.toolkit(TestToolkit).pipe(
  Layer.provide(TestToolkit.toLayer({
    TestTool: () => Effect.succeed("ok")
  }))
)
const FeaturesServerLayer = Layer.mergeAll(
  TestToolkitLayer,
  McpServer.resource({
    uri: "file:///test",
    name: "TestResource",
    content: Effect.succeed("test")
  }),
  McpServer.prompt({
    name: "TestPrompt",
    content: () => Effect.succeed("test")
  })
).pipe(
  Layer.provide(makeServerLayer({
    name: "LifecycleServer",
    extensions: { "example/lifecycle": { enabled: true } }
  }))
)

describe("McpServer initialization", () => {
  describe("2025-11-25", () => {
    describe("Lifecycle", () => {
      describe("1. Lifecycle Phases", () => {
        describe("1.1 Initialization", () => {
          it.effect("requires initialize to be the first request", () =>
            Effect.gen(function*() {
              const { post } = yield* makeHarness
              const response = yield* post(pingRequest)

              assert.isAtLeast(response.status, 400)
            }))

          it.effect("rejects initialized notifications before initialize", () =>
            Effect.gen(function*() {
              const { post } = yield* makeHarness
              const response = yield* post(initializedNotification)

              assert.isAtLeast(response.status, 400)
            }))

          it.effect("requires protocolVersion, capabilities, and clientInfo", () =>
            Effect.gen(function*() {
              const { post } = yield* makeHarness
              const invalidParams = [
                {
                  capabilities: {},
                  clientInfo: { name: "LifecycleClient", version: "1.0.0" }
                },
                {
                  protocolVersion: "2025-11-25",
                  clientInfo: { name: "LifecycleClient", version: "1.0.0" }
                },
                {
                  protocolVersion: "2025-11-25",
                  capabilities: {}
                }
              ]

              for (let i = 0; i < invalidParams.length; i++) {
                const response = yield* post({
                  jsonrpc: "2.0",
                  id: i + 1,
                  method: "initialize",
                  params: invalidParams[i]
                })
                const body = yield* Effect.promise<unknown>(() => response.json())
                const error = yield* decodeErrorResponse(body)

                assert.strictEqual(error.id, i + 1)
                assert.isNumber(error.error.code)
                assert.isNull(response.headers.get("Mcp-Session-Id"))
              }
            }))

          it.effect("returns server capabilities and implementation information", () =>
            Effect.gen(function*() {
              const { post } = yield* makeHarness
              const { message, response } = yield* initialize(post, "2025-11-25")

              assert.strictEqual(response.status, 200)
              assert.strictEqual(message.id, 1)
              assert.deepStrictEqual(message.result.capabilities, { completions: {} })
              assert.deepStrictEqual(message.result.serverInfo, {
                name: "LifecycleServer",
                version: "1.0.0"
              })
              const sessionId = response.headers.get("Mcp-Session-Id")
              assert.isNotNull(sessionId)
              assert.match(sessionId, /^[\x21-\x7e]+$/)
            }))

          it.effect("accepts initialized after a successful initialize response", () =>
            Effect.gen(function*() {
              const { post } = yield* makeHarness
              const initialized = yield* initialize(post, "2025-11-25")
              const sessionId = initialized.response.headers.get("Mcp-Session-Id")
              assert.isNotNull(sessionId)

              const response = yield* post(initializedNotification, {
                "Mcp-Session-Id": sessionId,
                "Mcp-Protocol-Version": initialized.message.result.protocolVersion
              })

              assert.strictEqual(response.status, 202)
              assert.strictEqual(yield* Effect.promise(() => response.text()), "")
            }))
        })

        describe("1.1.1 Version Negotiation", () => {
          it.effect("echoes every requested version supported by the server", () =>
            Effect.gen(function*() {
              const { post } = yield* makeHarness
              const supportedVersions = ["2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]

              for (let i = 0; i < supportedVersions.length; i++) {
                const protocolVersion = supportedVersions[i]
                const { message } = yield* initialize(post, protocolVersion, i + 1)
                assert.strictEqual(message.result.protocolVersion, protocolVersion)
              }
            }))

          it.effect("negotiates an unsupported requested version to the latest supported version", () =>
            Effect.gen(function*() {
              const { post } = yield* makeHarness
              const { message } = yield* initialize(post, "2025-11-25")

              assert.strictEqual(message.result.protocolVersion, "2025-06-18")
            }))
        })

        describe("1.1.2 Capability Negotiation", () => {
          it.effect("advertises the capabilities provided by the server", () =>
            Effect.gen(function*() {
              const { post } = yield* makeRawHttpHarness(FeaturesServerLayer)
              const { message } = yield* initialize(post, "2025-11-25")

              assert.deepStrictEqual(message.result.capabilities, {
                completions: {},
                extensions: { "example/lifecycle": { enabled: true } },
                prompts: { listChanged: true },
                resources: { listChanged: true, subscribe: false },
                tools: { listChanged: true }
              })
            }))
        })

        describe("1.2 Operation", () => {
          it.effect("continues to use the version negotiated during initialization", () =>
            Effect.gen(function*() {
              const { post } = yield* makeHarness
              const initialized = yield* initialize(post, "2025-03-26")
              const sessionId = initialized.response.headers.get("Mcp-Session-Id")
              assert.isNotNull(sessionId)

              const response = yield* post(pingRequest, { "Mcp-Session-Id": sessionId })

              assert.strictEqual(response.status, 200)
              assert.strictEqual(response.headers.get("Mcp-Protocol-Version"), "2025-03-26")
            }))
        })
      })

      describe("3. Error Handling", () => {
        it.effect("handles protocol version mismatch through version negotiation", () =>
          Effect.gen(function*() {
            const { post } = yield* makeHarness
            const { message } = yield* initialize(post, "invalid-version")

            assert.strictEqual(message.result.protocolVersion, "2025-06-18")
          }))
      })
    })
  })
})
