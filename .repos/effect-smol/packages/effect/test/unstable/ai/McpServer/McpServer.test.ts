import { assert, describe, it } from "@effect/vitest"
import { assertTrue, strictEqual } from "@effect/vitest/utils"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Sink from "effect/Sink"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as AiError from "effect/unstable/ai/AiError"
import * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import * as McpServer from "effect/unstable/ai/McpServer"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { RpcSerialization } from "effect/unstable/rpc"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type * as RpcMessage from "effect/unstable/rpc/RpcMessage"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import { makeHttpHarness } from "./TestUtils/McpHttpHarness.ts"
import { makeServerLayer } from "./TestUtils/McpServerLayer.ts"

const OptionalStringTool = Tool.make("OptionalStringTool", {
  parameters: Schema.Struct({ signature: Schema.optional(Schema.String) }),
  success: Schema.String
})

const PublicFailureTool = Tool.make("PublicFailureTool", {
  success: Schema.String,
  failure: Schema.ErrorInstance()
})

const InternalAiErrorTool = Tool.make("InternalAiErrorTool", {
  success: Schema.String
})

const DefectTool = Tool.make("DefectTool", {
  success: Schema.String
})

const UntypedTool = Tool.make("UntypedTool")

const StructuredResultTool = Tool.make("StructuredResultTool", {
  success: Schema.Struct({ answer: Schema.String })
})

const AnnotatedVoidTool = Tool.make("AnnotatedVoidTool", {
  success: Schema.Void.annotate({ description: "No output" })
})

const TestToolkit = Toolkit.make(
  OptionalStringTool,
  PublicFailureTool,
  InternalAiErrorTool,
  DefectTool,
  UntypedTool,
  StructuredResultTool,
  AnnotatedVoidTool
)
type TestToolkitHandlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof TestToolkit>>

const testToolkitHandlers = TestToolkit.of({
  OptionalStringTool: ({ signature }) => Effect.succeed(signature ?? "omitted"),
  PublicFailureTool: () => Effect.fail(new Error("Public failure")),
  InternalAiErrorTool: () => Effect.fail(new AiError.RateLimitError({})),
  DefectTool: () => Effect.die("private defect details"),
  UntypedTool: () => Effect.void,
  StructuredResultTool: () => Effect.succeed({ answer: "result" }),
  AnnotatedVoidTool: () => Effect.void
})

const INTERNAL_TOOL_ERROR_MESSAGE = "Tool execution failed due to an internal server error."

const TestServerLayer = makeServerLayer({ name: "TestServer" })

const LatestProtocolServerLayer = makeServerLayer({ name: "TestServer", protocols: [McpProtocol.v2025_11_25] })

const initializePayload = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: {
    name: "TestClient",
    version: "1.0.0"
  }
}

const pingBody = {
  jsonrpc: "2.0",
  method: "ping",
  params: {},
  id: 0
}

const directClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: initializePayload.clientInfo,
  initializePayload,
  getClient: Effect.die("not used")
})

const makeTestClientWith = Effect.fnUntraced(function*<A, E>(
  serverLayer: Layer.Layer<A, E, HttpRouter.HttpRouter>,
  options?: {
    readonly routerLayer?: Layer.Layer<never, never, HttpRouter.HttpRouter> | undefined
  } | undefined
) {
  const harness = yield* makeHttpHarness(serverLayer, options)

  const clientLayer = RpcClient.layerProtocolHttp({
    url: "http://localhost/mcp",
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader("accept", "application/json, text/event-stream")
    )
  }).pipe(
    Layer.provideMerge([FetchHttpClient.layer, RpcSerialization.layerJsonRpc()]),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, harness.fetch))
  )
  const client = yield* RpcClient.make(McpSchema.ClientRpcs).pipe(
    Effect.provide(clientLayer)
  )

  const httpClient = yield* HttpClient.HttpClient.pipe(
    Effect.provide(clientLayer)
  )

  return { client, responses: harness.responses, httpClient }
})

const makeTestClient = makeTestClientWith(TestServerLayer)

const makeRouterTestClient = (
  router: Layer.Layer<never, never, HttpRouter.HttpRouter>
) => makeTestClientWith(TestServerLayer, { routerLayer: router })

