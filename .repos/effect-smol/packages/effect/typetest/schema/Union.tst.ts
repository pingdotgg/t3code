import { Effect, Schema, Tuple } from "effect"
import type { Array as Arr } from "effect"
import { describe, expect, it } from "tstyche"

describe("Union", () => {
  it("empty", () => {
    const schema = Schema.Union([])
    expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<never, never, never>>()
    expect(schema).type.toBe<Schema.Union<readonly []>>()
    expect(schema.annotate({})).type.toBe<Schema.Union<readonly []>>()

    expect(schema.members).type.toBe<readonly []>()
  })

  it("string", () => {
    const schema = Schema.Union([Schema.String])
    expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
    expect(schema).type.toBe<Schema.Union<readonly [Schema.String]>>()
    expect(schema.annotate({})).type.toBe<Schema.Union<readonly [Schema.String]>>()

    expect(schema.members).type.toBe<readonly [Schema.String]>()
  })

  it("string | number", () => {
    const schema = Schema.Union([Schema.String, Schema.Number])
    expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string | number, string | number, never>>()
    expect(schema).type.toBe<Schema.Union<readonly [Schema.String, Schema.Number]>>()
    expect(schema.annotate({})).type.toBe<Schema.Union<readonly [Schema.String, Schema.Number]>>()

    expect(schema.members).type.toBe<readonly [Schema.String, Schema.Number]>()
  })

  describe("mapMembers", () => {
    it("appendElement", () => {
      const schema = Schema.Union([Schema.String, Schema.Number]).mapMembers(Tuple.appendElement(Schema.Boolean))
      expect(Schema.revealCodec(schema)).type.toBe<
        Schema.Codec<string | number | boolean, string | number | boolean, never, never>
      >()
      expect(schema).type.toBe<Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>()
    })

    it("evolve", () => {
      const schema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]).mapMembers(
        Tuple.evolve([
          (v) => Schema.Array(v),
          undefined,
          (v) => Schema.Array(v)
        ])
      )
      expect(Schema.revealCodec(schema)).type.toBe<
        Schema.Codec<
          ReadonlyArray<string> | number | ReadonlyArray<boolean>,
          ReadonlyArray<string> | number | ReadonlyArray<boolean>,
          never,
          never
        >
      >()
      expect(schema).type.toBe<
        Schema.Union<readonly [Schema.$Array<Schema.String>, Schema.Number, Schema.$Array<Schema.Boolean>]>
      >()
    })

    it("Array", () => {
      const schema = Schema.Union([Schema.String, Schema.Number]).mapMembers(Tuple.map(Schema.Array))
      expect(Schema.revealCodec(schema)).type.toBe<
        Schema.Codec<
          ReadonlyArray<string> | ReadonlyArray<number>,
          ReadonlyArray<string> | ReadonlyArray<number>,
          never,
          never
        >
      >()
      expect(schema).type.toBe<Schema.Union<readonly [Schema.$Array<Schema.String>, Schema.$Array<Schema.Number>]>>()
    })

    it("NonEmptyArray", () => {
      const schema = Schema.Union([Schema.String, Schema.Number]).mapMembers(Tuple.map(Schema.NonEmptyArray))
      expect(Schema.revealCodec(schema)).type.toBe<
        Schema.Codec<
          Arr.NonEmptyReadonlyArray<string> | Arr.NonEmptyReadonlyArray<number>,
          Arr.NonEmptyReadonlyArray<string> | Arr.NonEmptyReadonlyArray<number>,
          never,
          never
        >
      >()
      expect(schema).type.toBe<
        Schema.Union<readonly [Schema.NonEmptyArray<Schema.String>, Schema.NonEmptyArray<Schema.Number>]>
      >()
    })
  })

  describe("Tagged unions", () => {
    describe("asTaggedUnion", () => {
      it("should not be callable if the tag field is invalid", () => {
        const original = Schema.Union([
          Schema.TaggedStruct("A", { a: Schema.String }),
          Schema.TaggedStruct("C", { c: Schema.Boolean }),
          Schema.TaggedStruct("B", { b: Schema.FiniteFromString })
        ])

        expect(original.pipe).type.toBeCallableWith(Schema.toTaggedUnion("_tag"))
        expect(original.pipe).type.not.toBeCallableWith(Schema.toTaggedUnion("a"))

        const schema = original.pipe(Schema.toTaggedUnion("_tag"))

        expect(Schema.revealCodec(schema)).type.toBe<
          Schema.Codec<
            | { readonly _tag: "A"; readonly a: string }
            | { readonly _tag: "B"; readonly b: number }
            | { readonly _tag: "C"; readonly c: boolean },
            | { readonly _tag: "A"; readonly a: string }
            | { readonly _tag: "B"; readonly b: string }
            | { readonly _tag: "C"; readonly c: boolean },
            never,
            never
          >
        >()

        // cases
        const { A, B, C } = schema.cases
        expect(B.fields._tag.schema.literal).type.toBe<"B">()
        expect(A.fields._tag.schema.literal).type.toBe<"A">()
        expect(C.fields._tag.schema.literal).type.toBe<"C">()
        expect(A).type.toBe<Schema.TaggedStruct<"A", { readonly a: Schema.String }>>()
        expect(B).type.toBe<Schema.TaggedStruct<"B", { readonly b: Schema.FiniteFromString }>>()
        expect(C).type.toBe<Schema.TaggedStruct<"C", { readonly c: Schema.Boolean }>>()
      })
    })

    describe("match", () => {
      it("should allow distinct Effect branch outputs", () => {
        const schema = Schema.Union([
          Schema.TaggedStruct("A", { a: Schema.String }),
          Schema.TaggedStruct("B", { b: Schema.Number })
        ]).pipe(Schema.toTaggedUnion("_tag"))
        const handler = schema.match({
          A: () => Effect.succeed("ok" as const),
          B: () => Effect.fail("nope" as const)
        })

        expect(handler).type.toBeCallableWith({ _tag: "A", a: "a" })
        expect(handler).type.toBeCallableWith({ _tag: "B", b: 1 })
        expect(handler).type.toBeAssignableTo<
          (value: Schema.Schema.Type<typeof schema>) => Effect.Effect<"ok", "nope", never>
        >()
      })
    })

    describe("TaggedUnion", () => {
      it("should depends on the order of the cases", () => {
        const schema = Schema.TaggedUnion({
          A: { a: Schema.String },
          C: { c: Schema.Boolean },
          B: { b: Schema.FiniteFromString }
        }).annotate({})

        expect(Schema.revealCodec(schema)).type.toBe<
          Schema.Codec<
            | { readonly _tag: "A"; readonly a: string }
            | { readonly _tag: "B"; readonly b: number }
            | { readonly _tag: "C"; readonly c: boolean },
            | { readonly _tag: "A"; readonly a: string }
            | { readonly _tag: "B"; readonly b: string }
            | { readonly _tag: "C"; readonly c: boolean },
            never,
            never
          >
        >()

        // cases
        const { A, B, C } = schema.cases
        expect(B.fields._tag.schema.literal).type.toBe<"B">()
        expect(A.fields._tag.schema.literal).type.toBe<"A">()
        expect(C.fields._tag.schema.literal).type.toBe<"C">()
        expect(A).type.toBe<Schema.TaggedStruct<"A", { readonly a: Schema.String }>>()
        expect(B).type.toBe<Schema.TaggedStruct<"B", { readonly b: Schema.FiniteFromString }>>()
        expect(C).type.toBe<Schema.TaggedStruct<"C", { readonly c: Schema.Boolean }>>()
      })
    })
  })
})
