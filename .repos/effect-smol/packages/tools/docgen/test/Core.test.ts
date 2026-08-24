import * as Core from "@effect/docgen/Core"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

const assertFencedCode = (
  markdown: string,
  expectedExamples: ReadonlyArray<string>,
  expectedWarnings: ReadonlyArray<string>
) => {
  assert.deepStrictEqual(Core.extractFencedCode(markdown), [expectedExamples, expectedWarnings])
}

describe("Core", () => {
  describe("[internal] extractFencedCode", () => {
    it("should extract fenced code blocks from markdown (backticks)", () => {
      assertFencedCode("a\n\n```ts\nconst a = 1\n```\n\nb", ["const a = 1"], [])
    })

    it("should extract fenced code blocks from markdown (tildes)", () => {
      assertFencedCode("a\n\n~~~ts\nconst a = 1\n~~~~\n\nb", ["const a = 1"], [])
    })

    it("should skip-type-checking (backticks)", () => {
      assertFencedCode("a\n\n```ts skip-type-checking a=1\nconst a = 1\n```\n\nb", [], [])
    })

    it("should skip-type-checking (tildes)", () => {
      assertFencedCode("a\n\n~~~ts skip-type-checking a=1\nconst a = 1\n~~~~\n\nb", [], [])
    })

    it("should handle metadata (backticks)", () => {
      assertFencedCode("a\n\n```ts a=1\nconst a = 1\n```\n\nb", ["const a = 1"], [])
    })

    it("should handle metadata (tildes)", () => {
      assertFencedCode("a\n\n~~~ts a=1\nconst a = 1\n~~~~\n\nb", ["const a = 1"], [])
    })

    it("should handle non closing fences (backticks)", () => {
      assertFencedCode("a\n\n```ts\nconst a = 1", ["const a = 1"], [
        "Code block does not have a matching closing fence:\na\n\n```ts\nconst a = 1"
      ])
    })

    it("should handle non closing fences (tildes)", () => {
      assertFencedCode("a\n\n~~~ts\nconst a = 1", ["const a = 1"], [
        "Code block does not have a matching closing fence:\na\n\n~~~ts\nconst a = 1"
      ])
    })
  })

  describe("[internal] runCommand", () => {
    it.effect("streams output without a maxBuffer limit", () =>
      Effect.gen(function*() {
        const size = 1024 * 1024 + 1
        const result = yield* Core.runCommand("node", [
          "-e",
          `process.stdout.write("x".repeat(${size})); process.stderr.write("problem"); process.exitCode = 2`
        ], false)
        assert.strictEqual(result.stdout.length, size)
        assert.strictEqual(result.stderr, "problem")
        assert.strictEqual(result.exitCode, 2)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  })
})