const makeToolkitTestClient = Effect.fnUntraced(function*(handlers: TestToolkitHandlers = testToolkitHandlers) {
  const serverLayer = McpServer.toolkit(TestToolkit).pipe(
    Layer.provideMerge(TestToolkit.toLayer(handlers)),
    Layer.provide(TestServerLayer)
  )
  const { client } = yield* makeTestClientWith(serverLayer)
  yield* client.initialize({
    protocolVersion: "9999-01-01",
    capabilities: {},
    clientInfo: {
      name: "TestClient",
      version: "1.0.0"
    }
  })
  return client
})

const toolResultText = (result: McpSchema.CallToolResult): string => {
  const content = result.content[0]
  assertTrue(content?.type === "text", "Expected text tool-result content")
  return content.text
}

describe("McpServer", () => {
  describe("direct service", () => {
    it.effect("should fail when a resource URI is unknown", () =>
      Effect.gen(function*() {
        const server = yield* McpServer.McpServer.make

        const error = yield* server.findResource("file:///unknown").pipe(
          Effect.provideService(McpSchema.McpServerClient, directClient),
          Effect.flip
        )

        assertTrue(error instanceof McpSchema.InvalidParams)
        assert.strictEqual(error.message, "Resource 'file:///unknown' not found")
      }))

    it.effect("should preserve a registered resource handler's typed failure", () =>
      Effect.gen(function*() {
        const server = yield* McpServer.McpServer.make
        const failure = new McpSchema.InternalError({ message: "resource failed" })
        yield* server.addResource({
          resource: new McpSchema.Resource({
            uri: "file:///failure",
            name: "failure"
          }),
          annotations: Context.empty(),
          handle: Effect.fail(failure)
        })

        const error = yield* server.findResource("file:///failure").pipe(
          Effect.provideService(McpSchema.McpServerClient, directClient),
          Effect.flip
        )

        assert.strictEqual(error, failure)
      }))

    it.effect("should pass undefined to a low-level tool handler when arguments are omitted", () =>
      Effect.gen(function*() {
        const server = yield* McpServer.McpServer.make
        let received: unknown = "not called"
        yield* server.addTool({
          tool: new McpSchema.Tool({
            name: "arguments-omitted",
            inputSchema: {
              type: "object",
              properties: {}
            }
          }),
          annotations: Context.empty(),
          handle: (payload) => {
            received = payload
            return Effect.succeed(new McpSchema.CallToolResult({ content: [] }))
          }
        })

        yield* server.callTool({ name: "arguments-omitted" }).pipe(
          Effect.provideService(McpSchema.McpServerClient, directClient)
        )

        assert.isUndefined(received)
      }))
  })

  it.effect("should reject browser Origins by default while accepting Origin-less clients", () =>
    Effect.gen(function*() {
      const harness = yield* makeHttpHarness(TestServerLayer)
      assert.strictEqual(
        (yield* harness.post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: initializePayload
        })).status,
        200
      )
      assert.strictEqual(
        (yield* harness.post({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: initializePayload
        }, { origin: "https://browser.example" })).status,
        403
      )
    }))

  it.effect("should replay the selected protocol header when a session is initialized", () =>
    Effect.gen(function*() {
      const { client, responses } = yield* makeTestClient

      yield* client.initialize({
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "TestClient",
          version: "1.0.0"
        }
      })

      yield* client.ping({})

      strictEqual(responses.length, 2)
      strictEqual(responses[0].headers.get("Mcp-Protocol-Version"), "2025-06-18")
      strictEqual(responses[1].headers.get("Mcp-Protocol-Version"), "2025-06-18")
    }))

  it.effect("should return 400 when a non-initialize request omits the MCP session id", () =>
    Effect.gen(function*() {
      const { httpClient } = yield* makeTestClient

      const response = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", method: "ping", params: {}, id: 0 }),
        httpClient.execute
      )

      strictEqual(response.status, 400)
    }))
  it.effect("negotiates an initialize request from a client on an unsupported protocol version", () =>
    Effect.gen(function*() {
      const { httpClient } = yield* makeTestClientWith(LatestProtocolServerLayer)

      const response = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.setHeader("Mcp-Protocol-Version", "2025-06-18"),
        HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializePayload }),
        httpClient.execute
      )

      strictEqual(response.status, 200)
      strictEqual(response.headers["mcp-protocol-version"], "2025-11-25")
      assertTrue(response.headers["mcp-session-id"] !== undefined)
    }))

  describe("registerToolkit", () => {
    it.effect("lists output schemas only for structured tool results", () =>
      Effect.gen(function*() {
        const client = yield* makeToolkitTestClient()

        const result = yield* client["tools/list"]({})
        const structuredTool = result.tools.find((tool) => tool.name === "StructuredResultTool")
        const scalarTool = result.tools.find((tool) => tool.name === "OptionalStringTool")
        const untypedTool = result.tools.find((tool) => tool.name === "UntypedTool")
        const annotatedVoidTool = result.tools.find((tool) => tool.name === "AnnotatedVoidTool")

        assert.deepStrictEqual(structuredTool?.outputSchema, {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false
        })
        assertTrue(scalarTool !== undefined)
        assert.isFalse("outputSchema" in scalarTool)
        assertTrue(untypedTool !== undefined)
        assert.isFalse("outputSchema" in untypedTool)
        assertTrue(annotatedVoidTool !== undefined)
        assert.isFalse("outputSchema" in annotatedVoidTool)
      }))

    it.effect("returns concise parameter-validation errors without invoking the handler", () =>
      Effect.gen(function*() {
        let handlerInvoked = false
        const client = yield* makeToolkitTestClient(TestToolkit.of({
          ...testToolkitHandlers,
          OptionalStringTool: ({ signature }) => {
            handlerInvoked = true
            return Effect.succeed(signature ?? "omitted")
          }
        }))

        const error = yield* client["tools/call"]({
          name: "OptionalStringTool",
          arguments: { signature: null }
        }).pipe(Effect.flip)

        assert.isFalse(handlerInvoked)
        assert.isTrue("code" in error)
        if ("code" in error) assert.strictEqual(error.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
        assert.match(error.message, /Invalid parameters for tool 'OptionalStringTool'/)
        assert.match(error.message, /Expected string \| undefined/)
        assert.match(error.message, /at \["signature"\]/)
      }))

    it.effect("preserves successful results when optional parameters are omitted", () =>
      Effect.gen(function*() {
        let handlerInvoked = false
        const client = yield* makeToolkitTestClient(TestToolkit.of({
          ...testToolkitHandlers,
          OptionalStringTool: ({ signature }) => {
            handlerInvoked = true
            return Effect.succeed(signature ?? "omitted")
          }
        }))

        const result = yield* client["tools/call"]({
          name: "OptionalStringTool",
          arguments: {}
        })

        assert.isTrue(handlerInvoked)
        assert.deepStrictEqual(
          result,
          new McpSchema.CallToolResult({
            isError: false,
            content: [{ type: "text", text: JSON.stringify("omitted") }]
          })
        )
      }))

    it.effect("keeps void tool results successful", () =>
      Effect.gen(function*() {
        const client = yield* makeToolkitTestClient()

        const result = yield* client["tools/call"]({
          name: "UntypedTool",
          arguments: {}
        })

        assert.deepStrictEqual(
          result,
          new McpSchema.CallToolResult({
            isError: false,
            content: []
          })
        )
      }))

    it.effect("returns schema-validated messages for declared handler failures", () =>
      Effect.gen(function*() {
        const client = yield* makeToolkitTestClient()

        const result = yield* client["tools/call"]({
          name: "PublicFailureTool",
          arguments: {}
        })

        assert.strictEqual(result.isError, true)
        const text = toolResultText(result)
        assert.strictEqual(text, "Public failure")
      }))

    it.effect("returns a generic message for non-validation AiError failures", () =>
      Effect.gen(function*() {
        const client = yield* makeToolkitTestClient()

        const result = yield* client["tools/call"]({
          name: "InternalAiErrorTool",
          arguments: {}
        })

        assert.strictEqual(result.isError, true)
        const text = toolResultText(result)
        assert.strictEqual(text, INTERNAL_TOOL_ERROR_MESSAGE)
      }))

    it.effect("returns a generic message for handler defects", () =>
      Effect.gen(function*() {
        const client = yield* makeToolkitTestClient()

        const result = yield* client["tools/call"]({
          name: "DefectTool",
          arguments: {}
        })

        assert.strictEqual(result.isError, true)
        const text = toolResultText(result)
        assert.strictEqual(text, INTERNAL_TOOL_ERROR_MESSAGE)
      }))

    it.effect("keeps unknown tools as protocol errors", () =>
      Effect.gen(function*() {
        const client = yield* makeToolkitTestClient()

        const error = yield* client["tools/call"]({
          name: "UnknownTool",
          arguments: {}
        }).pipe(Effect.flip)

        assert.isTrue("code" in error)
        if ("code" in error) {
          assert.strictEqual(error.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
          assert.strictEqual(error.message, "Tool 'UnknownTool' not found")
        }
      }))
  })

  it.effect("rejects unsupported HTTP methods without disturbing an initialized session", () =>
    Effect.gen(function*() {
      const { client, httpClient } = yield* makeTestClient

      yield* client.initialize(initializePayload)

      for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD"] as const) {
        const response = yield* HttpClientRequest.make(method)("http://localhost/mcp").pipe(
          httpClient.execute
        )
        strictEqual(response.status, 405)
        strictEqual(response.headers["allow"], "POST")
      }

      yield* client.ping({})
    }))

  it.effect("returns an empty 202 for notifications and responses and remains successful for request POSTs", () =>
    Effect.gen(function*() {
      const { client, httpClient } = yield* makeRouterTestClient(HttpRouter.cors())

      yield* client.initialize(initializePayload)

      const notificationResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {}
        }),
        httpClient.execute
      )
      strictEqual(notificationResponse.status, 202)
      strictEqual(yield* notificationResponse.text, "")
      strictEqual(notificationResponse.headers["content-type"], undefined)
      strictEqual(notificationResponse.headers["access-control-allow-origin"], "*")
      strictEqual(notificationResponse.headers["mcp-protocol-version"], "2025-06-18")

      const responseOnly = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
        httpClient.execute
      )
      strictEqual(responseOnly.status, 202)
      strictEqual(yield* responseOnly.text, "")

      const pingResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe(pingBody),
        httpClient.execute
      )
      strictEqual(pingResponse.status, 200)
      const pingResponseBody = yield* pingResponse.text
      strictEqual(pingResponseBody.length > 0, true)
    }))

  it.effect("drops server notifications from buffered JSON-RPC responses", () =>
    Effect.gen(function*() {
      const serverLayer = Layer.effectDiscard(Effect.gen(function*() {
        const router = yield* HttpRouter.HttpRouter
        const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffect()
        yield* protocol.run((clientId, message) => {
          if (message._tag !== "Request") {
            return Effect.void
          }
          return Effect.gen(function*() {
            yield* protocol.send(clientId, {
              _tag: "Request",
              id: "",
              tag: "notifications/message",
              payload: { level: "info" },
              headers: [],
              isNotification: true
            })
            yield* protocol.send(clientId, {
              _tag: "Exit",
              requestId: message.id,
              exit: { _tag: "Success", value: { ok: true } }
            })
            yield* protocol.end(clientId)
          })
        }).pipe(Effect.forkScoped)
        yield* router.add("POST", "/mcp", () => httpEffect)
      })).pipe(
        Layer.provideMerge(HttpRouter.layer),
        Layer.provide(RpcSerialization.layerJsonRpc())
      )
      const harness = yield* makeHttpHarness(serverLayer)

      const response = yield* harness.post({
        jsonrpc: "2.0",
        method: "ping",
        params: {},
        id: 1
      })

      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true }
      })
    }))

  it.effect("validates supplied protocol versions on POST", () =>
    Effect.gen(function*() {
      const { client, httpClient } = yield* makeRouterTestClient(HttpRouter.cors())

      yield* client.initialize(initializePayload)

      const unsupportedResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe(pingBody),
        HttpClientRequest.setHeader("Mcp-Protocol-Version", "9999-01-01"),
        httpClient.execute
      )
      strictEqual(unsupportedResponse.status, 400)
      strictEqual(yield* unsupportedResponse.text, "")
      strictEqual(unsupportedResponse.headers["access-control-allow-origin"], "*")

      const malformedResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.setHeader("Mcp-Protocol-Version", "9999-01-01"),
        HttpClientRequest.bodyText("{"),
        HttpClientRequest.setHeader("content-type", "application/json"),
        httpClient.execute
      )
      strictEqual(malformedResponse.status, 400)
      strictEqual(yield* malformedResponse.text, "")

      const malformedNoVersionResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyText("{"),
        HttpClientRequest.setHeader("content-type", "application/json"),
        httpClient.execute
      )
      strictEqual(malformedNoVersionResponse.status, 200)
      const malformedNoVersionBody = JSON.parse(yield* malformedNoVersionResponse.text)
      strictEqual(malformedNoVersionBody.id, null)
      strictEqual(malformedNoVersionBody.error.code, McpSchema.PARSE_ERROR_CODE)

      const invalidRequestResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.setHeader("Mcp-Protocol-Version", "9999-01-01"),
        HttpClientRequest.bodyJsonUnsafe({ hello: "world" }),
        httpClient.execute
      )
      strictEqual(invalidRequestResponse.status, 400)
      strictEqual(yield* invalidRequestResponse.text, "")

      const invalidRequestNoVersionResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe({ hello: "world" }),
        httpClient.execute
      )
      strictEqual(invalidRequestNoVersionResponse.status, 200)
      const invalidRequestNoVersionBody = JSON.parse(yield* invalidRequestNoVersionResponse.text)
      strictEqual(invalidRequestNoVersionBody.id, null)
      strictEqual(invalidRequestNoVersionBody.error.code, McpSchema.INVALID_REQUEST_ERROR_CODE)

      const invalidInitializeResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.setHeader("Mcp-Protocol-Version", "9999-01-01"),
        HttpClientRequest.bodyJsonUnsafe({ method: "initialize", id: 7 }),
        httpClient.execute
      )
      strictEqual(invalidInitializeResponse.status, 400)
      strictEqual(yield* invalidInitializeResponse.text, "")

      const responseOnly = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
        HttpClientRequest.setHeader("Mcp-Protocol-Version", "9999-01-01"),
        httpClient.execute
      )
      strictEqual(responseOnly.status, 400)
      strictEqual(yield* responseOnly.text, "")

      const absentVersionResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe(pingBody),
        httpClient.execute
      )
      strictEqual(absentVersionResponse.status, 200)

      for (const protocolVersion of ["2025-03-26", "2024-11-05", "2024-10-07"]) {
        const response = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
          HttpClientRequest.bodyJsonUnsafe(pingBody),
          HttpClientRequest.setHeader("Mcp-Protocol-Version", protocolVersion),
          httpClient.execute
        )
        strictEqual(response.status, 400)
      }

      const declaredVersionResponse = yield* HttpClientRequest.post("http://localhost/mcp").pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe(pingBody),
        HttpClientRequest.setHeader("Mcp-Protocol-Version", "2025-06-18"),
        httpClient.execute
      )
      strictEqual(declaredVersionResponse.status, 200)
    }))
  describe("protocol selection", () => {
    it.effect("should select June when an unsupported version is offered", () =>
      Effect.gen(function*() {
        const { client, responses } = yield* makeTestClient

        const result = yield* client.initialize({
          protocolVersion: "2024-10-07",
          capabilities: {},
          clientInfo: {
            name: "TestClient",
            version: "1.0.0"
          }
        })

        strictEqual(result.protocolVersion, "2025-06-18")
        strictEqual(responses[0].headers.get("Mcp-Protocol-Version"), "2025-06-18")
      }))
  })

  describe("resource subscriptions", () => {
    it.effect("should isolate resource update subscriptions between sessions", () =>
      Effect.gen(function*() {
        const clientIds = new Set([1, 2])
        const client1Outbound = yield* Queue.unbounded<RpcMessage.FromServerEncoded>()
        const client2Outbound = yield* Queue.unbounded<RpcMessage.FromServerEncoded>()
        const disconnects = yield* Queue.unbounded<number>()
        const writeRequest = yield* Deferred.make<
          (clientId: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void>
        >()
        const protocol = yield* RpcServer.Protocol.make((write) =>
          Deferred.succeed(writeRequest, write).pipe(
            Effect.as({
              disconnects,
              send: (clientId, message) =>
                Queue.offer(clientId === 1 ? client1Outbound : client2Outbound, message).pipe(Effect.asVoid),
              end: (_clientId) => Effect.void,
              clientIds: Effect.succeed(clientIds),
              initialMessage: Effect.succeedNone,
              supportsAck: false,
              supportsTransferables: false,
              supportsSpanPropagation: false,
              supportsNotifications: true,
              codecFor: Schema.toCodecJson as RpcSerialization.CodecFor
            })
          )
        )
        const ready = yield* Deferred.make<McpServer.McpServer["Service"]>()
        yield* Effect.gen(function*() {
          const context = yield* Layer.build(
            McpServer.resource({
              uri: "file:///target",
              name: "Target",
              content: Effect.succeed("target")
            }).pipe(
              Layer.provideMerge(
                McpServer.layer({
                  name: "TestServer",
                  version: "1.0.0",
                  protocols: [McpProtocol.v2025_06_18]
                }).pipe(Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)))
              )
            )
          )
          yield* Deferred.succeed(ready, Context.get(context, McpServer.McpServer))
          return yield* Effect.never
        }).pipe(Effect.scoped, Effect.forkScoped)
        const server = yield* Deferred.await(ready)
        const send = yield* Deferred.await(writeRequest)
        const nextResponse = Effect.fnUntraced(function*(clientId: number, requestId: number) {
          while (true) {
            const message = yield* Queue.take(clientId === 1 ? client1Outbound : client2Outbound)
            if (message._tag === "Exit" && message.requestId === requestId) {
              return message
            }
          }
        })
        const nextResourceUpdate = Effect.fnUntraced(function*(clientId: number) {
          while (true) {
            const message = yield* Queue.take(clientId === 1 ? client1Outbound : client2Outbound)
            if (message._tag === "Request" && message.tag === "notifications/resources/updated") {
              return yield* Schema.decodeUnknownEffect(
                McpSchema.ResourceUpdatedNotification.payloadSchema
              )(message.payload)
            }
          }
        })
        const request = Effect.fnUntraced(function*(
          clientId: number,
          id: number,
          method: string,
          payload: unknown,
          isNotification = false
        ) {
          yield* send(clientId, {
            _tag: "Request",
            id,
            tag: method,
            payload,
            headers: [],
            ...(isNotification ? { isNotification: true as const } : {})
          })
          if (!isNotification) {
            yield* nextResponse(clientId, id)
          }
        })
        const initialize = (clientId: number) =>
          request(clientId, clientId, "initialize", initializePayload).pipe(
            Effect.andThen(request(clientId, clientId + 10, "notifications/initialized", {}, true))
          )

        yield* initialize(1)
        yield* initialize(2)
        yield* request(1, 21, "resources/subscribe", { uri: "file:///target" })
        yield* request(2, 22, "resources/subscribe", { uri: "file:///sentinel" })

        yield* server.notifications["notifications/resources/updated"]({ uri: "file:///target" })
        yield* server.notifications["notifications/resources/updated"]({ uri: "file:///sentinel" })

        assert.strictEqual((yield* nextResourceUpdate(1)).uri, "file:///target")
        assert.strictEqual((yield* nextResourceUpdate(2)).uri, "file:///sentinel")
        assert.isTrue(Option.isNone(yield* Queue.poll(client1Outbound)))
        assert.isTrue(Option.isNone(yield* Queue.poll(client2Outbound)))
      }))
  })

  describe("stdio", () => {
    it.effect("should preserve the June wire transcript when requests use stdio", () =>
      Effect.gen(function*() {
        const stdin = yield* Queue.unbounded<Uint8Array>()
        const stdout = yield* Queue.unbounded<string | Uint8Array>()
        const encoder = new TextEncoder()
        const decoder = new TextDecoder()
        const stdioLayer = Stdio.layerTest({
          stdin: Stream.fromQueue(stdin),
          stdout: () => Sink.forEach((chunk) => Queue.offer(stdout, chunk))
        })

        const ready = yield* Deferred.make<void>()
        yield* Effect.gen(function*() {
          yield* Layer.build(
            McpServer.layerStdio({
              name: "TestServer",
              version: "1.0.0",
              protocols: [McpProtocol.v2025_06_18]
            }).pipe(Layer.provide(stdioLayer))
          )
          yield* Deferred.succeed(ready, undefined)
          return yield* Effect.never
        }).pipe(
          Effect.scoped,
          Effect.forkScoped
        )
        yield* Deferred.await(ready)

        const write = (message: unknown) => Queue.offer(stdin, encoder.encode(`${JSON.stringify(message)}\n`))
        const read = Effect.fnUntraced(function*() {
          const chunk = yield* Queue.take(stdout)
          const frame = typeof chunk === "string" ? chunk : decoder.decode(chunk)
          assert.strictEqual(frame.endsWith("\n"), true)
          return JSON.parse(frame)
        })

        yield* write({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: {
              name: "TestClient",
              version: "1.0.0"
            }
          }
        })

        assert.deepStrictEqual(yield* read(), {
          jsonrpc: "2.0",
          id: 0,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {
              completions: {},
              logging: {}
            },
            serverInfo: {
              name: "TestServer",
              version: "1.0.0"
            }
          }
        })

        yield* write({
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
          params: {}
        })

        assert.deepStrictEqual(yield* read(), {
          jsonrpc: "2.0",
          id: 1,
          result: {}
        })
      }))
  })
})
