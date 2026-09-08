import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CurrentLogLevel } from "effect/References"
import * as Schema from "effect/Schema"
import * as McpCore from "effect/unstable/ai/internal/mcpCore"
import * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import * as McpServer from "effect/unstable/ai/McpServer"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import { makeHttpHarness } from "./TestUtils/McpHttpHarness.ts"

const ServerIcon = McpSchema.Icon.make({
  src: "https://example.com/server.svg",
  mimeType: "image/svg+xml",
  sizes: ["48x48", "any"],
  theme: "dark"
})
const ResourceIcon = McpSchema.Icon.make({ src: "https://example.com/resource.svg" })
const PromptIcon = McpSchema.Icon.make({ src: "https://example.com/prompt.svg" })
const ToolIcon = McpSchema.Icon.make({ src: "https://example.com/tool.svg" })

const SharedTool = Tool.make("shared", {
  parameters: Tool.EmptyParams,
  success: Schema.String
}).annotate(Tool.Title, "Shared tool title")

const StructuredOnlyTool = Tool.make("structured-only", {
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ value: Schema.String })
}).annotate(
  McpSchema.EnabledWhen,
  (client) => client.protocolVersion === "2025-06-18"
)

const ValidatedTool = Tool.make("validated", {
  parameters: Schema.Struct({
    value: Schema.String
  }),
  success: Schema.String
})

const CapabilityTool = Tool.make("capability", {
  parameters: Tool.EmptyParams,
  success: Schema.String,
  dependencies: [McpSchema.McpServerClient]
})

const InitializeMetadataTool = Tool.make("initialize-metadata", {
  parameters: Tool.EmptyParams,
  success: Schema.String,
  dependencies: [McpSchema.McpServerClient]
})

const LogLevelTool = Tool.make("log-level", {
  parameters: Tool.EmptyParams,
  success: Schema.String,
  dependencies: [CurrentLogLevel]
})

const CapabilityGatedTool = Tool.make("capability-gated", {
  parameters: Tool.EmptyParams,
  success: Schema.String
}).annotate(
  McpSchema.EnabledWhen,
  (client) =>
    client.clientInfo.name === "allowed-client" &&
    client.capabilities.roots !== undefined
)

const TestToolkit = Toolkit.make(
  SharedTool,
  StructuredOnlyTool,
  ValidatedTool,
  CapabilityTool,
  InitializeMetadataTool,
  LogLevelTool,
  CapabilityGatedTool
)

const FamilyResource = McpServer.resource({
  uri: "file:///canonical.txt",
  name: "canonical",
  description: "Canonical resource",
  mimeType: "text/plain",
  content: Effect.succeed("canonical resource")
})

const FamilyPrompt = McpServer.prompt({
  name: "canonical-prompt",
  description: "Canonical prompt",
  parameters: {
    style: Schema.String
  },
  completion: {
    style: () => Effect.succeed(["short", "long"])
  },
  content: ({ style }) => Effect.succeed(`Use the ${style} style`)
})

const AudioPrompt = McpServer.prompt({
  name: "audio-prompt",
  content: () =>
    Effect.succeed([{
      role: "user",
      content: McpSchema.AudioContent.make({
        data: new Uint8Array([1, 2, 3]),
        mimeType: "audio/wav"
      })
    }])
})

const ResourceLinkPrompt = McpServer.prompt({
  name: "resource-link-prompt",
  content: () =>
    Effect.succeed([{
      role: "user",
      content: McpSchema.ResourceLink.make({
        uri: "file:///canonical.txt",
        name: "canonical"
      })
    }])
})

interface TestState {
  sharedInvocations: number
  structuredInvocations: number
  capabilityInvocations: number
}

const makeFixture = Effect.fnUntraced(function*() {
  const state: TestState = {
    sharedInvocations: 0,
    structuredInvocations: 0,
    capabilityInvocations: 0
  }
  const toolkitLayer = McpServer.toolkit(TestToolkit).pipe(
    Layer.provideMerge(TestToolkit.toLayer(TestToolkit.of({
      shared: () =>
        Effect.sync(() => {
          state.sharedInvocations++
          return "shared-result"
        }),
      "structured-only": () =>
        Effect.sync(() => {
          state.structuredInvocations++
          return { value: "structured-result" }
        }),
      validated: ({ value }) => Effect.succeed(value),
      capability: () =>
        McpServer.clientCapabilities.pipe(
          Effect.map((capabilities) => {
            state.capabilityInvocations++
            return JSON.stringify(capabilities)
          })
        ),
      "initialize-metadata": () =>
        McpSchema.McpServerClient.useSync((client) => JSON.stringify(client.initializePayload._meta)),
      "log-level": () => CurrentLogLevel,
      "capability-gated": () => Effect.succeed("visible")
    })))
  )
  const serverLayer = Layer.mergeAll(
    toolkitLayer,
    FamilyResource,
    FamilyPrompt,
    AudioPrompt,
    ResourceLinkPrompt
  ).pipe(
    Layer.provide(McpServer.layerHttp({
      name: "ProtocolAdapterServer",
      version: "1.0.0",
      description: "Protocol adapter fixture",
      websiteUrl: "https://example.com/mcp",
      icons: [McpSchema.Icon.make({
        src: "https://example.com/server.svg",
        mimeType: "image/svg+xml",
        sizes: ["any"]
      })],
      path: "/mcp",
      protocols: [
        McpProtocol.v2025_11_25,
        McpProtocol.v2025_06_18,
        McpProtocol.v2025_03_26,
        McpProtocol.v2024_11_05
      ]
    }))
  )
  const harness = yield* makeHttpHarness(serverLayer)
  return { ...harness, state }
})

