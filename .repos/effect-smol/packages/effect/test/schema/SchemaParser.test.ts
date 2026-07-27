import { describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Result, Schema, SchemaGetter, SchemaIssue, SchemaParser } from "effect"
import { assertTrue, strictEqual, throws } from "../utils/assert.ts"

describe("SchemaParser", () => {
  const makeMixedCause = () =>
    Cause.combine(
      Cause.fail(new SchemaIssue.InvalidValue(Option.some("a"), { message: "schema issue" })),
      Cause.die(new Error("defect"))
    )
  const makeMixedSchemaErrorCause = () =>
    Cause.combine(
      Cause.fail(new Schema.SchemaError(new SchemaIssue.InvalidValue(Option.some("a"), { message: "schema issue" }))),
      Cause.die(new Error("defect"))
    )

  describe("make", () => {
    it("should throw an error when the input is invalid", () => {
      const schema = Schema.String
      throws(() => SchemaParser.make(schema)(null as any), (e) => {
        assertTrue(e instanceof Error)
        assertTrue(SchemaIssue.isIssue(e.cause))
        strictEqual(e.message, "Expected string, got null")
      })
    })

    it("should throw an error when the cause contains both an Issue and a defect", () => {
      const schema = Schema.Struct({
        a: Schema.String.pipe(Schema.withConstructorDefault(Effect.failCause(makeMixedSchemaErrorCause())))
      })

      throws(() => SchemaParser.make(schema)({}), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Constructor adapter can only throw schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })
  })

  describe("makeOption", () => {
    it("should throw an error when the cause is not an Issue", () => {
      const schema = Schema.Struct({
        a: Schema.String.pipe(Schema.withConstructorDefault(Effect.die(new Error("make defect"))))
      })

      throws(() => SchemaParser.makeOption(schema)({}), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Option adapter can only return none for schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })

    it("should throw an error when the cause contains both an Issue and a defect", () => {
      const schema = Schema.Struct({
        a: Schema.String.pipe(Schema.withConstructorDefault(Effect.failCause(makeMixedSchemaErrorCause())))
      })

      throws(() => SchemaParser.makeOption(schema)({}), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Option adapter can only return none for schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })
  })

  describe("decodeUnknownSync / encodeUnknownSync", () => {
    it("should throw an error when the input is invalid", () => {
      const schema = Schema.String
      throws(() => SchemaParser.decodeUnknownSync(schema)(null), (e) => {
        assertTrue(e instanceof Error)
        assertTrue(SchemaIssue.isIssue(e.cause))
        strictEqual(e.message, "Expected string, got null")
      })
      throws(() => SchemaParser.encodeUnknownSync(schema)(null), (e) => {
        assertTrue(e instanceof Error)
        assertTrue(SchemaIssue.isIssue(e.cause))
        strictEqual(e.message, "Expected string, got null")
      })
    })

    it("should throw an error when the cause contains both an Issue and a defect", () => {
      const decodeSchema = Schema.String.pipe(Schema.decode({
        decode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause())),
        encode: SchemaGetter.passthrough()
      }))
      const encodeSchema = Schema.String.pipe(Schema.encode({
        decode: SchemaGetter.passthrough(),
        encode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause()))
      }))

      throws(() => SchemaParser.decodeUnknownSync(decodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Sync adapter can only throw schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
      throws(() => SchemaParser.encodeUnknownSync(encodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Sync adapter can only throw schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })
  })

  describe("decodeUnknownPromise / encodeUnknownPromise", () => {
    it("should reject with an error when the input is invalid", async () => {
      const schema = Schema.String
      const r1 = await SchemaParser.decodeUnknownPromise(schema)(null).then(Result.succeed, Result.fail)
      assertTrue(Result.isFailure(r1))
      assertTrue(r1.failure instanceof Error)
      assertTrue(SchemaIssue.isIssue(r1.failure.cause))
      strictEqual(r1.failure.message, "Expected string, got null")
      const r2 = await SchemaParser.encodeUnknownPromise(schema)(null).then(Result.succeed, Result.fail)
      assertTrue(Result.isFailure(r2))
      assertTrue(r2.failure instanceof Error)
      assertTrue(SchemaIssue.isIssue(r2.failure.cause))
      strictEqual(r2.failure.message, "Expected string, got null")
    })

    it("should reject with an error when the cause contains both an Issue and a defect", async () => {
      const decodeSchema = Schema.String.pipe(Schema.decode({
        decode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause())),
        encode: SchemaGetter.passthrough()
      }))
      const encodeSchema = Schema.String.pipe(Schema.encode({
        decode: SchemaGetter.passthrough(),
        encode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause()))
      }))

      const r1 = await SchemaParser.decodeUnknownPromise(decodeSchema)("a").then(Result.succeed, Result.fail)
      assertTrue(Result.isFailure(r1))
      assertTrue(r1.failure instanceof Error)
      strictEqual(r1.failure.message, "Promise adapter can only reject schema issues")
      assertTrue(Cause.hasDies(r1.failure.cause as Cause.Cause<never>))

      const r2 = await SchemaParser.encodeUnknownPromise(encodeSchema)("a").then(Result.succeed, Result.fail)
      assertTrue(Result.isFailure(r2))
      assertTrue(r2.failure instanceof Error)
      strictEqual(r2.failure.message, "Promise adapter can only reject schema issues")
      assertTrue(Cause.hasDies(r2.failure.cause as Cause.Cause<never>))
    })
  })

  describe("decodeUnknownOption / encodeUnknownOption", () => {
    it("should return none when the input is invalid", () => {
      const schema = Schema.String
      assertTrue(Option.isSome(SchemaParser.decodeUnknownOption(schema)("a")))
      assertTrue(Option.isNone(SchemaParser.decodeUnknownOption(schema)(null)))
      assertTrue(Option.isSome(SchemaParser.encodeUnknownOption(schema)("a")))
      assertTrue(Option.isNone(SchemaParser.encodeUnknownOption(schema)(null)))
    })

    it("should throw an error when the cause is not an Issue", () => {
      const decodeSchema = Schema.String.pipe(Schema.decode({
        decode: new SchemaGetter.Getter(() => Effect.die(new Error("decode defect"))),
        encode: SchemaGetter.passthrough()
      }))
      const encodeSchema = Schema.String.pipe(Schema.encode({
        decode: SchemaGetter.passthrough(),
        encode: new SchemaGetter.Getter(() => Effect.die(new Error("encode defect")))
      }))

      throws(() => SchemaParser.decodeUnknownOption(decodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Option adapter can only return none for schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
      throws(() => SchemaParser.encodeUnknownOption(encodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Option adapter can only return none for schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })

    it("should throw an error when the cause contains both an Issue and a defect", () => {
      const decodeSchema = Schema.String.pipe(Schema.decode({
        decode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause())),
        encode: SchemaGetter.passthrough()
      }))
      const encodeSchema = Schema.String.pipe(Schema.encode({
        decode: SchemaGetter.passthrough(),
        encode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause()))
      }))

      throws(() => SchemaParser.decodeUnknownOption(decodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Option adapter can only return none for schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
      throws(() => SchemaParser.encodeUnknownOption(encodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Option adapter can only return none for schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })
  })

  describe("is", () => {
    it("should return false when the input is invalid", () => {
      const is = SchemaParser.is(Schema.String)
      strictEqual(is("a"), true)
      strictEqual(is(null), false)
    })

    it("should throw an error when the cause is not an Issue", () => {
      const schema = Schema.declareConstructor<string>()(
        [],
        () => () => Effect.die(new Error("is defect"))
      )

      throws(() => SchemaParser.is(schema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Type guard adapter can only return false for schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })

    it("should throw an error when the cause contains both an Issue and a defect", () => {
      const schema = Schema.declareConstructor<string>()(
        [],
        () => () => Effect.failCause(makeMixedCause())
      )

      throws(() => SchemaParser.is(schema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Type guard adapter can only return false for schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })
  })

  describe("asserts", () => {
    it("should throw an error when the cause is not an Issue", () => {
      const schema = Schema.declareConstructor<string>()(
        [],
        () => () => Effect.die(new Error("assert defect"))
      )

      throws(() => SchemaParser.asserts(schema, "a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Assertion adapter can only throw schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })

    it("should throw an error when the cause contains both an Issue and a defect", () => {
      const schema = Schema.declareConstructor<string>()(
        [],
        () => () => Effect.failCause(makeMixedCause())
      )

      throws(() => SchemaParser.asserts(schema, "a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Assertion adapter can only throw schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })
  })

  describe("decodeUnknownResult / encodeUnknownResult", () => {
    it("should throw an error when the cause is not an Issue", () => {
      const decodeSchema = Schema.String.pipe(Schema.decode({
        decode: new SchemaGetter.Getter(() => Effect.die(new Error("decode defect"))),
        encode: SchemaGetter.passthrough()
      }))
      const encodeSchema = Schema.String.pipe(Schema.encode({
        decode: SchemaGetter.passthrough(),
        encode: new SchemaGetter.Getter(() => Effect.die(new Error("encode defect")))
      }))

      throws(() => SchemaParser.decodeUnknownResult(decodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Result adapter can only return schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
      throws(() => SchemaParser.encodeUnknownResult(encodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Result adapter can only return schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })

    it("should throw an error when the cause contains both an Issue and a defect", () => {
      const decodeSchema = Schema.String.pipe(Schema.decode({
        decode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause())),
        encode: SchemaGetter.passthrough()
      }))
      const encodeSchema = Schema.String.pipe(Schema.encode({
        decode: SchemaGetter.passthrough(),
        encode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause()))
      }))

      throws(() => SchemaParser.decodeUnknownResult(decodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Result adapter can only return schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
      throws(() => SchemaParser.encodeUnknownResult(encodeSchema)("a"), (e) => {
        assertTrue(e instanceof Error)
        strictEqual(e.message, "Result adapter can only return schema issues")
        assertTrue(Cause.hasDies(e.cause as Cause.Cause<never>))
      })
    })
  })

  describe("decodeUnknownExit", () => {
    it("should preserve mixed causes in union candidates instead of trying later candidates", () => {
      const schema = Schema.Union([
        Schema.String.pipe(Schema.decode({
          decode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause())),
          encode: SchemaGetter.passthrough()
        })),
        Schema.Literal("a")
      ])

      const exit = SchemaParser.decodeUnknownExit(schema)("a")
      assertTrue(Exit.isFailure(exit))
      assertTrue(Exit.hasDies(exit))
      const error = Cause.findError(exit.cause)
      assertTrue(Result.isSuccess(error))
      assertTrue(SchemaIssue.isIssue(error.success))
    })
  })
})
