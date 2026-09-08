import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import { makeMcpStdioHarness } from "../TestUtils/McpStdioHarness.ts"
import { McpConformance, type McpConformanceLayer } from "./McpConformance.ts"

export const suite = (protocol: McpProtocol.ProtocolAdapter, layer: McpConformanceLayer) =>
  it.layer(layer)(`Mcp Conformance (${protocol.protocolVersion})`, (it) => {
    describe("Utilities", () => {
      describe("Ping", () => {
        // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping
        it.effect("MUST respond to a client ping with an empty result", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()
            yield* test.notifyInitialized(initialized)

            const response = yield* test.ping(initialized, { id: 42 })
            const message = yield* test.decodeResult(response)

            assert.strictEqual(response.status, 200)
            assert.strictEqual(message.id, 42)
            assert.deepStrictEqual(message.result, {})
          }))
      })

      describe("Cancellation", () => {
        // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation
        it.effect("MUST not send a response to a cancellation notification", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()
            yield* test.notifyInitialized(initialized)

            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: {
                requestId: "unknown-request",
                reason: "No longer needed"
              }
            })

            assert.strictEqual(response.status, 202)
            assert.strictEqual(yield* Effect.promise(() => response.text()), "")
          }))
        it.effect("SHOULD stop work and suppress the response after cancellation", () =>
          Effect.gen(function*() {
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const interrupted = yield* Deferred.make<void>()
            yield* Effect.addFinalizer(() => Deferred.succeed(release, void 0))
            const fixture = yield* makeMcpStdioHarness(protocol)
            const cancelledRequestId = "cancelled-tool-call"
            const pingRequestId = "post-cancellation-ping"

            yield* fixture.server.addTool({
              tool: new McpSchema.Tool({
                name: "GatedTool",
                inputSchema: { type: "object", properties: {} }
              }),
              annotations: Context.empty(),
              handle: () =>
                Deferred.succeed(entered, void 0).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, void 0)),
                  Effect.as(
                    new McpSchema.CallToolResult({
                      content: [{ type: "text", text: "released" }]
                    })
                  )
                )
            })

            yield* fixture.initialize()
            yield* fixture.sendRaw({
              jsonrpc: "2.0",
              id: cancelledRequestId,
              method: "tools/call",
              params: { name: "GatedTool", arguments: {} }
            })
            yield* Deferred.await(entered)
            yield* fixture.sendNotification("notifications/cancelled", {
              requestId: cancelledRequestId,
              reason: "No longer needed"
            })
            yield* Deferred.await(interrupted)
            yield* fixture.sendRaw({
              jsonrpc: "2.0",
              id: pingRequestId,
              method: "ping"
            })

            while (true) {
              const message = yield* fixture.takeMessage
              assert.notStrictEqual(message.id, cancelledRequestId)
              if (message.id === pingRequestId) {
                assert.deepStrictEqual(message.result, {})
                break
              }
            }
          }))
        it.effect("SHOULD ignore cancellation for an unknown request identifier", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()
            yield* test.notifyInitialized(initialized)

            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: 999 }
            })

            assert.strictEqual(response.status, 202)
            assert.strictEqual(yield* Effect.promise(() => response.text()), "")
          }))
        it.effect("SHOULD allow a later request to reuse an unknown cancelled identifier", () =>
          Effect.gen(function*() {
            const fixture = yield* makeMcpStdioHarness(protocol)
            yield* fixture.initialize()
            yield* fixture.sendNotification("notifications/cancelled", {
              requestId: "reused-id"
            })

            const reused = yield* fixture.sendRequest("ping", undefined, "reused-id").pipe(Effect.forkChild)
            yield* Effect.yieldNow
            const control = yield* fixture.sendRequest("ping", undefined, "control-id")
            assert.deepStrictEqual(control.result, {})
            yield* Effect.yieldNow

            const reusedExit = reused.pollUnsafe()
            assert(reusedExit !== undefined && Exit.isSuccess(reusedExit))
            assert.deepStrictEqual(reusedExit.value.result, {})
          }))
        it.effect("SHOULD ignore cancellation for an already completed request identifier", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()
            yield* test.notifyInitialized(initialized)
            yield* test.ping(initialized, { id: 11 })

            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: 11 }
            })

            assert.strictEqual(response.status, 202)
            assert.strictEqual(yield* Effect.promise(() => response.text()), "")
          }))
      })

      describe("Progress", () => {
        // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress
        // NOTE: Smoke test only. The client capability accepts this one-way notification,
        // but McpServer does not expose an observer for its decoded payload.
        it.effect("MUST accept string progress tokens", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()
            yield* test.notifyInitialized(initialized)

            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: {
                progressToken: "task-1",
                progress: 1
              }
            })

            assert.strictEqual(response.status, 202)
            assert.strictEqual(yield* Effect.promise(() => response.text()), "")
          }))
        // NOTE: Smoke test only. The client capability accepts this one-way notification,
        // but McpServer does not expose an observer for its decoded payload.
        it.effect("MUST accept numeric progress tokens", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()
            yield* test.notifyInitialized(initialized)

            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: {
                progressToken: 12,
                progress: 1
              }
            })

            assert.strictEqual(response.status, 202)
            assert.strictEqual(yield* Effect.promise(() => response.text()), "")
          }))
        // NOTE: Smoke test only. The client capability accepts this one-way notification,
        // but McpServer does not expose an observer for its decoded payload.
        it.effect("SCHEMA accepts the optional total", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()
            yield* test.notifyInitialized(initialized)

            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: {
                progressToken: "task-with-total",
                progress: 1,
                total: 2
              }
            })

            assert.strictEqual(response.status, 202)
            assert.strictEqual(yield* Effect.promise(() => response.text()), "")
          }))
      })
    })
  })
