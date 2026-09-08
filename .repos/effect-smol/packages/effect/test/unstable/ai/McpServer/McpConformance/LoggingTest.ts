import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import type * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import { makeMcpStdioHarness } from "../TestUtils/McpStdioHarness.ts"
import { McpConformance, type McpConformanceLayer } from "./McpConformance.ts"

const levels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const

const setLevel = (level: string) =>
  Effect.gen(function*() {
    const test = yield* McpConformance
    const initialized = yield* test.initialize({ server: "features" })
    yield* test.notifyInitialized(initialized)
    const response = yield* test.send(initialized, {
      jsonrpc: "2.0",
      id: 2,
      method: "logging/setLevel",
      params: { level }
    })
    return { initialized, response, test }
  })

export const suite = (protocol: McpProtocol.ProtocolAdapter, layer: McpConformanceLayer) =>
  it.layer(layer)(`Mcp Conformance (${protocol.protocolVersion})`, (it) => {
    describe("Logging", () => {
      // Logging has the same protocol surface in all three dated specifications.
      describe("Capabilities", () => {
        it.effect("MUST advertise logging when log notifications are supported", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize({ server: "features" })
            assert.property(initialized.message.result.capabilities, "logging")
          }))
      })

      describe("Setting Log Level", () => {
        it.effect("MUST accept every specified log level", () =>
          Effect.forEach(levels, (level) =>
            Effect.gen(function*() {
              const { response, test } = yield* setLevel(level)
              const result = yield* test.decodeResult(response)
              assert.deepStrictEqual(result.result, {})
            }), { concurrency: 1 }))
        it.effect("MUST reject an unknown log level", () =>
          Effect.gen(function*() {
            const { response, test } = yield* setLevel("verbose")
            const error = yield* test.decodeError(response)
            assert.strictEqual(error.error.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
          }))
        it.effect("SHOULD update the minimum level for subsequent operations", () =>
          Effect.gen(function*() {
            const { initialized, test } = yield* setLevel("debug")
            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "LogLevelTool", arguments: {} }
            })
            const result = yield* test.decodeResult(response).pipe(
              Effect.flatMap((message) => Schema.decodeUnknownEffect(McpSchema.CallToolResult)(message.result))
            )
            assert.deepStrictEqual(result.content, [{ type: "text", text: JSON.stringify("Debug") }])
          }))
        it.effect("SHOULD send notifications at the selected level and higher", () =>
          Effect.gen(function*() {
            const fixture = yield* makeMcpStdioHarness(protocol)
            yield* fixture.initialize()
            const response = yield* fixture.sendRequest("logging/setLevel", { level: "warning" }, 2)
            assert.deepStrictEqual(response.result, {})

            yield* fixture.server.notifications["notifications/message"]({
              level: "warning",
              logger: "conformance",
              data: "at-threshold"
            })
            const notification = yield* fixture.awaitOutboundMethod("notifications/message")
            const payload = yield* Schema.decodeUnknownEffect(
              McpSchema.LoggingMessageNotification.payloadSchema
            )(notification.params)
            assert.deepStrictEqual(payload, {
              level: "warning",
              logger: "conformance",
              data: "at-threshold"
            })
          }))
        it.effect("MUST not send notifications below the selected level", () =>
          Effect.gen(function*() {
            const fixture = yield* makeMcpStdioHarness(protocol)
            yield* fixture.initialize()
            const response = yield* fixture.sendRequest("logging/setLevel", { level: "warning" }, 2)
            assert.deepStrictEqual(response.result, {})

            yield* fixture.server.notifications["notifications/message"]({
              level: "debug",
              logger: "conformance",
              data: "below-threshold"
            })
            yield* fixture.server.notifications["notifications/message"]({
              level: "warning",
              logger: "conformance",
              data: "allowed-sentinel"
            })
            const notification = yield* fixture.awaitOutboundMethod("notifications/message")
            assert.deepNestedInclude(notification, {
              params: {
                level: "warning",
                logger: "conformance",
                data: "allowed-sentinel"
              }
            })
          }))
      })

      describe("Log Message Notifications", () => {
        it.effect("SCHEMA preserves the log level, logger name, and data", () =>
          Effect.gen(function*() {
            const payload = yield* Schema.decodeUnknownEffect(
              McpSchema.LoggingMessageNotification.payloadSchema
            )({
              level: "warning",
              logger: "database",
              data: {
                message: "slow query",
                durationMs: 120
              }
            })

            assert.deepStrictEqual(payload, {
              level: "warning",
              logger: "database",
              data: {
                message: "slow query",
                durationMs: 120
              }
            })
          }))
        it.effect("MUST allow arbitrary JSON-compatible log data", () =>
          Effect.forEach([
            "message",
            42,
            true,
            null,
            ["one", { nested: "two" }],
            { nested: { value: 1 } }
          ], (data) =>
            Schema.decodeUnknownEffect(
              McpSchema.LoggingMessageNotification.payloadSchema
            )({
              level: "info",
              data
            }).pipe(
              Effect.map((payload) => assert.deepStrictEqual(payload.data, data))
            )))
        it.effect("MUST emit log messages as notifications without an identifier", () =>
          Effect.gen(function*() {
            const fixture = yield* makeMcpStdioHarness(protocol)
            yield* fixture.initialize()
            yield* fixture.server.notifications["notifications/message"]({
              level: "warning",
              logger: "database",
              data: { message: "slow query" }
            })

            const notification = yield* fixture.awaitOutboundMethod("notifications/message")
            assert.strictEqual(notification.jsonrpc, "2.0")
            assert.strictEqual(notification.method, "notifications/message")
            yield* Schema.decodeUnknownEffect(
              McpSchema.LoggingMessageNotification.payloadSchema
            )(notification.params)
            assert.notProperty(notification, "id")
            assert.notProperty(notification, "result")
          }))
        it.effect("SCENARIO does not corrupt the stdio protocol stream with log output", () =>
          Effect.gen(function*() {
            const fixture = yield* makeMcpStdioHarness(protocol)
            yield* fixture.initialize()
            yield* fixture.takeFrame
            yield* fixture.server.notifications["notifications/message"]({
              level: "info",
              logger: "conformance",
              data: "stdio-integrity-diagnostic"
            })
            const ping = yield* fixture.sendRequest("ping", {}, 2).pipe(Effect.forkChild)

            const notificationFrame = yield* fixture.takeFrame
            const responseFrame = yield* fixture.takeFrame
            assert.isObject(notificationFrame)
            assert.isObject(responseFrame)
            assert.deepInclude(notificationFrame, {
              method: "notifications/message"
            })
            assert.deepNestedInclude(notificationFrame, {
              "params.data": "stdio-integrity-diagnostic"
            })
            assert.deepInclude(responseFrame, { jsonrpc: "2.0", id: 2, result: {} })
            yield* Fiber.join(ping)
          }))
      })
    })
  })
