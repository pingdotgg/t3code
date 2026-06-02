import { Schema } from "effect"
import { describe, expect, it } from "tstyche"

describe("Array", () => {
  it("Array<FiniteFromString> exposes .value", () => {
    const schema = Schema.Array(Schema.FiniteFromString)
    expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<ReadonlyArray<number>, ReadonlyArray<string>>>()
    expect(schema).type.toBe<Schema.$Array<typeof Schema.FiniteFromString>>()
    expect(schema.annotate({})).type.toBe<Schema.$Array<typeof Schema.FiniteFromString>>()

    expect(schema.value).type.toBe<typeof Schema.FiniteFromString>()
  })

  it("mutable Array<FiniteFromString> exposes .value", () => {
    const schema = Schema.mutable(Schema.Array(Schema.FiniteFromString))
    expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<Array<number>, Array<string>>>()
    expect(schema).type.toBe<Schema.mutable<Schema.$Array<typeof Schema.FiniteFromString>>>()
    expect(schema.annotate({})).type.toBe<Schema.mutable<Schema.$Array<typeof Schema.FiniteFromString>>>()

    expect(schema.schema.value).type.toBe<typeof Schema.FiniteFromString>()
  })
})

describe("NonEmptyArray", () => {
  it("NonEmptyArray<FiniteFromString> exposes .value", () => {
    const schema = Schema.NonEmptyArray(Schema.FiniteFromString)
    expect(Schema.revealCodec(schema)).type.toBe<
      Schema.Codec<readonly [number, ...Array<number>], readonly [string, ...Array<string>]>
    >()
    expect(schema).type.toBe<Schema.NonEmptyArray<typeof Schema.FiniteFromString>>()
    expect(schema.annotate({})).type.toBe<Schema.NonEmptyArray<typeof Schema.FiniteFromString>>()

    expect(schema.value).type.toBe<typeof Schema.FiniteFromString>()
  })

  it("mutable NonEmptyArray<FiniteFromString> exposes .value", () => {
    const schema = Schema.mutable(Schema.NonEmptyArray(Schema.FiniteFromString))
    expect(Schema.revealCodec(schema)).type.toBe<
      Schema.Codec<[number, ...Array<number>], [string, ...Array<string>]>
    >()
    expect(schema).type.toBe<Schema.mutable<Schema.NonEmptyArray<typeof Schema.FiniteFromString>>>()
    expect(schema.annotate({})).type.toBe<Schema.mutable<Schema.NonEmptyArray<typeof Schema.FiniteFromString>>>()

    expect(schema.schema.value).type.toBe<typeof Schema.FiniteFromString>()
  })
})
