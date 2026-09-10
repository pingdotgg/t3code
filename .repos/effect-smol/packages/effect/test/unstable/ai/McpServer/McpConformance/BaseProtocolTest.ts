import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import type * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import { makeMcpStdioHarness } from "../TestUtils/McpStdioHarness.ts"
import { McpConformance, type McpConformanceLayer } from "./McpConformance.ts"

export const suite = (protocol: McpProtocol.ProtocolAdapter, layer: McpConformanceLayer) =>
  it.layer(layer)(`Mcp Conformance (${protocol.protocolVersion})`, (it) => {
    describe("Base Protocol", () => {
      // https://modelcontextprotocol.io/specification/2025-06-18/basic
      describe("Messages", () => {
        describe("Requests", () => {
          it.effect("SCHEMA accepts JSON-RPC 2.0 requests with string identifiers", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const response = yield* test.send(initialized, {
                jsonrpc: "2.0",
                id: "ping-1",
                method: "ping"
              })
              const message = yield* test.decodeResult(response)

              assert.strictEqual(message.id, "ping-1")
            }))

          it.effect("SCHEMA accepts JSON-RPC 2.0 requests with numeric identifiers", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const response = yield* test.ping(initialized, { id: 42 })
              const message = yield* test.decodeResult(response)

              assert.strictEqual(message.id, 42)
            }))

          it.effect("MUST reject requests with an invalid JSON-RPC version", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const response = yield* test.send(initialized, {
                jsonrpc: "1.0",
                id: 2,
                method: "ping"
              })
              const message = yield* test.decodeError(response)

              assert.strictEqual(message.id, 2)
              assert.strictEqual(message.error.code, McpSchema.INVALID_REQUEST_ERROR_CODE)
            }))

          it.effect("MUST return method not found for unknown request methods", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const response = yield* test.send(initialized, {
                jsonrpc: "2.0",
                id: 3,
                method: "unknown/method"
              })
              const message = yield* test.decodeError(response)

              assert.strictEqual(message.id, 3)
              assert.strictEqual(message.error.code, McpSchema.METHOD_NOT_FOUND_ERROR_CODE)
            }))
          it.effect("MUST return invalid params for request payloads that do not match the method schema", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const response = yield* test.send(initialized, {
                jsonrpc: "2.0",
                id: 7,
                method: "ping",
                params: "invalid"
              })
              const message = yield* test.decodeError(response)

              assert.strictEqual(message.id, 7)
              assert.strictEqual(message.error.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
            }))

          it.effect("MUST not reply to unknown notifications", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const response = yield* test.send(initialized, {
                jsonrpc: "2.0",
                method: "unknown/method"
              })

              assert.strictEqual(response.status, 202)
              assert.strictEqual(yield* Effect.promise(() => response.text()), "")
            }))

          it.effect("MUST not reply to notifications with invalid params", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const response = yield* test.send(initialized, {
                jsonrpc: "2.0",
                method: "ping",
                params: "invalid"
              })

              assert.strictEqual(response.status, 202)
              assert.strictEqual(yield* Effect.promise(() => response.text()), "")
            }))

          it.effect("MUST reject requests with invalid identifiers", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const response = yield* test.send(initialized, {
                jsonrpc: "2.0",
                id: true,
                method: "ping"
              })
              const message = yield* test.decodeError(response)

              assert.strictEqual(message.id, null)
              assert.strictEqual(message.error.code, McpSchema.INVALID_REQUEST_ERROR_CODE)
            }))
        })

        describe("Responses", () => {
          it.effect("MUST return exactly one result response for a successful request", () =>
            Effect.gen(function*() {
              const fixture = yield* makeMcpStdioHarness(protocol)
              yield* fixture.initialize()
              yield* fixture.sendRaw({ jsonrpc: "2.0", id: 4, method: "ping" })
              const message = yield* fixture.takeMessage
              assert.strictEqual(message.id, 4)
              assert.deepStrictEqual(message.result, {})

              const duplicate = yield* fixture.takeMessage.pipe(
                Effect.timeoutOption("1 millis"),
                Effect.forkChild
              )
              yield* TestClock.adjust("1 millis")

              assert.isTrue(Option.isNone(yield* Fiber.join(duplicate)))
            }))

          it.effect("MUST return exactly one error response for a failed request", () =>
            Effect.gen(function*() {
              const fixture = yield* makeMcpStdioHarness(protocol)
              yield* fixture.initialize()
              yield* fixture.sendRaw({
                jsonrpc: "2.0",
                id: 8,
                method: "unknown/method"
              })
              const message = yield* fixture.takeMessage
              assert.strictEqual(message.id, 8)
              assert.property(message, "error")
              assert.notProperty(message, "result")

              const duplicate = yield* fixture.takeMessage.pipe(
                Effect.timeoutOption("1 millis"),
                Effect.forkChild
              )
              yield* TestClock.adjust("1 millis")

              assert.isTrue(Option.isNone(yield* Fiber.join(duplicate)))
            }))
          it.effect("SCHEMA preserves the request identifier in result responses", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const message = yield* test.ping(initialized, { id: 5 }).pipe(
                Effect.flatMap(test.decodeResult)
              )

              assert.strictEqual(message.id, 5)
            }))

          it.effect("SCHEMA preserves the request identifier in error responses", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const message = yield* test.send(initialized, {
                jsonrpc: "2.0",
                id: "unknown-1",
                method: "unknown/method"
              }).pipe(Effect.flatMap(test.decodeError))

              assert.strictEqual(message.id, "unknown-1")
            }))
          it.effect("MUST not include both result and error in a response", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()
              yield* test.notifyInitialized(initialized)

              const response = yield* test.send(initialized, {
                jsonrpc: "2.0",
                id: 9,
                method: "unknown/method"
              })
              const raw = yield* Effect.promise<unknown>(() => response.json()).pipe(
                Effect.map(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown)))
              )

              assert.property(raw, "error")
              assert.notProperty(raw, "result")
            }))
        })

        describe("Notifications", () => {
          it.effect("MUST accept notifications without an identifier and send no response", () =>
            Effect.gen(function*() {
              const test = yield* McpConformance
              const initialized = yield* test.initialize()

              const response = yield* test.send(initialized, test.initializedNotification)

              assert.strictEqual(response.status, 202)
              assert.strictEqual(yield* Effect.promise(() => response.text()), "")
            }))
        })

        it.effect("MUST return a parse error for malformed JSON", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()
            yield* test.notifyInitialized(initialized)

            const response = yield* test.sendText(initialized, "{")
            const message = yield* test.decodeError(response)

            assert.strictEqual(message.id, null)
            assert.strictEqual(message.error.code, McpSchema.PARSE_ERROR_CODE)
          }))

        it.effect("MUST return an invalid request error for malformed JSON-RPC messages", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const initialized = yield* test.initialize()
            yield* test.notifyInitialized(initialized)

            const response = yield* test.send(initialized, {
              jsonrpc: "2.0",
              id: 10
            })
            const message = yield* test.decodeError(response)

            assert.strictEqual(message.id, 10)
            assert.strictEqual(message.error.code, McpSchema.INVALID_REQUEST_ERROR_CODE)
          }))
      })

      describe("General fields", () => {
        it.effect("SCHEMA preserves additional result metadata fields", () =>
          Effect.gen(function*() {
            const result = yield* Schema.decodeUnknownEffect(McpSchema.ReadResourceResult)({
              contents: [],
              _meta: {
                "example/conformance": {
                  enabled: true,
                  labels: ["one", "two"]
                }
              }
            })

            assert.deepStrictEqual(result._meta, {
              "example/conformance": {
                enabled: true,
                labels: ["one", "two"]
              }
            })
          }))
      })
    })
  })