interface LowLevelTestState {
  imageInvocations: number
  audioInvocations: number
  resourceLinkInvocations: number
  projectionMismatchInvocations: number
  argumentObservations: Array<unknown>
  duplicateInvocations: Array<"first" | "second">
}

const makeLowLevelFixture = Effect.fnUntraced(function*() {
  const state: LowLevelTestState = {
    imageInvocations: 0,
    audioInvocations: 0,
    resourceLinkInvocations: 0,
    projectionMismatchInvocations: 0,
    argumentObservations: [],
    duplicateInvocations: []
  }
  const registrations = Layer.effectDiscard(
    Effect.gen(function*() {
      const server = yield* McpServer.McpServer
      const makeTool = (name: string, description: string) =>
        new McpSchema.Tool({
          name,
          description,
          inputSchema: {
            type: "object",
            properties: {}
          }
        })

      yield* server.addResource({
        resource: new McpSchema.Resource({
          uri: "file:///metadata.txt",
          name: "metadata-resource",
          icons: [ResourceIcon],
          _meta: { descriptor: "fixture" }
        }),
        annotations: Context.empty(),
        handle: Effect.succeed(
          McpSchema.ReadResourceResult.make({
            contents: [{ uri: "file:///metadata.txt", text: "metadata" }],
            _meta: { result: "fixture" }
          })
        )
      })
      yield* server.addPrompt({
        prompt: new McpSchema.Prompt({
          name: "metadata-prompt",
          icons: [PromptIcon],
          _meta: { descriptor: "fixture" }
        }),
        annotations: Context.empty(),
        completions: {
          value: () =>
            Effect.succeed(
              McpSchema.CompleteResult.make({
                completion: { values: ["metadata"] },
                _meta: { result: "fixture" }
              })
            )
        },
        handle: () =>
          Effect.succeed(
            McpSchema.GetPromptResult.make({
              messages: [{
                role: "user",
                content: { type: "text", text: "metadata", _meta: { content: "fixture" } }
              }],
              _meta: { result: "fixture" }
            })
          )
      })

      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: "title-precedence",
          title: "Canonical title",
          icons: [ToolIcon],
          inputSchema: {
            type: "object",
            properties: {}
          },
          annotations: {
            title: "Legacy annotation title"
          }
        }),
        annotations: Context.empty(),
        handle: () =>
          Effect.succeed(
            new McpSchema.CallToolResult({
              content: [{ type: "text", text: "title" }]
            })
          )
      })
      yield* server.addTool({
        tool: makeTool("projection-mismatch", "Claims old support but returns audio"),
        annotations: Context.empty(),
        handle: () =>
          Effect.sync(() => {
            state.projectionMismatchInvocations++
            return new McpSchema.CallToolResult({
              content: [{
                type: "audio",
                data: new Uint8Array([1]),
                mimeType: "audio/wav"
              }]
            })
          })
      })
      yield* server.addTool({
        tool: makeTool("arguments", "Argument normalization probe"),
        annotations: Context.empty(),
        handle: (payload) =>
          Effect.sync(() => {
            state.argumentObservations.push(payload)
            return new McpSchema.CallToolResult({
              content: [{ type: "text", text: "arguments" }]
            })
          })
      })
      yield* server.addTool({
        tool: makeTool("image", "Image for both revisions"),
        annotations: Context.empty(),
        handle: () =>
          Effect.sync(() => {
            state.imageInvocations++
            return new McpSchema.CallToolResult({
              content: [{
                type: "image",
                data: new Uint8Array([1, 2, 3]),
                mimeType: "image/png"
              }]
            })
          })
      })
      yield* server.addTool({
        tool: makeTool("binary-resource", "Binary embedded resource"),
        annotations: Context.empty(),
        handle: () =>
          Effect.succeed(
            new McpSchema.CallToolResult({
              content: [{
                type: "resource",
                resource: {
                  uri: "file:///binary.dat",
                  mimeType: "application/octet-stream",
                  blob: new Uint8Array([7, 8, 9])
                }
              }]
            })
          )
      })
      yield* server.addTool({
        tool: makeTool("annotated-resource", "Annotated embedded resource"),
        annotations: Context.empty(),
        handle: () =>
          Effect.succeed(
            new McpSchema.CallToolResult({
              content: [{
                type: "resource",
                resource: {
                  uri: "file:///annotated.txt",
                  mimeType: "text/plain",
                  text: "annotated",
                  _meta: { source: "fixture" }
                },
                annotations: {
                  audience: ["assistant"],
                  priority: 0.75,
                  lastModified: "2026-08-13T00:00:00Z"
                },
                _meta: { content: "fixture" }
              }],
              _meta: { result: "fixture" }
            })
          )
      })
      yield* server.addTool({
        tool: makeTool("audio", "Current-revision audio"),
        annotations: Context.empty(),
        handle: () =>
          Effect.sync(() => {
            state.audioInvocations++
            return new McpSchema.CallToolResult({
              content: [{
                type: "audio",
                data: new Uint8Array([4, 5, 6]),
                mimeType: "audio/wav"
              }]
            })
          })
      })
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: "schema-output",
          description: "Tool with an output schema",
          inputSchema: {
            type: "object",
            properties: {}
          },
          outputSchema: {
            type: "object",
            properties: {
              value: { type: "string" }
            },
            required: ["value"]
          },
          _meta: { descriptor: "fixture" }
        }),
        annotations: Context.empty(),
        handle: () =>
          Effect.succeed(
            new McpSchema.CallToolResult({
              content: [{ type: "text", text: "schema" }]
            })
          )
      })
      yield* server.addTool({
        tool: makeTool("structured-object", "Object structured content"),
        annotations: Context.empty(),
        handle: () =>
          Effect.succeed(
            new McpSchema.CallToolResult({
              content: [{ type: "text", text: "structured" }],
              structuredContent: { value: "fixture" }
            })
          )
      })
      yield* server.addTool({
        tool: makeTool("structured-scalar", "Scalar structured content"),
        annotations: Context.empty(),
        handle: () =>
          Effect.succeed(
            new McpSchema.CallToolResult({
              content: [{ type: "text", text: "structured" }],
              structuredContent: "fixture"
            })
          )
      })
      yield* server.addTool({
        tool: makeTool("resource-link", "Current-revision resource link"),
        annotations: Context.empty(),
        handle: () =>
          Effect.sync(() => {
            state.resourceLinkInvocations++
            return new McpSchema.CallToolResult({
              content: [{
                type: "resource_link",
                name: "linked",
                title: "Linked resource",
                description: "A linked fixture",
                uri: "file:///linked.txt",
                mimeType: "text/plain",
                annotations: {
                  audience: ["user"],
                  priority: 0.5
                },
                size: 42,
                _meta: { source: "fixture" }
              }]
            })
          })
      })
      yield* server.addTool({
        tool: makeTool("duplicate", "first descriptor"),
        annotations: Context.empty(),
        handle: () =>
          Effect.sync(() => {
            state.duplicateInvocations.push("first")
            return new McpSchema.CallToolResult({
              content: [{ type: "text", text: "first" }]
            })
          })
      })
      yield* server.addTool({
        tool: makeTool("duplicate", "second descriptor"),
        annotations: Context.empty(),
        handle: () =>
          Effect.sync(() => {
            state.duplicateInvocations.push("second")
            return new McpSchema.CallToolResult({
              content: [{ type: "text", text: "second" }]
            })
          })
      })
    })
  )
  const serverLayer = registrations.pipe(
    Layer.provide(McpServer.layerHttp({
      name: "LowLevelProtocolAdapterServer",
      version: "1.0.0",
      description: "Low-level protocol adapter fixture",
      websiteUrl: "https://example.com/low-level-mcp",
      icons: [ServerIcon],
      path: "/mcp",
      protocols: [
        McpProtocol.v2025_11_25,
        McpProtocol.v2025_06_18,
        McpProtocol.v2025_03_26,
        McpProtocol.v2024_11_05
      ]
    }))
  )
  const harness = yield* makeHttpHarness(serverLayer)
  return { ...harness, state }
})

