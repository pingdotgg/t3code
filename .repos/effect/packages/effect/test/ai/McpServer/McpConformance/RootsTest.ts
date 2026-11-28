import { assert, describe, it } from "@effect/vitest"
import type * as McpProtocol from "effect/ai/McpProtocol"
import * as McpSchema from "effect/ai/McpSchema"
import * as Effect from "effect/Effect"
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

            yield* peer.reverseClient.listRoots()

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

            yield* peer.reverseClient.listRoots()

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

            const result = yield* peer.reverseClient.listRoots()

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

            const result = yield* peer.reverseClient.listRoots()

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

            const error = yield* peer.reverseClient.listRoots().pipe(Effect.flip)

            assert.instanceOf(error, McpSchema.McpReverseOperationError)
            assert.strictEqual(error.operation, "roots/list")
            assert.deepInclude(error.cause, { code: McpSchema.INTERNAL_ERROR_CODE, message: "Roots unavailable" })
          }))
      })
    })
  })
