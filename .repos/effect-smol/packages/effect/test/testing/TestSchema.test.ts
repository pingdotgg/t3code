import { Context, Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { TestSchema } from "effect/testing"
import { describe, it } from "vitest"

describe("TestSchema", () => {
  it("decoding", async () => {
    const schema = Schema.FiniteFromString.check(Schema.isGreaterThan(0))
    const assert = new TestSchema.Asserts(schema)
    const decoding = assert.decoding()
    await decoding.succeed("1", 1)
    await decoding.fail("-1", `Expected a value greater than 0, got -1`)
    await decoding.fail("a", `Expected a finite number, got NaN`)
  })

  it("decoding.provide", async () => {
    class Service extends Context.Service<Service, { fallback: Effect.Effect<string> }>()("Service") {}

    const schema = Schema.String.pipe(
      Schema.decode({
        decode: SchemaGetter.checkEffect((s) =>
          Effect.gen(function*() {
            yield* Service
            if (s.length === 0) {
              return new SchemaIssue.InvalidValue(Option.some(s), {
                message: "input should not be empty string"
              })
            }
          })
        ),
        encode: SchemaGetter.passthrough()
      })
    )
    const asserts = new TestSchema.Asserts(schema)

    const decoding = asserts.decoding().provide(Service, { fallback: Effect.succeed("b") })
    await decoding.succeed("a")
    await decoding.fail("", "input should not be empty string")
  })

  it("encoding", async () => {
    const schema = Schema.FiniteFromString.check(Schema.isGreaterThan(0))
    const assert = new TestSchema.Asserts(schema)
    const encoding = assert.encoding()
    await encoding.succeed(1, "1")
    await encoding.fail(-1, `Expected a value greater than 0, got -1`)
  })

  it("encoding.provide", async () => {
    class Service extends Context.Service<Service, { fallback: Effect.Effect<string> }>()("Service") {}

    const schema = Schema.String.pipe(
      Schema.decode({
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.checkEffect((s) =>
          Effect.gen(function*() {
            yield* Service
            if (s.length === 0) {
              return new SchemaIssue.InvalidValue(Option.some(s), {
                message: "input should not be empty string"
              })
            }
          })
        )
      })
    )
    const asserts = new TestSchema.Asserts(schema)

    const encoding = asserts.encoding().provide(Service, { fallback: Effect.succeed("b") })
    await encoding.succeed("a")
    await encoding.fail("", "input should not be empty string")
  })

  it("verifyLosslessTransformation", async () => {
    const schema = Schema.FiniteFromString.check(Schema.isGreaterThan(0))
    const assert = new TestSchema.Asserts(schema)
    await assert.verifyLosslessTransformation()
  })
})