const JsonRpcResponse = Schema.Union([
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Number,
    result: Schema.Record(Schema.String, Schema.Unknown)
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.NullOr(Schema.Number),
    error: Schema.Struct({
      code: Schema.Number,
      message: Schema.String
    })
  })
])
type JsonRpcResponse = typeof JsonRpcResponse.Type

const decodeJsonRpcResponse = Schema.decodeUnknownEffect(JsonRpcResponse)

const initialize = Effect.fnUntraced(function*(
  post: Effect.Success<ReturnType<typeof makeFixture>>["post"],
  protocolVersion: "2025-11-25" | "2025-06-18" | "2025-03-26" | "2024-11-05",
  options?: {
    readonly capabilities?: Record<string, unknown>
    readonly clientInfo?: {
      readonly name: string
      readonly version: string
    }
  }
) {
  const response = yield* post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: options?.capabilities ?? {},
      clientInfo: options?.clientInfo ?? {
        name: "ProtocolAdapterClient",
        version: "1.0.0"
      }
    }
  })
  const body = yield* Effect.promise<unknown>(() => response.json()).pipe(
    Effect.flatMap(decodeJsonRpcResponse)
  )
  if (!("result" in body)) {
    return yield* Effect.die(`Initialization failed: ${body.error.message}`)
  }
  const sessionId = response.headers.get("Mcp-Session-Id")
  assert.isNotNull(sessionId)
  assert.strictEqual(body.result.protocolVersion, protocolVersion)

  let requestId = 1
  const request = Effect.fnUntraced(function*(method: string, params?: unknown) {
    const response = yield* post({
      jsonrpc: "2.0",
      id: ++requestId,
      method,
      ...(params === undefined ? {} : { params })
    }, {
      "Mcp-Protocol-Version": protocolVersion,
      "Mcp-Session-Id": sessionId
    })
    return yield* Effect.promise<unknown>(() => response.json()).pipe(
      Effect.flatMap(decodeJsonRpcResponse)
    )
  })

  return { initializeResult: body.result, protocolVersion, request }
})

