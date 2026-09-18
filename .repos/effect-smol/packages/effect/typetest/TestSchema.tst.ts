import type { Effect, SchemaIssue } from "effect"
import { Schema } from "effect"
import { TestSchema } from "effect/testing"
import { describe, expect, it } from "tstyche"

describe("TestSchema", () => {
  it("types Encoding.encodeUnknownEffect with the encoded output", () => {
    const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()

    expect(encoding.encodeUnknownEffect(1)).type.toBe<Effect.Effect<string, SchemaIssue.Issue>>()
  })

  it("uses native Arbitrary check options", () => {
    const asserts = new TestSchema.Asserts(Schema.String)

    expect(asserts.verifyLosslessTransformation({ runs: 20, seed: "lossless" })).type.toBe<Promise<void>>()
    expect(asserts.arbitrary().verifyGeneration({ runs: 20, maxDiscards: 100, seed: "generation" }))
      .type.toBe<void>()
  })
})
