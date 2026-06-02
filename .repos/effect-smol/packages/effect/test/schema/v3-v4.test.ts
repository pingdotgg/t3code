import { Effect, Option, Predicate, Schema, SchemaGetter } from "effect"
import { TestSchema } from "effect/testing"
import { describe, it } from "vitest"

describe("v3 -> v4 migration tests", () => {
  describe("optionalWith", () => {
    it("default", async () => {
      // const schema = Schema.Struct({
      //   a: Schema.optionalWith(Schema.NumberFromString, { default: () => "default value" })
      // })

      function f<S extends Schema.Top>(schema: S, defaultValue: S["Type"]) {
        return Schema.Struct({
          a: Schema.optional(schema).pipe(
            Schema.decodeTo(Schema.toType(schema), {
              decode: SchemaGetter.withDefault(Effect.succeed(defaultValue)),
              encode: SchemaGetter.required()
            })
          )
        })
      }

      const schema = f(Schema.NumberFromString, -1)

      const asserts = new TestSchema.Asserts(schema)

      const decoding = asserts.decoding()
      await decoding.succeed({ a: "1" }, { a: 1 })
      await decoding.succeed({}, { a: -1 })
      await decoding.succeed({ a: undefined }, { a: -1 })

      const encoding = asserts.encoding()
      await encoding.succeed({ a: 1 }, { a: "1" })
      await encoding.fail(
        {},
        `Missing key
  at ["a"]`
      )
      await encoding.fail(
        { a: undefined },
        `Expected number, got undefined
  at ["a"]`
      )
    })

    it("default & exact", async () => {
      // const schema = Schema.Struct({
      //   a: Schema.optionalWith(Schema.NumberFromString, { default: () => "default value", exact: true })
      // })

      function f<S extends Schema.Top>(schema: S, defaultValue: S["Type"]) {
        return Schema.Struct({
          a: Schema.optionalKey(schema).pipe(
            Schema.decodeTo(Schema.toType(schema), {
              decode: SchemaGetter.withDefault(Effect.succeed(defaultValue)),
              encode: SchemaGetter.required()
            })
          )
        })
      }

      const schema = f(Schema.NumberFromString, -1)

      const asserts = new TestSchema.Asserts(schema)

      const decoding = asserts.decoding()
      await decoding.succeed({ a: "1" }, { a: 1 })
      await decoding.succeed({}, { a: -1 })
      await decoding.fail(
        { a: undefined },
        `Expected string, got undefined
  at ["a"]`
      )

      const encoding = asserts.encoding()
      await encoding.succeed({ a: 1 }, { a: "1" })
      await encoding.fail(
        {},
        `Missing key
  at ["a"]`
      )
      await encoding.fail(
        { a: undefined },
        `Expected number, got undefined
  at ["a"]`
      )
    })

    it("nullable", async () => {
      // const schema = Schema.Struct({
      //   a: Schema.optionalWith(Schema.String, { nullable: true })
      // })

      function f<S extends Schema.Top>(schema: S) {
        return Schema.Struct({
          a: Schema.optional(Schema.NullOr(schema)).pipe(
            Schema.decodeTo(Schema.optional(Schema.toType(schema)), {
              decode: SchemaGetter.transformOptional(Option.filter(Predicate.isNotNull)),
              encode: SchemaGetter.passthrough()
            })
          )
        })
      }

      const schema = f(Schema.NumberFromString)

      const asserts = new TestSchema.Asserts(schema)

      const decoding = asserts.decoding()
      await decoding.succeed({ a: "1" }, { a: 1 })
      await decoding.succeed({})
      await decoding.succeed({ a: undefined })
      await decoding.succeed({ a: null }, {})

      const encoding = asserts.encoding()
      await encoding.succeed({ a: 1 }, { a: "1" })
      await encoding.succeed({ a: undefined })
      await encoding.succeed({})
      await encoding.fail(
        { a: null },
        `Expected number | undefined, got null
  at ["a"]`
      )
    })

    it("nullable & exact", async () => {
      // const schema = Schema.Struct({
      //   a: Schema.optionalWith(Schema.NumberFromString, { nullable: true, exact: true })
      // })

      function f<S extends Schema.Top>(schema: S) {
        return Schema.Struct({
          a: Schema.optionalKey(Schema.NullOr(schema)).pipe(
            Schema.decodeTo(Schema.optionalKey(Schema.toType(schema)), {
              decode: SchemaGetter.transformOptional(Option.filter(Predicate.isNotNull)),
              encode: SchemaGetter.passthrough()
            })
          )
        })
      }

      const schema = f(Schema.NumberFromString)

      const asserts = new TestSchema.Asserts(schema)

      const decoding = asserts.decoding()
      await decoding.succeed({ a: "1" }, { a: 1 })
      await decoding.succeed({}, {})
      await decoding.succeed({ a: null }, {})
      await decoding.fail(
        { a: undefined },
        `Expected string | null, got undefined
  at ["a"]`
      )

      const encoding = asserts.encoding()
      await encoding.succeed({ a: 1 }, { a: "1" })
      await encoding.succeed({})
      await encoding.fail(
        { a: undefined },
        `Expected number, got undefined
  at ["a"]`
      )
    })

    it("nullable & default", async () => {
      // const schema = Schema.Struct({
      //   a: Schema.optionalWith(Schema.NumberFromString, { nullable: true, default: () => "default value" })
      // })

      function f<S extends Schema.Top>(schema: S, defaultValue: () => S["Type"]) {
        return Schema.Struct({
          a: Schema.optional(Schema.NullOr(schema)).pipe(
            Schema.decodeTo(Schema.UndefinedOr(Schema.toType(schema)), {
              decode: SchemaGetter.transformOptional((o) =>
                o.pipe(Option.filter(Predicate.isNotNull), Option.orElseSome(defaultValue))
              ),
              encode: SchemaGetter.required()
            })
          )
        })
      }

      const schema = f(Schema.NumberFromString, () => -1)

      const asserts = new TestSchema.Asserts(schema)

      const decoding = asserts.decoding()
      await decoding.succeed({ a: "1" }, { a: 1 })
      await decoding.succeed({}, { a: -1 })
      await decoding.succeed({ a: null }, { a: -1 })
      await decoding.succeed({ a: undefined })

      const encoding = asserts.encoding()
      await encoding.succeed({ a: 1 }, { a: "1" })
      await encoding.succeed({ a: undefined })
      await encoding.fail(
        {},
        `Missing key
  at ["a"]`
      )
    })

    it("nullable & default & exact", async () => {
      // const schema = Schema.Struct({
      //   a: Schema.optionalWith(Schema.NumberFromString, { nullable: true, default: () => "default value", exact: true })
      // })

      function f<S extends Schema.Top>(schema: S, defaultValue: () => S["Type"]) {
        return Schema.Struct({
          a: Schema.optionalKey(Schema.NullOr(schema)).pipe(
            Schema.decodeTo(Schema.toType(schema), {
              decode: SchemaGetter.transformOptional((o) =>
                o.pipe(Option.filter(Predicate.isNotNull), Option.orElseSome(defaultValue))
              ),
              encode: SchemaGetter.required()
            })
          )
        })
      }

      const schema = f(Schema.NumberFromString, () => -1)

      const asserts = new TestSchema.Asserts(schema)

      const decoding = asserts.decoding()
      await decoding.succeed({ a: "1" }, { a: 1 })
      await decoding.succeed({}, { a: -1 })
      await decoding.succeed({ a: null }, { a: -1 })
      await decoding.fail(
        { a: undefined },
        `Expected string | null, got undefined
  at ["a"]`
      )

      const encoding = asserts.encoding()
      await encoding.succeed({ a: 1 }, { a: "1" })
      await encoding.fail(
        { a: undefined },
        `Expected number, got undefined
  at ["a"]`
      )
      await encoding.fail(
        {},
        `Missing key
  at ["a"]`
      )
    })
  })
})
