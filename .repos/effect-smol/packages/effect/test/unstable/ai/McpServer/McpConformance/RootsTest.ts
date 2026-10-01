import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import { makeMcpStdioHarness } from "../TestUtils/McpStdioHarness.ts"
import { McpConformance, type McpConformanceLayer } from "./McpConformance.ts"

const rootsHandler = (roots: ReadonlyArray<{ readonly uri: string; readonly name?: string }>) => () =>
  Effect.succeed({ roots })

export const suite = (protocol: McpProtocol.ProtocolAdapter, layer: McpConformanceLayer) =>
  it.layer(layer)(`Mcp Conformance (${protocol.protocolVersion})`, (it) => {
    describe("Roots", () => {
      // Identical requirements in the 2024-11-05, 2025-03-26, and 2025-06-18 specifications.
      describe("Capabilities", () => {
        it.effect("MUST send roots requests when the client advertises roots", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const peer = yield* test.makePeer({
              capabilities: { roots: {} },
              handlers: {
                "roots/list": rootsHandler([])
              }
            })

            yield* peer.wireClient["roots/list"](undefined)

            assert.strictEqual((yield* peer.takeRequest).method, "roots/list")
          }))

        it.effect("MUST accept roots requests when the client advertises list changes", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const peer = yield* test.makePeer({
              capabilities: { roots: { listChanged: true } },
              handlers: {
                "roots/list": rootsHandler([])
              }
            })

            yield* peer.wireClient["roots/list"](undefined)

            assert.strictEqual((yield* peer.takeRequest).method, "roots/list")
          }))
      })

      describe("Listing Roots", () => {
        it.effect("MUST accept roots with file URIs and preserve optional names", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const peer = yield* test.makePeer({
              capabilities: { roots: {} },
              handlers: {
                "roots/list": rootsHandler([
                  { uri: "file:///workspace", name: "Workspace" },
                  { uri: "file:///unnamed" }
                ])
              }
            })

            const result = yield* peer.wireClient["roots/list"](undefined)

            assert.deepStrictEqual(
              result.roots.map((root) => ({
                uri: root.uri,
                name: root.name
              })),
              [
                { uri: "file:///workspace", name: "Workspace" },
                { uri: "file:///unnamed", name: undefined }
              ]
            )
          }))

        it.effect("MAY accept an empty roots list", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const peer = yield* test.makePeer({
              capabilities: { roots: {} },
              handlers: {
                "roots/list": rootsHandler([])
              }
            })

            const result = yield* peer.wireClient["roots/list"](undefined)

            assert.deepStrictEqual(result.roots, [])
          }))

        it.effect("MUST surface client errors returned by roots/list", () =>
          Effect.gen(function*() {
            const test = yield* McpConformance
            const peer = yield* test.makePeer({
              capabilities: { roots: {} },
              handlers: {
                "roots/list": () =>
                  Effect.fail(
                    new McpSchema.InternalError({
                      message: "Roots unavailable"
                    })
                  )
              }
            })

            const error = yield* peer.wireClient["roots/list"](undefined).pipe(Effect.flip)

            assert.isTrue("code" in error)
            if ("code" in error) assert.strictEqual(error.code, McpSchema.INTERNAL_ERROR_CODE)
            assert.strictEqual(error.message, "Roots unavailable")
          }))
      })

      describe("Root List Changes", () => {
        it.effect("SHOULD refresh roots after a capable client reports a list change", () =>
          Effect.gen(function*() {
            const fixture = yield* makeMcpStdioHarness(protocol)
            yield* fixture.initialize({ roots: { listChanged: true } })

            yield* fixture.sendNotification("notifications/roots/list_changed")

            const request = yield* fixture.awaitOutboundMethod("roots/list")
            assert.strictEqual(request.jsonrpc, "2.0")
            assert.strictEqual(request.method, "roots/list")
            if (typeof request.id !== "string" && typeof request.id !== "number") {
              return assert.fail("roots/list request must include an identifier")
            }

            yield* fixture.respond(request.id, {
              roots: [{ uri: "file:///updated", name: "Updated" }]
            })
          }))
      })
    })
  })
