import { describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Result, Schema, SchemaGetter, SchemaIssue, SchemaParser } from "effect"
import { assertSchemaIssueError, assertTrue, strictEqual, throws } from "../utils/assert.ts"

describe("SchemaParser", () => {
  const makeMixedCause = () =>
    Cause.combine(
      Cause.fail(new SchemaIssue.InvalidValue({ message: "schema issue" })),
      Cause.die(new Error("defect"))
    )
  describe("make", () => {
    it("should throw an error when the input is invalid", () => {
      const schema = Schema.String
      throws(() => SchemaParser.make(schema)(null as any), (e) => {
        assertSchemaIssueError(e, "Expected string")
      })
    })

    it("should throw an error when the cause contains both an Issue and a defect", () => {
      const schema = Schema.Struct({
        a: Schema.String.pipe(Schema.withConstructorDefault(Effect.failCause(makeMixedCause())))
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
        a: Schema.String.pipe(Schema.withConstructorDefault(Effect.failCause(makeMixedCause())))
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
        assertSchemaIssueError(e, "Expected string")
      })
      throws(() => SchemaParser.encodeUnknownSync(schema)(null), (e) => {
        assertSchemaIssueError(e, "Expected string")
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
      assertSchemaIssueError(r1.failure, "Expected string")
      const r2 = await SchemaParser.encodeUnknownPromise(schema)(null).then(Result.succeed, Result.fail)
      assertTrue(Result.isFailure(r2))
      assertSchemaIssueError(r2.failure, "Expected string")
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
    it("preserves values that use Effect data protocols", () => {
      let executions = 0
      const suspended = Effect.sync(() => {
        executions++
        return "a"
      })
      const decode = SchemaParser.decodeUnknownExit(Schema.Unknown)
      const values = [Option.none(), Option.some("a"), Exit.succeed("a"), Exit.fail("a"), suspended]

      for (const value of values) {
        const result = decode(value)
        assertTrue(Exit.isSuccess(result))
        strictEqual(result.value, value)
      }
      strictEqual(executions, 0)

      const failure = Exit.fail("a")
      const unionResult = SchemaParser.decodeUnknownExit(Schema.Union([Schema.Unknown]))(failure)
      assertTrue(Exit.isSuccess(unionResult))
      strictEqual(unionResult.value, failure)
    })

    it("distinguishes missing tuple elements from undefined", () => {
      const decode = SchemaParser.decodeUnknownExit(
        Schema.Tuple([Schema.optionalKey(Schema.Undefined)])
      )

      const empty = decode([])
      assertTrue(Exit.isSuccess(empty))
      strictEqual(empty.value.length, 0)

      const present = decode([undefined])
      assertTrue(Exit.isSuccess(present))
      strictEqual(present.value.length, 1)
      assertTrue(Object.hasOwn(present.value, 0))

      const sparse = decode(new Array(1))
      assertTrue(Exit.isSuccess(sparse))
      strictEqual(sparse.value.length, 1)
      assertTrue(Object.hasOwn(sparse.value, 0))
    })

    it("preserves missing optional template literals", () => {
      const template = Schema.optionalKey(Schema.TemplateLiteral(["a", Schema.String]))
      const decodeTuple = SchemaParser.decodeUnknownExit(Schema.Tuple([template]))
      const decodeStruct = SchemaParser.decodeUnknownExit(Schema.Struct({ value: template }))

      const tuple = decodeTuple([])
      assertTrue(Exit.isSuccess(tuple))
      strictEqual(tuple.value.length, 0)

      const struct = decodeStruct({})
      assertTrue(Exit.isSuccess(struct))
      assertTrue(!Object.hasOwn(struct.value, "value"))
    })

    it("reads property and index values once", () => {
      let propertyReads = 0
      let indexReads = 0
      const propertyInput = {
        get value(): unknown {
          propertyReads++
          return propertyReads === 1 ? "a" : 1
        }
      }
      const indexInput = {
        get value(): unknown {
          indexReads++
          return indexReads === 1 ? "a" : 1
        }
      }

      const property = SchemaParser.decodeUnknownExit(Schema.Struct({ value: Schema.String }))(propertyInput)
      assertTrue(Exit.isSuccess(property))
      strictEqual(property.value.value, "a")
      strictEqual(propertyReads, 1)

      const index = SchemaParser.decodeUnknownExit(Schema.Record(Schema.String, Schema.String))(indexInput)
      assertTrue(Exit.isSuccess(index))
      strictEqual(index.value.value, "a")
      strictEqual(indexReads, 1)

      let rejectedReads = 0
      const rejectedKey = Schema.String.pipe(Schema.decode({
        decode: new SchemaGetter.Getter(() => Effect.fail(new SchemaIssue.InvalidValue())),
        encode: SchemaGetter.passthrough()
      }))
      const rejectedInput = {
        get value(): unknown {
          rejectedReads++
          return "a"
        }
      }
      const rejected = SchemaParser.decodeUnknownExit(Schema.Record(rejectedKey, Schema.String))(rejectedInput)
      assertTrue(Exit.isFailure(rejected))
      strictEqual(rejectedReads, 0)
    })

    it("keeps synchronous transformations eager", () => {
      const effect = SchemaParser.decodeUnknownEffect(Schema.NumberFromString)("1")
      assertTrue(Exit.isExit(effect))
      assertTrue(Exit.isSuccess(effect))
      strictEqual(effect.value, 1)
    })

    it("rejects a missing root output", () => {
      const schema = Schema.String.pipe(Schema.decode({
        decode: new SchemaGetter.Getter(() => Effect.succeedNone),
        encode: SchemaGetter.passthrough()
      }))
      const result = SchemaParser.decodeUnknownExit(schema)("value")

      assertTrue(Exit.isFailure(result))
    })

    it("rejects a missing root output after parsing structural schemas", () => {
      const missing = new SchemaGetter.Getter<never, unknown>(() => Effect.succeedNone)
      const array = Schema.Array(Schema.String).pipe(Schema.decode({
        decode: missing,
        encode: missing
      }))
      const struct = Schema.Struct({ value: Schema.String }).pipe(Schema.decode({
        decode: missing,
        encode: missing
      }))

      assertTrue(Exit.isFailure(SchemaParser.decodeUnknownExit(array)(["value"])))
      assertTrue(Exit.isFailure(SchemaParser.encodeUnknownExit(array)(["value"])))
      assertTrue(Exit.isFailure(SchemaParser.decodeUnknownExit(struct)({ value: "value" })))
      assertTrue(Exit.isFailure(SchemaParser.encodeUnknownExit(struct)({ value: "value" })))
    })

    it("rejects an invalid root without compiling deeply nested structural parsers", () => {
      let array: Schema.Codec<unknown> = Schema.String
      let struct: Schema.Codec<unknown> = Schema.String
      for (let i = 0; i < 5_000; i++) {
        array = Schema.Array(array)
        struct = Schema.Struct({ value: struct })
      }

      assertTrue(Exit.isFailure(SchemaParser.decodeUnknownExit(array)(null)))
      assertTrue(Exit.isFailure(SchemaParser.decodeUnknownExit(struct)(null)))
    })

    it("stops outer checks after an aborting check in a FilterGroup", () => {
      let innerRuns = 0
      let outerRuns = 0
      const group = Schema.makeFilter(() => false).abort().and(
        Schema.makeFilter(() => {
          innerRuns++
          return false
        })
      )
      const schema = Schema.String.check(
        group,
        Schema.makeFilter(() => {
          outerRuns++
          return false
        })
      )

      const result = SchemaParser.decodeUnknownExit(schema, { errors: "all" })("value")

      assertTrue(Exit.isFailure(result))
      strictEqual(innerRuns, 0)
      strictEqual(outerRuns, 0)
    })

    it.effect("preserves unchanged values through asynchronous middleware", () =>
      Effect.gen(function*() {
        const schema = Schema.String.pipe(
          Schema.middlewareDecoding((effect) => Effect.yieldNow.pipe(Effect.andThen(effect)))
        )

        strictEqual(yield* SchemaParser.decodeUnknownEffect(schema)("value"), "value")
      }))

    it.effect("wraps an asynchronous failure from a uniquely selected union member", () =>
      Effect.gen(function*() {
        const failing = Schema.String.pipe(Schema.decode({
          decode: new SchemaGetter.Getter(() =>
            Effect.yieldNow.pipe(
              Effect.andThen(Effect.fail(new SchemaIssue.InvalidValue()))
            )
          ),
          encode: SchemaGetter.passthrough()
        }))
        const schema = Schema.Union([
          Schema.Struct({ kind: Schema.Literal("a"), value: Schema.String }),
          Schema.Struct({ kind: Schema.Literal("b"), value: failing })
        ])

        const exit = yield* Effect.exit(
          SchemaParser.decodeUnknownEffect(schema)({ kind: "b", value: "value" })
        )
        assertTrue(Exit.isFailure(exit))
        const error = Cause.findError(exit.cause)
        assertTrue(Result.isSuccess(error))
        strictEqual(error.success._tag, "AnyOf")
      }))

    it.effect("resolves an unchanged concurrent union candidate", () =>
      Effect.gen(function*() {
        const delayedFailure = Schema.String.pipe(Schema.decode({
          decode: new SchemaGetter.Getter(() =>
            Effect.yieldNow.pipe(
              Effect.andThen(Effect.fail(new SchemaIssue.InvalidValue()))
            )
          ),
          encode: SchemaGetter.passthrough()
        }))
        const schema = Schema.Union([delayedFailure, Schema.String])

        strictEqual(
          yield* SchemaParser.decodeUnknownEffect(schema)("value", { concurrency: 2 }),
          "value"
        )
      }))

    it("does not replay eager fields after encountering a suspended transformation", () => {
      const calls: Array<string> = []
      const field = (name: string, suspended = false) =>
        Schema.String.pipe(Schema.decode({
          decode: new SchemaGetter.Getter((input) => {
            calls.push(name)
            return suspended ? Effect.suspend(() => Effect.succeed(input)) : Effect.succeed(input)
          }),
          encode: SchemaGetter.passthrough()
        }))
      const schema = Schema.Struct({
        a: field("a"),
        b: field("b", true),
        c: field("c")
      })

      const exit = SchemaParser.decodeUnknownExit(schema)({ a: "a", b: "b", c: "c" })

      assertTrue(Exit.isSuccess(exit))
      strictEqual(calls.join(","), "a,b,c")
    })

    it("converts synchronous property parser throws into defects", () => {
      const field = Schema.declareConstructor<string>()([], () => () => {
        throw new Error("property defect")
      })
      const schema = Schema.Struct({ field })

      const exit = SchemaParser.decodeUnknownExit(schema)({ field: "value" })

      assertTrue(Exit.isFailure(exit))
      assertTrue(Cause.hasDies(exit.cause))
    })

    it("keeps encoding-link parser compilation lazy for Suspend", () => {
      let evaluations = 0
      const schema = Schema.suspend(() => {
        evaluations++
        return Schema.String
      }).pipe(Schema.decode({
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough()
      }))

      const decode = SchemaParser.decodeUnknownExit(schema)
      strictEqual(evaluations, 0)
      strictEqual(decode("a")._tag, "Success")
      strictEqual(evaluations, 1)
      strictEqual(decode("b")._tag, "Success")
      strictEqual(evaluations, 1)
    })

    it("keeps direct Suspend parser compilation lazy", () => {
      let evaluations = 0
      const schema = Schema.suspend(() => {
        evaluations++
        return Schema.String
      })

      const decode = SchemaParser.decodeUnknownExit(schema)
      strictEqual(evaluations, 0)
      strictEqual(decode("a")._tag, "Success")
      strictEqual(evaluations, 1)
      strictEqual(decode("b")._tag, "Success")
      strictEqual(evaluations, 1)
    })

    it("supports mutually recursive Suspend parsers", () => {
      interface A {
        readonly _tag: "A"
        readonly next: string | B
      }
      interface B {
        readonly _tag: "B"
        readonly next: string | A
      }
      const A = Schema.Struct({
        _tag: Schema.Literal("A"),
        next: Schema.Union([Schema.String, Schema.suspend((): Schema.Codec<B> => B)])
      })
      const B = Schema.Struct({
        _tag: Schema.Literal("B"),
        next: Schema.Union([Schema.String, Schema.suspend((): Schema.Codec<A> => A)])
      })
      const decode = SchemaParser.decodeUnknownExit(A)

      strictEqual(decode({ _tag: "A", next: { _tag: "B", next: { _tag: "A", next: "end" } } })._tag, "Success")
    })

    it("keeps Declaration parser compilation lazy and shared by AST identity", () => {
      let evaluations = 0
      const schema = Schema.declareConstructor<unknown>()([], () => {
        evaluations++
        return (input) => Effect.succeed(input)
      })

      const decode = SchemaParser.decodeUnknownExit(schema)
      const decodeAgain = SchemaParser.decodeUnknownExit(schema)
      strictEqual(evaluations, 0)
      strictEqual(decode("a")._tag, "Success")
      strictEqual(evaluations, 1)
      strictEqual(decodeAgain("b")._tag, "Success")
      strictEqual(evaluations, 1)
    })

    it("keeps untried Declaration union members lazy", () => {
      let evaluations = 0
      const declaration = Schema.declareConstructor<unknown>()([], () => {
        evaluations++
        return (input) => Effect.succeed(input)
      })
      const decode = SchemaParser.decodeUnknownExit(Schema.Union([Schema.Literal("a"), declaration]))

      strictEqual(decode("a")._tag, "Success")
      strictEqual(evaluations, 0)
      strictEqual(decode("b")._tag, "Success")
      strictEqual(evaluations, 1)
    })

    it("keeps encode-side Declaration and Suspend parser compilation lazy", () => {
      let declarationEvaluations = 0
      let suspendEvaluations = 0
      const declaration = Schema.declareConstructor<unknown>()([], () => {
        declarationEvaluations++
        return (input) => Effect.succeed(input)
      })
      const suspend = Schema.suspend(() => {
        suspendEvaluations++
        return Schema.String
      })

      const encodeDeclaration = SchemaParser.encodeUnknownExit(declaration)
      const encodeSuspend = SchemaParser.encodeUnknownExit(suspend)
      strictEqual(declarationEvaluations, 0)
      strictEqual(suspendEvaluations, 0)
      strictEqual(encodeDeclaration("a")._tag, "Success")
      strictEqual(encodeSuspend("a")._tag, "Success")
      strictEqual(declarationEvaluations, 1)
      strictEqual(suspendEvaluations, 1)
      strictEqual(encodeDeclaration("b")._tag, "Success")
      strictEqual(encodeSuspend("b")._tag, "Success")
      strictEqual(declarationEvaluations, 1)
      strictEqual(suspendEvaluations, 1)
    })

    it("retries lazy parser compilation after a synchronous factory failure", () => {
      let evaluations = 0
      const schema = Schema.declareConstructor<unknown>()([], () => {
        if (++evaluations === 1) {
          throw new Error("factory failure")
        }
        return (input) => Effect.succeed(input)
      })
      const decode = SchemaParser.decodeUnknownExit(schema)

      throws(() => decode("a"), (error) => {
        assertTrue(error instanceof Error)
        strictEqual(error.message, "factory failure")
      })
      strictEqual(decode("b")._tag, "Success")
      strictEqual(decode("c")._tag, "Success")
      strictEqual(evaluations, 2)
    })

    it("retries lazy Suspend parser compilation after a synchronous thunk failure", () => {
      let evaluations = 0
      const schema = Schema.suspend(() => {
        if (++evaluations === 1) {
          throw new Error("thunk failure")
        }
        return Schema.String
      })
      const decode = SchemaParser.decodeUnknownExit(schema)

      throws(() => decode("a"), (error) => {
        assertTrue(error instanceof Error)
        strictEqual(error.message, "thunk failure")
      })
      strictEqual(decode("b")._tag, "Success")
      strictEqual(decode("c")._tag, "Success")
      strictEqual(evaluations, 2)
    })

    it("should preserve mixed causes in union candidates instead of trying later candidates", () => {
      const failure = Schema.String.pipe(Schema.decode({
        decode: new SchemaGetter.Getter(() => Effect.failCause(makeMixedCause())),
        encode: SchemaGetter.passthrough()
      }))
      const schema = Schema.Union([
        failure,
        Schema.Literal("a")
      ])
      const taggedSchema = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), value: failure }),
        Schema.Struct({ kind: Schema.Literal("b"), value: Schema.String })
      ])

      for (
        const exit of [
          SchemaParser.decodeUnknownExit(schema)("a"),
          SchemaParser.decodeUnknownExit(taggedSchema)({ kind: "a", value: "a" })
        ] as ReadonlyArray<Exit.Exit<unknown, SchemaIssue.Issue>>
      ) {
        assertTrue(Exit.isFailure(exit))
        assertTrue(Exit.hasDies(exit))
        const error = Cause.findError(exit.cause)
        assertTrue(Result.isSuccess(error))
        assertTrue(SchemaIssue.isIssue(error.success))
      }
    })
  })
})