const resultOf = (message: JsonRpcResponse): Record<string, unknown> => {
  if (!("result" in message)) {
    assert.fail(`Expected result, received error ${message.error.code}: ${message.error.message}`)
  }
  return message.result
}

const errorOf = (message: JsonRpcResponse): {
  readonly code: number
  readonly message: string
} => {
  if (!("error" in message)) {
    assert.fail("Expected error, received result")
  }
  return message.error
}

const listedTools = (message: JsonRpcResponse): ReadonlyArray<Record<string, unknown>> => {
  const tools = resultOf(message).tools
  return Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))(tools)
}

const textResult = (message: JsonRpcResponse): string => {
  const content = resultOf(message).content
  const [first] = Schema.decodeUnknownSync(
    Schema.NonEmptyArray(Schema.Record(Schema.String, Schema.Unknown))
  )(content)
  assert.strictEqual(first.type, "text")
  const text = Schema.decodeUnknownSync(Schema.String)(first.text)
  return JSON.parse(text)
}

describe("McpServer protocol adapters", () => {
  it.effect("should keep log levels isolated when one session updates its level", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const first = yield* initialize(fixture.post, "2025-06-18")
      const second = yield* initialize(fixture.post, "2025-06-18")

      resultOf(yield* first.request("logging/setLevel", { level: "debug" }))

      assert.strictEqual(
        textResult(yield* first.request("tools/call", { name: "log-level" })),
        "Debug"
      )
      assert.strictEqual(
        textResult(yield* second.request("tools/call", { name: "log-level" })),
        "Info"
      )
    }))

  it.effect("should reject prompt content when the negotiated schema cannot represent it", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const oldClient = yield* initialize(fixture.post, "2024-11-05")
      const marchClient = yield* initialize(fixture.post, "2025-03-26")
      const juneClient = yield* initialize(fixture.post, "2025-06-18")

      assert.strictEqual(
        errorOf(yield* oldClient.request("prompts/get", { name: "audio-prompt" })).code,
        McpSchema.INVALID_PARAMS_ERROR_CODE
      )
      assert.property(
        resultOf(yield* marchClient.request("prompts/get", { name: "audio-prompt" })),
        "messages"
      )
      assert.strictEqual(
        errorOf(yield* marchClient.request("prompts/get", { name: "resource-link-prompt" })).code,
        McpSchema.INVALID_PARAMS_ERROR_CODE
      )
      assert.property(
        resultOf(yield* juneClient.request("prompts/get", { name: "resource-link-prompt" })),
        "messages"
      )
    }))

  it.effect("should project canonical notifications when encoding each protocol revision", () =>
    Effect.gen(function*() {
      for (
        const protocol of [
          McpProtocol.v2024_11_05,
          McpProtocol.v2025_03_26,
          McpProtocol.v2025_06_18
        ]
      ) {
        const metadata = { source: "test" }
        const progress = yield* protocol.projectNotification(McpCore.ServerNotification.Progress({
          progressToken: "task-1",
          progress: 1,
          total: 2,
          message: "half way",
          metadata
        }))
        assert.isDefined(progress)
        assert.strictEqual(progress.tag, "notifications/progress")
        assert.deepStrictEqual(progress.payload, {
          _meta: metadata,
          progressToken: "task-1",
          progress: 1,
          total: 2,
          message: protocol.protocolVersion === "2024-11-05" ? undefined : "half way"
        })

        for (
          const [notification, expected] of [
            [
              McpCore.ServerNotification.Cancelled({ requestId: 1, reason: "done", metadata }),
              { tag: "notifications/cancelled", payload: { _meta: metadata, requestId: 1, reason: "done" } }
            ],
            [
              McpCore.ServerNotification.LoggingMessage({
                level: "info",
                logger: "test",
                data: { ready: true },
                metadata
              }),
              {
                tag: "notifications/message",
                payload: { _meta: metadata, level: "info", logger: "test", data: { ready: true } }
              }
            ],
            [
              McpCore.ServerNotification.ResourceUpdated({ uri: "test://resource", metadata }),
              {
                tag: "notifications/resources/updated",
                payload: { _meta: metadata, uri: "test://resource" }
              }
            ],
            [
              McpCore.ServerNotification.ResourcesChanged({ metadata }),
              { tag: "notifications/resources/list_changed", payload: { _meta: metadata } }
            ],
            [
              McpCore.ServerNotification.ToolsChanged({ metadata }),
              { tag: "notifications/tools/list_changed", payload: { _meta: metadata } }
            ],
            [
              McpCore.ServerNotification.PromptsChanged({ metadata }),
              { tag: "notifications/prompts/list_changed", payload: { _meta: metadata } }
            ]
          ] as const
        ) {
          assert.deepStrictEqual(yield* protocol.projectNotification(notification), expected)
        }
      }

      const elicitationComplete = McpCore.ServerNotification.ElicitationComplete({ elicitationId: "elicitation-1" })
      assert.deepStrictEqual(yield* McpProtocol.v2025_11_25.projectNotification(elicitationComplete), {
        tag: "notifications/elicitation/complete",
        payload: { elicitationId: "elicitation-1" }
      })
      for (
        const protocol of [
          McpProtocol.v2024_11_05,
          McpProtocol.v2025_03_26,
          McpProtocol.v2025_06_18
        ]
      ) {
        assert.isUndefined(yield* protocol.projectNotification(elicitationComplete))
      }
    }))
  it.effect("should omit elicitation when the negotiated protocol predates v2025-06-18", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      for (const protocolVersion of ["2024-11-05", "2025-03-26"] as const) {
        const client = yield* initialize(fixture.post, protocolVersion, {
          capabilities: { elicitation: {} }
        })
        assert.notProperty(client.initializeResult.capabilities, "elicitation")
        assert.strictEqual(
          textResult(yield* client.request("tools/call", { name: "capability" })),
          "{}"
        )
      }
    }))

  it.effect("should preserve initialize metadata when creating the public request context", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18"] as const) {
        const response = yield* fixture.post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "metadata-client", version: "1.0.0" },
            _meta: { progressToken: protocolVersion }
          }
        })
        const sessionId = response.headers.get("Mcp-Session-Id")
        assert.isNotNull(sessionId)
        const toolResponse = yield* fixture.post({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "initialize-metadata" }
        }, {
          "Mcp-Protocol-Version": protocolVersion,
          "Mcp-Session-Id": sessionId
        })
        const body = yield* Effect.promise<unknown>(() => toolResponse.json()).pipe(
          Effect.flatMap(decodeJsonRpcResponse)
        )
        assert.strictEqual(textResult(body), JSON.stringify({ progressToken: protocolVersion }))
      }
    }))

  it.effect("should reject elicitation before transport when the protocol predates v2025-06-18", () =>
    Effect.gen(function*() {
      let sends = 0
      const reverseProtocol = yield* RpcClient.Protocol.make(() =>
        Effect.succeed({
          send: () =>
            Effect.sync(() => {
              sends++
            }),
          supportsAck: true,
          supportsTransferables: false,
          codecFor: Schema.toCodecJson as RpcSerialization.CodecFor
        })
      )
      for (
        const protocol of [
          McpProtocol.v2024_11_05,
          McpProtocol.v2025_03_26
        ]
      ) {
        const client = yield* protocol.makeReverseClient({
          protocolVersion: protocol.protocolVersion,
          clientCapabilities: { elicitation: {} },
          clientInfo: { name: "test", version: "1.0.0" }
        }).pipe(
          Effect.provideService(RpcClient.Protocol, reverseProtocol)
        )
        const error = yield* client.elicit({
          message: "test",
          requestedSchema: {
            type: "object",
            properties: {}
          }
        }).pipe(Effect.flip)
        assert.instanceOf(error, McpSchema.McpReverseOperationUnsupported)
      }
      assert.strictEqual(sends, 0)
    }).pipe(Effect.scoped))

  it.effect("should omit June fields when projecting a March tool descriptor", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const client = yield* initialize(fixture.post, "2025-03-26")
      const shared = listedTools(yield* client.request("tools/list"))
        .find((tool) => tool.name === "shared")

      assert.isDefined(shared)
      assert.deepStrictEqual(shared.inputSchema, { type: "object" })
      assert.deepStrictEqual(shared.annotations, {
        title: "Shared tool title",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      })
      assert.notProperty(shared, "title")
      assert.notProperty(shared, "outputSchema")
      assert.notProperty(shared, "_meta")
    }))

  it.effect("should prefer the canonical title when projecting March annotations", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()
      const marchClient = yield* initialize(fixture.post, "2025-03-26")
      const tool = listedTools(yield* marchClient.request("tools/list"))
        .find((tool) => tool.name === "title-precedence")

      assert.isDefined(tool)
      assert.deepStrictEqual(tool.annotations, {
        title: "Canonical title",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      })
    }))

  it.effect("should return a typed protocol error when a result cannot be projected", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()
      const client = yield* initialize(fixture.post, "2024-11-05")
      const error = errorOf(
        yield* client.request("tools/call", {
          name: "projection-mismatch"
        })
      )

      assert.strictEqual(error.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
      assert.match(error.message, /audio tool content is not supported by MCP 2024-11-05/)
      assert.strictEqual(fixture.state.projectionMismatchInvocations, 1)
    }))

  it.effect("should route each session through its negotiated RPC group when revisions coexist", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const oldClient = yield* initialize(fixture.post, "2024-11-05")
      const currentClient = yield* initialize(fixture.post, "2025-06-18")

      const oldShared = listedTools(yield* oldClient.request("tools/list"))
        .find((tool) => tool.name === "shared")
      const currentShared = listedTools(yield* currentClient.request("tools/list"))
        .find((tool) => tool.name === "shared")

      assert.isDefined(oldShared)
      assert.isDefined(currentShared)
      assert.notProperty(oldShared, "title")
      assert.strictEqual(currentShared.title, "Shared tool title")
    }))

  for (const protocolVersion of ["2025-06-18", "2024-11-05"] as const) {
    it.effect(`should expose the negotiated client profile when serving ${protocolVersion} requests`, () =>
      Effect.gen(function*() {
        const fixture = yield* makeFixture()
        const advertisedCapabilities = {
          roots: { listChanged: true },
          sampling: {}
        }
        const allowed = yield* initialize(fixture.post, protocolVersion, {
          capabilities: advertisedCapabilities,
          clientInfo: { name: "allowed-client", version: "2.0.0" }
        })
        const denied = yield* initialize(fixture.post, protocolVersion, {
          capabilities: {},
          clientInfo: { name: "other-client", version: "1.0.0" }
        })

        const allowedTools = listedTools(yield* allowed.request("tools/list"))
        const deniedTools = listedTools(yield* denied.request("tools/list"))
        assert.isTrue(allowedTools.some((tool) => tool.name === "capability-gated"))
        assert.isFalse(deniedTools.some((tool) => tool.name === "capability-gated"))

        const observed = JSON.parse(textResult(
          yield* allowed.request("tools/call", { name: "capability" })
        ))
        assert.deepStrictEqual(observed, advertisedCapabilities)
        assert.strictEqual(fixture.state.capabilityInvocations, 1)
      }))
  }

  it.effect("should project the exact descriptor shape when listing tools for each revision", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const currentClient = yield* initialize(fixture.post, "2025-06-18")
      const oldClient = yield* initialize(fixture.post, "2024-11-05")

      const currentTools = listedTools(yield* currentClient.request("tools/list"))
      const oldTools = listedTools(yield* oldClient.request("tools/list"))
      const currentShared = currentTools.find((tool) => tool.name === "shared")
      const oldShared = oldTools.find((tool) => tool.name === "shared")

      assert.isDefined(currentShared)
      assert.isDefined(oldShared)
      assert.strictEqual(currentShared.title, "Shared tool title")
      assert.deepStrictEqual(currentShared.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      })
      assert.notProperty(oldShared, "title")
      assert.notProperty(oldShared, "annotations")
      assert.notProperty(oldShared, "_meta")
      assert.notProperty(oldShared, "outputSchema")
    }))

  it.effect("should project outputSchema only when the protocol revision supports it", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()
      const currentClient = yield* initialize(fixture.post, "2025-06-18")
      const oldClient = yield* initialize(fixture.post, "2024-11-05")
      const currentTools = listedTools(yield* currentClient.request("tools/list"))
      const oldTools = listedTools(yield* oldClient.request("tools/list"))
      const currentSchemaOutput = currentTools.find((tool) => tool.name === "schema-output")
      const oldSchemaOutput = oldTools.find((tool) => tool.name === "schema-output")
      assert.isDefined(currentSchemaOutput)
      assert.isDefined(oldSchemaOutput)
      assert.deepStrictEqual(currentSchemaOutput.outputSchema, {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        required: ["value"]
      })
      assert.deepStrictEqual(currentSchemaOutput._meta, { descriptor: "fixture" })
      assert.notProperty(oldSchemaOutput, "outputSchema")
      assert.notProperty(oldSchemaOutput, "_meta")
    }))

  it.effect("should encode binary content for every revision that can represent it", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()
      for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18"] as const) {
        const client = yield* initialize(fixture.post, protocolVersion)
        const image = resultOf(yield* client.request("tools/call", { name: "image" }))
        assert.deepStrictEqual(image.content, [{
          type: "image",
          data: "AQID",
          mimeType: "image/png"
        }])

        const embedded = resultOf(
          yield* client.request("tools/call", { name: "binary-resource" })
        )
        assert.deepStrictEqual(embedded.content, [{
          type: "resource",
          resource: {
            uri: "file:///binary.dat",
            mimeType: "application/octet-stream",
            blob: "BwgJ"
          }
        }])
      }

      for (const protocolVersion of ["2025-03-26", "2025-06-18"] as const) {
        const client = yield* initialize(fixture.post, protocolVersion)
        const audio = resultOf(yield* client.request("tools/call", { name: "audio" }))
        assert.deepStrictEqual(audio.content, [{
          type: "audio",
          data: "BAUG",
          mimeType: "audio/wav"
        }])
      }
    }))

  it.effect("should project structured content according to the negotiated revision", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()
      for (const protocolVersion of ["2024-11-05", "2025-03-26"] as const) {
        const client = yield* initialize(fixture.post, protocolVersion)
        const objectResult = resultOf(
          yield* client.request("tools/call", { name: "structured-object" })
        )
        const scalarResult = resultOf(
          yield* client.request("tools/call", { name: "structured-scalar" })
        )
        assert.notProperty(objectResult, "structuredContent")
        assert.notProperty(scalarResult, "structuredContent")
      }

      const currentClient = yield* initialize(fixture.post, "2025-06-18")
      const objectResult = resultOf(
        yield* currentClient.request("tools/call", { name: "structured-object" })
      )
      assert.deepStrictEqual(objectResult.structuredContent, { value: "fixture" })

      const scalarError = errorOf(
        yield* currentClient.request("tools/call", { name: "structured-scalar" })
      )
      assert.strictEqual(scalarError.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
      assert.match(scalarError.message, /non-object structured tool content is not supported by MCP 2025-06-18/)
    }))

  it.effect("should preserve only supported metadata when projecting embedded resource content", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()

      for (const protocolVersion of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const) {
        const client = yield* initialize(fixture.post, protocolVersion)
        const result = resultOf(
          yield* client.request("tools/call", { name: "annotated-resource" })
        )
        const [content] = Schema.decodeUnknownSync(
          Schema.NonEmptyArray(Schema.Record(Schema.String, Schema.Unknown))
        )(result.content)
        assert.deepStrictEqual(result._meta, { result: "fixture" })
        const resource = Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.Unknown)
        )(content.resource)
        assert.deepStrictEqual(
          content.annotations,
          protocolVersion === "2025-11-25"
            ? {
              audience: ["assistant"],
              priority: 0.75,
              lastModified: "2026-08-13T00:00:00Z"
            }
            : {
              audience: ["assistant"],
              priority: 0.75
            }
        )
        assert.strictEqual(resource.uri, "file:///annotated.txt")
        assert.strictEqual(resource.mimeType, "text/plain")
        assert.strictEqual(resource.text, "annotated")
        if (protocolVersion === "2025-11-25" || protocolVersion === "2025-06-18") {
          assert.deepStrictEqual(resource._meta, { source: "fixture" })
          assert.deepStrictEqual(content._meta, { content: "fixture" })
        } else {
          assert.notProperty(resource, "_meta")
          assert.notProperty(content, "_meta")
        }
      }
    }))

  it.effect("should preserve result metadata while omitting June-only metadata for older revisions", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()
      for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18"] as const) {
        const client = yield* initialize(fixture.post, protocolVersion)
        const resources = resultOf(yield* client.request("resources/list"))
        const resource = (resources.resources as Array<Record<string, unknown>>).find(
          (_) => _.uri === "file:///metadata.txt"
        )!
        const read = resultOf(
          yield* client.request("resources/read", { uri: "file:///metadata.txt" })
        )
        const prompts = resultOf(yield* client.request("prompts/list"))
        const promptDescriptor = (prompts.prompts as Array<Record<string, unknown>>).find(
          (_) => _.name === "metadata-prompt"
        )!
        const prompt = resultOf(
          yield* client.request("prompts/get", { name: "metadata-prompt" })
        )
        const completion = resultOf(
          yield* client.request("completion/complete", {
            ref: { type: "ref/prompt", name: "metadata-prompt" },
            argument: { name: "value", value: "m" }
          })
        )

        assert.deepStrictEqual(read._meta, { result: "fixture" })
        assert.deepStrictEqual(prompt._meta, { result: "fixture" })
        assert.deepStrictEqual(completion._meta, { result: "fixture" })
        const content = (prompt.messages as Array<Record<string, any>>)[0].content
        if (protocolVersion === "2025-06-18") {
          assert.deepStrictEqual(resource._meta, { descriptor: "fixture" })
          assert.deepStrictEqual(promptDescriptor._meta, { descriptor: "fixture" })
          assert.deepStrictEqual(content._meta, { content: "fixture" })
        } else {
          assert.notProperty(resource, "_meta")
          assert.notProperty(promptDescriptor, "_meta")
          assert.notProperty(content, "_meta")
        }
      }
    }))

  it.effect("should expose implementation metadata and descriptor icons when supported by the protocol", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()
      const november = yield* initialize(fixture.post, "2025-11-25")
      const june = yield* initialize(fixture.post, "2025-06-18")

      assert.deepStrictEqual(november.initializeResult.serverInfo, {
        name: "LowLevelProtocolAdapterServer",
        version: "1.0.0",
        description: "Low-level protocol adapter fixture",
        websiteUrl: "https://example.com/low-level-mcp",
        icons: [{
          src: "https://example.com/server.svg",
          mimeType: "image/svg+xml",
          sizes: ["48x48", "any"],
          theme: "dark"
        }]
      })
      assert.deepStrictEqual(june.initializeResult.serverInfo, {
        name: "LowLevelProtocolAdapterServer",
        version: "1.0.0"
      })

      const resources = resultOf(yield* november.request("resources/list"))
      const resource = (resources.resources as Array<Record<string, unknown>>).find(
        (_) => _.uri === "file:///metadata.txt"
      )
      assert.isDefined(resource)
      assert.deepStrictEqual(resource.icons, [{ src: "https://example.com/resource.svg" }])

      const prompts = resultOf(yield* november.request("prompts/list"))
      const prompt = (prompts.prompts as Array<Record<string, unknown>>).find((_) => _.name === "metadata-prompt")
      assert.isDefined(prompt)
      assert.deepStrictEqual(prompt.icons, [{ src: "https://example.com/prompt.svg" }])

      const tool = listedTools(yield* november.request("tools/list")).find((_) => _.name === "title-precedence")
      assert.isDefined(tool)
      assert.deepStrictEqual(tool.icons, [{ src: "https://example.com/tool.svg" }])
    }))

  it.effect("should hide and reject a tool when its declaration is incompatible with the revision", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const currentClient = yield* initialize(fixture.post, "2025-06-18")
      const oldClient = yield* initialize(fixture.post, "2024-11-05")

      const currentTools = listedTools(yield* currentClient.request("tools/list"))
      const oldTools = listedTools(yield* oldClient.request("tools/list"))

      assert.isTrue(currentTools.some((tool) => tool.name === "structured-only"))
      assert.isFalse(oldTools.some((tool) => tool.name === "structured-only"))

      const oldCall = yield* oldClient.request("tools/call", {
        name: "structured-only",
        arguments: {}
      })
      assert.property(oldCall, "error")
      assert.strictEqual(fixture.state.structuredInvocations, 0)
    }))

  it.effect("should reject after invocation when a tool result cannot be projected", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()
      const currentClient = yield* initialize(fixture.post, "2025-06-18")
      const oldClient = yield* initialize(fixture.post, "2024-11-05")

      const currentTools = listedTools(yield* currentClient.request("tools/list"))
      const oldTools = listedTools(yield* oldClient.request("tools/list"))
      assert.isTrue(currentTools.some((tool) => tool.name === "audio"))
      assert.isTrue(currentTools.some((tool) => tool.name === "resource-link"))
      assert.isTrue(oldTools.some((tool) => tool.name === "audio"))
      assert.isTrue(oldTools.some((tool) => tool.name === "resource-link"))

      assert.property(
        yield* oldClient.request("tools/call", { name: "audio" }),
        "error"
      )
      assert.property(
        yield* oldClient.request("tools/call", { name: "resource-link" }),
        "error"
      )
      assert.strictEqual(fixture.state.audioInvocations, 1)
      assert.strictEqual(fixture.state.resourceLinkInvocations, 1)
    }))

  it.effect("should return a typed failure when structured tool content is not valid JSON", () =>
    Effect.gen(function*() {
      const server = yield* McpServer.McpServer.make
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: "invalid-structured-content",
          inputSchema: {
            type: "object",
            properties: {}
          }
        }),
        annotations: Context.empty(),
        handle: () =>
          Effect.succeed({
            content: [{ type: "text", text: "invalid" }],
            structuredContent: Symbol("not-json")
          } as unknown as McpSchema.CallToolResult)
      })

      const error = yield* server.callTool({
        name: "invalid-structured-content",
        arguments: {}
      }).pipe(
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: {},
            clientInfo: {
              name: "direct-client",
              version: "1.0.0"
            },
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: {
                name: "direct-client",
                version: "1.0.0"
              }
            },
            getClient: Effect.die("not used")
          })
        ),
        Effect.flip
      )

      assert.instanceOf(error, McpSchema.InvalidParams)
      assert.strictEqual(
        error.message,
        "Tool 'invalid-structured-content' returned structured content that is not valid JSON"
      )
    }))

  it("should reject a tool schema when inputSchema is not an object", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(McpSchema.Tool)({
        name: "invalid",
        inputSchema: "anything"
      })
    )
  })

  it.effect("should list and invoke the latest tool when a name is registered twice", () =>
    Effect.gen(function*() {
      const fixture = yield* makeLowLevelFixture()
      const currentClient = yield* initialize(fixture.post, "2025-06-18")
      const oldClient = yield* initialize(fixture.post, "2024-11-05")

      for (const client of [currentClient, oldClient]) {
        const duplicates = listedTools(
          yield* client.request("tools/list")
        ).filter((tool) => tool.name === "duplicate")
        assert.lengthOf(duplicates, 1)
        assert.strictEqual(duplicates[0]?.description, "second descriptor")

        const result = resultOf(
          yield* client.request("tools/call", { name: "duplicate" })
        )
        assert.deepStrictEqual(result.content, [{ type: "text", text: "second" }])
      }
      assert.deepStrictEqual(fixture.state.duplicateInvocations, ["second", "second"])
    }))
})
