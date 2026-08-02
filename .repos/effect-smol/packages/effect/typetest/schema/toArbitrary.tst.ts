import { Schema } from "effect"
import type * as FastCheck from "effect/testing/FastCheck"
import { describe, expect, it } from "tstyche"

describe("toArbitrary", () => {
  it("returns the schema Type arbitrary", () => {
    const schema = Schema.Struct({
      name: Schema.String,
      age: Schema.Number
    })
    const arbitrary = Schema.toArbitrary(schema)

    expect(arbitrary).type.toBe<
      FastCheck.Arbitrary<{
        readonly name: string
        readonly age: number
      }>
    >()
  })

  it("returns a report when requested", () => {
    const schema = Schema.Struct({
      name: Schema.String,
      age: Schema.Number
    })
    const result = Schema.toArbitrary(schema, { report: true })

    expect(result).type.toBe<
      Schema.Annotations.ToArbitrary.WithReport<
        FastCheck.Arbitrary<{
          readonly name: string
          readonly age: number
        }>
      >
    >()
  })

  it("passes recursion metadata in the arbitrary context", () => {
    Schema.String.annotate({
      toArbitrary: () => (fc, context) => {
        expect(context.constraint).type.toBe<Schema.Annotations.ToArbitrary.GenerationConstraint | undefined>()
        expect(context.recursion).type.toBe<Schema.Annotations.ToArbitrary.Recursion | undefined>()
        return fc.string()
      }
    })
  })

  it("passes type parameter derivations to declaration arbitrary hooks", () => {
    Schema.declareConstructor<ReadonlyArray<string>>()(
      [Schema.String],
      () => null as any,
      {
        toArbitrary: ([value]) => (fc) => {
          expect(value).type.toBe<Schema.Annotations.ToArbitrary.TypeParameter<string>>()
          expect(value.arbitrary).type.toBe<FastCheck.Arbitrary<string>>()
          expect(value.terminal).type.toBe<FastCheck.Arbitrary<string> | undefined>()
          return {
            arbitrary: fc.array(value.arbitrary),
            terminal: value.terminal === undefined ? undefined : fc.array(value.terminal)
          }
        }
      }
    )
  })
})
