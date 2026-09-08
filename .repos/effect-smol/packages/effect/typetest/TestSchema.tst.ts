import type { Effect, SchemaIssue } from "effect"
import { Schema } from "effect"
import { TestSchema } from "effect/testing"
import { describe, expect, it } from "tstyche"

describe("TestSchema", () => {
  it("types Encoding.encodeUnknownEffect with the encoded output", () => {
    const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()

    expect(encoding.encodeUnknownEffect(1)).type.toBe<Effect.Effect<string, SchemaIssue.Issue>>()
  })
})
