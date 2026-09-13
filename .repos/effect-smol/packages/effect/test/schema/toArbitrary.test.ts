import { BigDecimal, Chunk, DateTime, Effect, HashMap, HashSet, Order, Schema, SchemaIssue } from "effect"
import { FastCheck, TestSchema } from "effect/testing"
import { describe, it } from "vitest"
import { assertInclude, assertInstanceOf, deepStrictEqual, strictEqual, throws } from "../utils/assert.ts"

function toArbitrary<S extends Schema.Constraint>(schema: S) {
  return Schema.toArbitrary(schema)(FastCheck)
}

function assertUnsupportedSchema(schema: Schema.Constraint, message: string) {
  throws(() => toArbitrary(schema), message)
}

function verifyGeneration<S extends Schema.ConstraintCodec<unknown, unknown>>(schema: S, numRuns?: number) {
  const asserts = new TestSchema.Asserts(schema)
  if (numRuns === undefined) {
    asserts.arbitrary().verifyGeneration()
  } else {
    asserts.arbitrary().verifyGeneration({ params: { numRuns } })
  }
}

// Guard for "fast but wrong" regressions: samples the derived arbitrary and
// asserts an output invariant (length/size/property-count bounds) over many runs.
function assertInvariant(schema: Schema.Constraint, predicate: (value: any) => boolean, numRuns = 200) {
  FastCheck.assert(FastCheck.property(toArbitrary(schema), predicate), { numRuns })
}

function assertRecursiveNoFiniteGenerationPath(schema: Schema.Constraint) {
  throws(
    () => toArbitrary(schema),
    (e) => {
      assertInstanceOf(e, Error)
      assertInclude(
        e.message,
        "Unable to derive an arbitrary for a recursive schema without a finite generation path"
      )
    }
  )
}

function minSizeOne<A>(size: (a: A) => number) {
  return Schema.makeFilter((a: A) => size(a) >= 1, {
    expected: "a value with a size of at least 1",
    arbitrary: {
      constraint: {
        minLength: 1
      }
    }
  })
}

function CustomArray<A extends Schema.Constraint>(
  value: A,
  toArbitrary: Schema.Annotations.ToArbitrary.Declaration<ReadonlyArray<A["Type"]>, readonly [A]>
) {
  return Schema.declareConstructor<ReadonlyArray<A["Type"]>>()(
    [value],
    () => (input, ast) =>
      globalThis.Array.isArray(input)
        ? Effect.succeed(input as ReadonlyArray<A["Type"]>)
        : Effect.fail(new SchemaIssue.InvalidType(ast)),
    { toArbitrary }
  )
}

describe("Arbitrary generation", () => {
  describe("Thrown errors", () => {
    it("Declaration", () => {
      assertUnsupportedSchema(
        Schema.Struct({ a: Schema.instanceOf(globalThis.URL) }),
        `Unsupported AST Declaration
  at ["a"]`
      )
    })

    it("Never", () => {
      assertUnsupportedSchema(
        Schema.Struct({ a: Schema.Never }),
        `Unsupported AST Never
  at ["a"]`
      )
    })

    it("impossible object property constraints", () => {
      assertUnsupportedSchema(
        Schema.Struct({ a: Schema.Number }).check(Schema.isMinProperties(2)),
        "Unable to derive an arbitrary for object property constraints"
      )
    })

    it("impossible object max property constraints", () => {
      assertUnsupportedSchema(
        Schema.Struct({ a: Schema.Number }).check(Schema.isMaxProperties(0)),
        "Unable to derive an arbitrary for object property constraints"
      )
    })

    it("impossible number constraints", () => {
      assertUnsupportedSchema(
        Schema.Number.check(Schema.isGreaterThan(1), Schema.isLessThan(1)),
        "Unable to derive an arbitrary for number constraints"
      )
    })

    it("impossible integer constraints", () => {
      assertUnsupportedSchema(
        Schema.Int.check(Schema.isGreaterThan(1), Schema.isLessThan(2)),
        "Unable to derive an arbitrary for integer constraints"
      )
    })

    it("impossible ordered bigint constraints", () => {
      assertUnsupportedSchema(
        Schema.BigInt.check(Schema.isGreaterThanBigInt(1n), Schema.isLessThanBigInt(2n)),
        "Unable to derive an arbitrary for the ordered bigint constraints"
      )
    })

    it("impossible array constraints", () => {
      assertUnsupportedSchema(
        Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(1)),
        "Unable to derive an arbitrary for array constraints"
      )
    })

    it("impossible size constraints", () => {
      assertUnsupportedSchema(
        Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(2), Schema.isMaxSize(1)),
        "Unable to derive an arbitrary for size constraints"
      )
    })
  })

  it("should pass the constraint to the override annotation", () => {
    let constraint: Schema.Annotations.ToArbitrary.GenerationConstraint | undefined
    const schema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      toArbitrary: () => (fc, ctx) => {
        constraint = ctx.constraint
        return fc.constant(1)
      }
    })
    verifyGeneration(schema)
    deepStrictEqual(constraint, {
      integer: true,
      ordered: {
        order: Order.Number,
        minimum: 1,
        maximum: 100
      }
    })
  })

  it("should keep noNaN and noInfinity as separate number constraints", () => {
    const constraints: Array<unknown> = []
    const fc = {
      ...FastCheck,
      float: (constraint?: Parameters<typeof FastCheck.float>[0]) => {
        constraints.push(constraint)
        return FastCheck.constant(0)
      }
    } as typeof FastCheck
    const noNaN = Schema.makeFilter((n: number) => !globalThis.Number.isNaN(n), {
      arbitrary: {
        constraint: {
          noNaN: true
        }
      }
    })
    const noInfinity = Schema.makeFilter(
      (n: number) => n !== globalThis.Number.POSITIVE_INFINITY && n !== globalThis.Number.NEGATIVE_INFINITY,
      {
        arbitrary: {
          constraint: {
            noInfinity: true
          }
        }
      }
    )

    Schema.toArbitrary(Schema.Number.check(noNaN))(fc)
    Schema.toArbitrary(Schema.Number.check(noInfinity))(fc)
    Schema.toArbitrary(Schema.Finite)(fc)

    deepStrictEqual(constraints, [
      { noNaN: true },
      { noDefaultInfinity: true },
      { noDefaultInfinity: true, noNaN: true }
    ])
  })

  it("should enforce opaque filters", () => {
    const schema = Schema.Struct({
      a: Schema.String.check(Schema.makeFilter((s: string) => s.length > 0, { expected: "a custom string" }))
    })
    const arbitrary = toArbitrary(schema)

    FastCheck.assert(FastCheck.property(arbitrary, (a) => a.a.length > 0), { numRuns: 5 })
  })

  describe("candidates", () => {
    it("should use filter candidates with the merged constraint context", () => {
      let constraint: Schema.Annotations.ToArbitrary.GenerationConstraint | undefined
      const schema = Schema.String.check(
        Schema.isMinLength(9),
        Schema.makeFilter((s: string) => s === "candidate", {
          expected: "candidate",
          arbitrary: {
            candidate: {
              make: (fc, ctx) => {
                constraint = ctx.constraint
                return fc.constant("candidate")
              }
            }
          }
        })
      )
      const arbitrary = toArbitrary(schema)

      deepStrictEqual(constraint, { minLength: 9 })
      FastCheck.assert(FastCheck.property(arbitrary, (s) => s === "candidate"), { numRuns: 20 })
    })

    it("should use filter group candidates", () => {
      const schema = Schema.String.check(
        Schema.makeFilterGroup(
          [
            Schema.makeFilter((s: string) => s.startsWith("a"), { expected: "starts with a" }),
            Schema.makeFilter((s: string) => s.endsWith("a"), { expected: "ends with a" })
          ],
          {
            arbitrary: {
              candidate: {
                make: (fc) => fc.constant("a")
              }
            }
          }
        )
      )
      const arbitrary = toArbitrary(schema)

      FastCheck.assert(FastCheck.property(arbitrary, (s) => s.startsWith("a") && s.endsWith("a")), { numRuns: 20 })
    })

    it("should allow candidates to be disabled for a context", () => {
      let calls = 0
      const schema = Schema.String.check(
        Schema.makeFilter(() => true, {
          arbitrary: {
            candidate: {
              make: () => {
                calls++
                return undefined
              }
            }
          }
        })
      )
      toArbitrary(schema)

      strictEqual(calls, 1)
    })

    it("should fail fast for invalid candidate weights", () => {
      const makeSchema = (weight: number) =>
        Schema.String.check(
          Schema.makeFilter(() => true, {
            arbitrary: {
              candidate: {
                weight,
                make: (fc) => fc.constant("candidate")
              }
            }
          })
        )

      throws(
        () => toArbitrary(makeSchema(0)),
        "Unable to derive an arbitrary for a candidate with an invalid weight"
      )
      throws(
        () => toArbitrary(makeSchema(0.5)),
        "Unable to derive an arbitrary for a candidate with an invalid weight"
      )
    })
  })

  describe("object property counts", () => {
    it("enforces minProperties on optional-only structs", () => {
      const schema = Schema.Struct({
        a: Schema.optionalKey(Schema.String),
        b: Schema.optionalKey(Schema.String),
        c: Schema.optionalKey(Schema.String)
      }).check(Schema.isMinProperties(2))
      FastCheck.assert(
        FastCheck.property(toArbitrary(schema), (o) => globalThis.Object.keys(o).length >= 2),
        { numRuns: 100 }
      )
      verifyGeneration(schema)
    })

    it("enforces maxProperties on optional-only structs", () => {
      const schema = Schema.Struct({
        a: Schema.optionalKey(Schema.String),
        b: Schema.optionalKey(Schema.String),
        c: Schema.optionalKey(Schema.String)
      }).check(Schema.isMaxProperties(1))
      FastCheck.assert(
        FastCheck.property(toArbitrary(schema), (o) => globalThis.Object.keys(o).length <= 1),
        { numRuns: 100 }
      )
      verifyGeneration(schema)
    })

    it("enforces minProperties with symbol optional keys", () => {
      const key = Symbol.for("toArbitrary/optional")
      const schema = Schema.Struct({
        [key]: Schema.optionalKey(Schema.String),
        b: Schema.optionalKey(Schema.String)
      }).check(Schema.isMinProperties(2))
      FastCheck.assert(
        FastCheck.property(toArbitrary(schema), (o) =>
          globalThis.Reflect.ownKeys(o).length >= 2 &&
          globalThis.Object.hasOwn(o, key)),
        { numRuns: 100 }
      )
      verifyGeneration(schema)
    })

    it("enforces a property-count range with required and optional keys", () => {
      const schema = Schema.Struct({
        r: Schema.String,
        a: Schema.optionalKey(Schema.String),
        b: Schema.optionalKey(Schema.String),
        c: Schema.optionalKey(Schema.String)
      }).check(Schema.isPropertiesLengthBetween(2, 3))
      FastCheck.assert(
        FastCheck.property(toArbitrary(schema), (o) => {
          const n = globalThis.Object.keys(o).length
          return n >= 2 && n <= 3
        }),
        { numRuns: 100 }
      )
      verifyGeneration(schema)
    })

    it("fails fast when optional keys cannot satisfy minProperties", () => {
      assertUnsupportedSchema(
        Schema.Struct({ r: Schema.String, a: Schema.optionalKey(Schema.String) }).check(Schema.isMinProperties(3)),
        "Unable to derive an arbitrary for object property constraints"
      )
    })

    it("fails fast when required keys already exceed maxProperties", () => {
      assertUnsupportedSchema(
        Schema.Struct({ r: Schema.String, a: Schema.optionalKey(Schema.String) }).check(Schema.isMaxProperties(0)),
        "Unable to derive an arbitrary for object property constraints"
      )
    })

    // Regression guard: with the previous discard-based generation, requiring
    // every optional key to be present is astronomically unlikely (~0.75 ** 64),
    // so sampling would effectively hang. The count-controlled subset generates
    // these instantly.
    it("generates dense optional-key structs without excessive filtering", () => {
      const fields: Record<string, Schema.optionalKey<typeof Schema.String>> = {}
      for (let i = 0; i < 64; i++) {
        fields[`k${i}`] = Schema.optionalKey(Schema.String)
      }
      const schema = Schema.Struct(fields).check(Schema.isMinProperties(64))
      FastCheck.assert(
        FastCheck.property(toArbitrary(schema), (o) => globalThis.Object.keys(o).length === 64),
        { numRuns: 100 }
      )
    })
  })

  it("Any", () => {
    verifyGeneration(Schema.Any)
  })

  it("Unknown", () => {
    verifyGeneration(Schema.Unknown)
  })

  it("Void", () => {
    verifyGeneration(Schema.Void)
  })

  it("Null", () => {
    verifyGeneration(Schema.Null)
  })

  it("String", () => {
    verifyGeneration(Schema.String)
  })

  it("Number", () => {
    verifyGeneration(Schema.Number)
  })

  it("Boolean", () => {
    verifyGeneration(Schema.Boolean)
  })

  it("BigInt", () => {
    verifyGeneration(Schema.BigInt)
  })

  it("Symbol", () => {
    verifyGeneration(Schema.Symbol)
  })

  it("UniqueSymbol", () => {
    verifyGeneration(Schema.UniqueSymbol(Symbol.for("a")))
  })

  it("ObjectKeyword", () => {
    verifyGeneration(Schema.ObjectKeyword)
  })

  describe("Literal", () => {
    it("string", () => {
      verifyGeneration(Schema.Literal("a"))
    })

    it("number", () => {
      verifyGeneration(Schema.Literal(1))
    })

    it("boolean", () => {
      verifyGeneration(Schema.Literal(true))
    })

    it("bigint", () => {
      verifyGeneration(Schema.Literal(1n))
    })
  })

  it("Literals", () => {
    verifyGeneration(Schema.Literals(["a", "b", "c"]))
  })

  describe("TemplateLiteral", () => {
    it("a", () => {
      const schema = Schema.TemplateLiteral([Schema.Literal("a")])
      verifyGeneration(schema)
    })

    it("a b", () => {
      const schema = Schema.TemplateLiteral([Schema.Literal("a"), Schema.Literal(" "), Schema.Literal("b")])
      verifyGeneration(schema)
    })

    it("a${string}", () => {
      const schema = Schema.TemplateLiteral([Schema.Literal("a"), Schema.String])
      verifyGeneration(schema)
    })

    it("a${number}", () => {
      const schema = Schema.TemplateLiteral([Schema.Literal("a"), Schema.Number])
      verifyGeneration(schema)
    })

    it("${number} excludes non-finite values", () => {
      const schema = Schema.TemplateLiteral([Schema.Number])
      assertInvariant(schema, (s) => s !== "NaN" && s !== "Infinity" && s !== "-Infinity")
    })

    it("${number | \"a\"} excludes non-finite values", () => {
      const schema = Schema.TemplateLiteral([Schema.Union([Schema.Number, Schema.Literal("a")])])
      assertInvariant(schema, (s) => s !== "NaN" && s !== "Infinity" && s !== "-Infinity")
    })

    it("a", () => {
      const schema = Schema.TemplateLiteral([Schema.Literal("a")])
      verifyGeneration(schema)
    })

    it("${string}", () => {
      const schema = Schema.TemplateLiteral([Schema.String])
      verifyGeneration(schema)
    })

    it("a${string}b", () => {
      const schema = Schema.TemplateLiteral([Schema.Literal("a"), Schema.String, Schema.Literal("b")])
      verifyGeneration(schema)
    })

    it("user_${uuid}", () => {
      const schema = Schema.TemplateLiteral(["user_", Schema.String.check(Schema.isUUID())])
      verifyGeneration(schema)
    })

    it("https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html", async () => {
      const EmailLocaleIDs = Schema.Literals(["welcome_email", "email_heading"])
      const FooterLocaleIDs = Schema.Literals(["footer_title", "footer_sendoff"])
      const schema = Schema.TemplateLiteral([Schema.Union([EmailLocaleIDs, FooterLocaleIDs]), "_id"])
      verifyGeneration(schema)
    })

    it("< + h + (1|2) + >", async () => {
      const schema = Schema.TemplateLiteral([
        Schema.Literal("<"),
        Schema.TemplateLiteral([Schema.Literal("h"), Schema.Union([Schema.Literal(1), Schema.Literal(2)])]),
        Schema.Literal(">")
      ])
      verifyGeneration(schema)
    })
  })

  describe("Enum", () => {
    it("Numeric enum", () => {
      enum Fruits {
        Apple,
        Banana
      }
      verifyGeneration(Schema.Enum(Fruits))
    })

    it("String enum", () => {
      enum Fruits {
        Apple = "apple",
        Banana = "banana",
        Cantaloupe = 0
      }
      verifyGeneration(Schema.Enum(Fruits))
    })

    it("Const enum", () => {
      const Fruits = {
        Apple: "apple",
        Banana: "banana",
        Cantaloupe: 3
      } as const
      verifyGeneration(Schema.Enum(Fruits))
    })
  })

  it("Union", () => {
    verifyGeneration(
      Schema.Union([Schema.String, Schema.Number])
    )
  })

  describe("Tuple", () => {
    it("empty", () => {
      verifyGeneration(
        Schema.Tuple([])
      )
    })

    it("required element", () => {
      verifyGeneration(
        Schema.Tuple([Schema.String])
      )
      verifyGeneration(
        Schema.Tuple([Schema.String, Schema.Number])
      )
    })

    it("optionalKey element", () => {
      verifyGeneration(
        Schema.Tuple([Schema.optionalKey(Schema.Number)])
      )
      verifyGeneration(
        Schema.Tuple([Schema.String, Schema.optionalKey(Schema.Number)])
      )
    })

    it("optional element", () => {
      verifyGeneration(
        Schema.Tuple([Schema.optional(Schema.Number)])
      )
      verifyGeneration(
        Schema.Tuple([Schema.String, Schema.optional(Schema.Number)])
      )
    })

    it("generates values valid for optional tuple positions", () => {
      const schema = Schema.Tuple([
        Schema.optionalKey(Schema.String),
        Schema.optionalKey(Schema.Number)
      ])

      FastCheck.assert(FastCheck.property(toArbitrary(schema), Schema.is(schema)), {
        numRuns: 100,
        seed: 17
      })
    })
  })

  describe("Array", () => {
    it("Array", () => {
      verifyGeneration(Schema.Array(Schema.String))
    })
  })

  it("TupleWithRest", () => {
    verifyGeneration(
      Schema.TupleWithRest(Schema.Tuple([Schema.Boolean]), [Schema.Number, Schema.String])
    )
    verifyGeneration(
      Schema.TupleWithRest(Schema.Tuple([]), [Schema.Number, Schema.String])
    )
    verifyGeneration(
      Schema.TupleWithRest(Schema.Tuple([Schema.optionalKey(Schema.Boolean)]), [Schema.Number]).check(
        Schema.isMinLength(3)
      )
    )
  })

  describe("Struct", () => {
    it("empty", () => {
      verifyGeneration(Schema.Struct({}))
    })

    it("required fields", () => {
      verifyGeneration(Schema.Struct({
        a: Schema.String
      }))
      verifyGeneration(Schema.Struct({
        a: Schema.String,
        b: Schema.Number
      }))
    })

    it("required field with undefined", () => {
      verifyGeneration(Schema.Struct({
        a: Schema.UndefinedOr(Schema.String)
      }))
    })

    it("optionalKey field", () => {
      verifyGeneration(Schema.Struct({
        a: Schema.optionalKey(Schema.String)
      }))
    })

    it("optional field", () => {
      verifyGeneration(Schema.Struct({
        a: Schema.optional(Schema.String)
      }))
    })
  })

  describe("Record", () => {
    it("Record(String, Number)", () => {
      verifyGeneration(Schema.Record(Schema.String, Schema.Number))
    })

    it("Record(Symbol, Number)", () => {
      verifyGeneration(Schema.Record(Schema.Symbol, Schema.Number))
    })
  })

  it("StructWithRest", () => {
    verifyGeneration(Schema.StructWithRest(
      Schema.Struct({ a: Schema.Number }),
      [Schema.Record(Schema.String, Schema.Number)]
    ))
    verifyGeneration(Schema.StructWithRest(
      Schema.Struct({ a: Schema.Number }),
      [Schema.Record(Schema.Symbol, Schema.Number)]
    ))
  })

  describe("Class", () => {
    it("Class", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String
      }) {}
      const schema = A
      verifyGeneration(schema)
    })
  })

  describe("suspend", () => {
    it("Tuple", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema = Schema.Tuple([
        Schema.Number,
        Schema.NullOr(Rec)
      ])
      verifyGeneration(schema)
    })

    it("Array", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Array(Schema.Union([Schema.String, Rec]))
      verifyGeneration(schema)
    })

    it("Struct", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema = Schema.Struct({
        a: Schema.String,
        as: Schema.Array(Rec)
      })
      verifyGeneration(schema)
    })

    it("Record", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema = Schema.Record(Schema.String, Rec)
      verifyGeneration(schema)
    })

    it("optional", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Struct({
        a: Schema.optional(Rec)
      })
      verifyGeneration(schema)
    })

    it("Array + Array", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Struct({
        a: Schema.Array(Rec),
        b: Schema.Array(Rec)
      })
      verifyGeneration(schema)
    })

    it("optional + Array", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Struct({
        a: Schema.optional(Rec),
        b: Schema.Array(Rec)
      })
      verifyGeneration(schema)
    })

    it("required recursive field without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Struct({
        a: Rec
      })
      throws(
        () => toArbitrary(schema),
        (e) => {
          assertInstanceOf(e, Error)
          assertInclude(
            e.message,
            "Unable to derive an arbitrary for a recursive schema without a finite generation path"
          )
          assertInclude(e.message, `at ["a"]`)
        }
      )
    })

    it("non-empty recursive array without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Array(Rec).check(Schema.isMinLength(1))
      throws(
        () => toArbitrary(schema),
        (e) => {
          assertInstanceOf(e, Error)
          assertInclude(
            e.message,
            "Unable to derive an arbitrary for a recursive schema without a finite generation path"
          )
          assertInclude(e.message, "at [0]")
        }
      )
    })

    it("optional-key recursive tuple made non-empty without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Tuple([Schema.optionalKey(Rec)]).check(Schema.isMinLength(1))
      assertRecursiveNoFiniteGenerationPath(schema)
    })

    it("optional-key recursive struct made non-empty without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Struct({
        a: Schema.optionalKey(Rec)
      }).check(Schema.isMinProperties(1))
      assertRecursiveNoFiniteGenerationPath(schema)
    })

    it("purely recursive tuple rest made non-empty without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Rec]).check(Schema.isMinLength(2))
      assertRecursiveNoFiniteGenerationPath(schema)
    })

    // Regression guard: the terminal rest branch must honor the remaining
    // minLength after fixed elements. Otherwise it generates an empty rest, the
    // value fails the minLength filter, and sampling hangs.
    it("non-empty recursive tuple rest with a finite union branch", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.TupleWithRest(
        Schema.Tuple([Schema.String]),
        [Schema.Union([Schema.Number, Rec])]
      ).check(Schema.isMinLength(2))
      FastCheck.assert(
        FastCheck.property(toArbitrary(schema), (a) => (a as Array<unknown>).length >= 2),
        { numRuns: 100 }
      )
    })

    it("should use filter candidates in recursive terminal paths", () => {
      const Leaf = Schema.String.check(
        Schema.makeFilter((s: string) => s === "leaf", {
          expected: "leaf",
          arbitrary: {
            candidate: {
              make: (fc) => fc.constant("leaf")
            }
          }
        })
      )
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Union([
        Leaf,
        Schema.Array(Rec).check(Schema.isMinLength(1))
      ])

      verifyGeneration(schema, 20)
    })

    it("non-empty recursive ReadonlySet without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.ReadonlySet(Rec).check(Schema.isMinSize(1))
      assertRecursiveNoFiniteGenerationPath(schema)
    })

    it("non-empty recursive HashSet without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.HashSet(Rec).check(minSizeOne(HashSet.size))
      assertRecursiveNoFiniteGenerationPath(schema)
    })

    it("non-empty recursive Chunk without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Chunk(Rec).check(minSizeOne(Chunk.size))
      assertRecursiveNoFiniteGenerationPath(schema)
    })

    it("non-empty recursive ReadonlyMap without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.ReadonlyMap(Schema.String, Rec).check(Schema.isMinSize(1))
      assertRecursiveNoFiniteGenerationPath(schema)
    })

    it("non-empty recursive HashMap without finite generation path", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.HashMap(Schema.String, Rec).check(minSizeOne(HashMap.size))
      assertRecursiveNoFiniteGenerationPath(schema)
    })

    it("non-empty recursive collections with finite union branches", () => {
      const SetRec = Schema.suspend((): Schema.Codec<unknown> => setSchema)
      const setSchema: any = Schema.ReadonlySet(Schema.Union([Schema.String, SetRec])).check(Schema.isMinSize(1))
      verifyGeneration(setSchema, 20)

      const HashSetRec = Schema.suspend((): Schema.Codec<unknown> => hashSetSchema)
      const hashSetSchema: any = Schema.HashSet(Schema.Union([Schema.String, HashSetRec])).check(
        minSizeOne(HashSet.size)
      )
      verifyGeneration(hashSetSchema, 20)

      const ChunkRec = Schema.suspend((): Schema.Codec<unknown> => chunkSchema)
      const chunkSchema: any = Schema.Chunk(Schema.Union([Schema.String, ChunkRec])).check(minSizeOne(Chunk.size))
      verifyGeneration(chunkSchema, 20)

      const MapRec = Schema.suspend((): Schema.Codec<unknown> => mapSchema)
      const mapSchema: any = Schema.ReadonlyMap(Schema.String, Schema.Union([Schema.Number, MapRec])).check(
        Schema.isMinSize(1)
      )
      verifyGeneration(mapSchema, 20)

      const HashMapRec = Schema.suspend((): Schema.Codec<unknown> => hashMapSchema)
      const hashMapSchema: any = Schema.HashMap(Schema.String, Schema.Union([Schema.Number, HashMapRec])).check(
        minSizeOne(HashMap.size)
      )
      verifyGeneration(hashMapSchema, 20)
    })

    it("custom generic declaration with an explicit terminal branch", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = CustomArray(Rec, ([value]) => (fc, ctx) => {
        const terminal = fc.constant([])
        const arbitrary = fc.array(value.arbitrary, { maxLength: 2 })
        return {
          arbitrary: ctx.recursion === undefined ? arbitrary : fc.oneof(ctx.recursion, terminal, arbitrary),
          terminal
        }
      })

      verifyGeneration(schema, 20)
    })

    it("custom generic declaration without a terminal branch", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = CustomArray(Rec, ([value]) => (fc) => {
        return fc.array(value.arbitrary, { minLength: 1, maxLength: 1 })
      })

      assertRecursiveNoFiniteGenerationPath(schema)
    })

    it("mutually suspended schemas", () => {
      interface Expression {
        readonly type: "expression"
        readonly value: number | Operation
      }

      interface Operation {
        readonly type: "operation"
        readonly operator: "+" | "-"
        readonly left: Expression
        readonly right: Expression
      }

      const Expression = Schema.Struct({
        type: Schema.Literal("expression"),
        value: Schema.Union([Schema.Finite, Schema.suspend((): Schema.Codec<Operation> => Operation)])
      })

      const Operation = Schema.Struct({
        type: Schema.Literal("operation"),
        operator: Schema.Literals(["+", "-"]),
        left: Expression,
        right: Expression
      })
      verifyGeneration(Operation)
    })

    it("Option", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema = Schema.Struct({
        a: Schema.String,
        as: Schema.Option(Rec)
      })
      verifyGeneration(schema)
    })

    it("ReadonlySet", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema = Schema.ReadonlySet(Rec)
      verifyGeneration(schema)
    })

    it("ReadonlyMap", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema = Schema.ReadonlyMap(Schema.String, Rec)
      verifyGeneration(schema)
    })

    it("HashMap", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema = Schema.HashMap(Schema.String, Rec)
      verifyGeneration(schema)
    })
  })

  // Extended safety net for the recursion × constraint code paths (terminal
  // length minimization, optional inclusion, rest minLength, constraint
  // merging). Each test asserts an output invariant over many runs: a refactor
  // that makes generation "fast but wrong" (a value that violates the
  // constraint) fails here cleanly.
  describe("recursion × constraint guards", () => {
    it("recursive array with a finite branch honors minLength", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Array(Schema.Union([Schema.String, Rec])).check(Schema.isMinLength(2))
      assertInvariant(schema, (a) => globalThis.Array.isArray(a) && a.length >= 2)
    })

    it("recursive tuple rest with a post-rest element honors minLength", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.TupleWithRest(
        Schema.Tuple([Schema.String]),
        [Schema.Union([Schema.Number, Rec]), Schema.Boolean]
      ).check(Schema.isMinLength(3))
      assertInvariant(schema, (a) => (a as Array<unknown>).length >= 3)
    })

    it("recursive struct with required + optional self-ref honors minProperties", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Struct({
        a: Schema.String,
        self: Schema.optionalKey(Rec)
      }).check(Schema.isMinProperties(1))
      assertInvariant(
        schema,
        (o) => globalThis.Object.keys(o).length >= 1 && globalThis.Object.hasOwn(o, "a")
      )
    })

    it("recursive record value with a finite branch honors minProperties", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.Record(Schema.String, Schema.Union([Schema.Number, Rec])).check(
        Schema.isMinProperties(1)
      )
      assertInvariant(schema, (o) => globalThis.Object.keys(o).length >= 1)
    })

    it("recursive ReadonlySet with a finite branch honors minSize", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.ReadonlySet(Schema.Union([Schema.String, Rec])).check(Schema.isMinSize(1))
      assertInvariant(schema, (s: any) => s.size >= 1)
    })

    it("recursive ReadonlyMap with a finite branch honors minSize", () => {
      const Rec = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: any = Schema.ReadonlyMap(Schema.String, Schema.Union([Schema.Number, Rec])).check(
        Schema.isMinSize(1)
      )
      assertInvariant(schema, (m: any) => m.size >= 1)
    })

    it("merges multiple minLength filters (takes the maximum)", () => {
      const schema = Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMinLength(4))
      assertInvariant(schema, (a: any) => a.length >= 4)
    })

    it("merges minLength and maxLength filters into a range", () => {
      const schema = Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(5))
      assertInvariant(schema, (a: any) => a.length >= 2 && a.length <= 5)
    })

    it("merges ordered numeric bounds from multiple filters", () => {
      const schema = Schema.Number.check(Schema.isGreaterThan(3), Schema.isLessThan(10))
      assertInvariant(schema, (n: any) => n > 3 && n < 10, 300)
    })
  })

  describe("checks", () => {
    it("isMinLength(2)", () => {
      verifyGeneration(Schema.String.pipe(Schema.check(Schema.isMinLength(2))))
      verifyGeneration(Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(2))))
    })

    it("isMaxLength(2)", () => {
      verifyGeneration(Schema.String.pipe(Schema.check(Schema.isMaxLength(2))))
      verifyGeneration(Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(2))))
    })

    it("isMinLength(2) & isMaxLength(4)", () => {
      verifyGeneration(Schema.String.pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(4))))
      verifyGeneration(
        Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(4)))
      )
    })

    it("isLength(2)", () => {
      verifyGeneration(Schema.String.pipe(Schema.check(Schema.isLengthBetween(2, 2))))
      verifyGeneration(Schema.Array(Schema.String).pipe(Schema.check(Schema.isLengthBetween(2, 2))))
    })

    it("isMinProperties(2)", () => {
      verifyGeneration(
        Schema.Record(Schema.String, Schema.Number).check(Schema.isMinProperties(2))
      )
    })

    it("isMaxProperties(2)", () => {
      verifyGeneration(
        Schema.Record(Schema.String, Schema.Number).check(Schema.isMaxProperties(2))
      )
    })

    it("isMinProperties(2) & isMaxProperties(4)", () => {
      verifyGeneration(
        Schema.Record(Schema.String, Schema.Number).check(Schema.isMinProperties(2), Schema.isMaxProperties(4))
      )
    })

    it("isPropertiesLengthBetween(2, 2)", () => {
      verifyGeneration(
        Schema.Record(Schema.String, Schema.Number).check(Schema.isPropertiesLengthBetween(2, 2))
      )
    })

    it("isBetween(1, 100)", () => {
      verifyGeneration(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
    })

    it("isInt", () => {
      verifyGeneration(Schema.Number.check(Schema.isInt()))
    })

    it("isInt & isBetween(1, 100)", () => {
      verifyGeneration(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
    })

    it("isInt & isGreaterThan(1.2)", () => {
      verifyGeneration(Schema.Int.check(Schema.isGreaterThan(1.2)))
    })

    it("isInt & isLessThan(10.8)", () => {
      verifyGeneration(Schema.Int.check(Schema.isLessThan(10.8)))
    })

    it("isInt & isBetween(1, 10) with exclusive bounds", () => {
      verifyGeneration(Schema.Int.check(Schema.isBetween({
        minimum: 1,
        maximum: 10,
        exclusiveMinimum: true,
        exclusiveMaximum: true
      })))
    })

    it("isInt32", () => {
      verifyGeneration(Schema.Number.check(Schema.isInt32()))
    })

    it("isPattern", () => {
      verifyGeneration(Schema.String.check(Schema.isPattern(/^[A-Z]{3}[0-9]{3}$/)))
    })

    it("isNonEmpty + isPattern", () => {
      verifyGeneration(Schema.NonEmptyString.check(Schema.isPattern(/^[-]*$/)))
    })

    it("isPattern + isPattern", () => {
      verifyGeneration(
        Schema.String.check(Schema.isPattern(/^[^A-Z]*$/), Schema.isPattern(/^0x[0-9a-f]{40}$/))
      )
    })

    it("isGreaterThanOrEqualToDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isGreaterThanOrEqualToDate(new Date(0))))
    })

    it("isGreaterThanDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isGreaterThanDate(new Date(0))))
    })

    it("isLessThanOrEqualToDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isLessThanOrEqualToDate(new Date(10))))
    })

    it("isLessThanDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isLessThanDate(new Date(10))))
    })

    it("isBetweenDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isBetweenDate({ minimum: new Date(0), maximum: new Date(10) })))
    })

    it("isBetweenDate with exclusive bounds", () => {
      verifyGeneration(Schema.Date.check(Schema.isBetweenDate({
        minimum: new Date(0),
        maximum: new Date(10),
        exclusiveMinimum: true,
        exclusiveMaximum: true
      })))
    })

    it("isGreaterThanOrEqualToBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(BigInt(0))))
    })

    it("isGreaterThanBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isGreaterThanBigInt(BigInt(0))))
    })

    it("isLessThanOrEqualToBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isLessThanOrEqualToBigInt(BigInt(10))))
    })

    it("isLessThanBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isLessThanBigInt(BigInt(10))))
    })

    it("isBetweenBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: BigInt(0), maximum: BigInt(10) })))
    })

    it("isBetweenBigInt with exclusive bounds", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isBetweenBigInt({
        minimum: BigInt(0),
        maximum: BigInt(10),
        exclusiveMinimum: true,
        exclusiveMaximum: true
      })))
    })

    it("isBetweenBigDecimal", () => {
      verifyGeneration(
        Schema.BigDecimal.check(
          Schema.isBetweenBigDecimal({
            minimum: BigDecimal.make(100n, 0),
            maximum: BigDecimal.make(200n, 0)
          })
        )
      )
    })

    it("isBetweenBigDecimal with decimal scale", () => {
      verifyGeneration(
        Schema.BigDecimal.check(
          Schema.isBetweenBigDecimal({
            minimum: BigDecimal.fromStringUnsafe("1.01"),
            maximum: BigDecimal.fromStringUnsafe("1.02")
          })
        )
      )
    })

    it("non-natural Number order", () => {
      const order = Order.flip(Order.Number)
      verifyGeneration(Schema.Finite.check(Schema.makeIsGreaterThan({ order })(0)))
    })

    it("non-natural Int order", () => {
      const order = Order.flip(Order.Number)
      verifyGeneration(Schema.Int.check(Schema.makeIsGreaterThan({ order })(0)))
    })

    it("non-natural Date order", () => {
      const order = Order.flip(Order.Date)
      verifyGeneration(Schema.Date.check(Schema.makeIsGreaterThan({ order })(new Date(0))))
    })

    it("non-natural BigInt order", () => {
      const order = Order.flip(Order.BigInt)
      verifyGeneration(Schema.BigInt.check(Schema.makeIsGreaterThan({ order })(BigInt(0))))
    })

    it("non-natural BigDecimal order", () => {
      const order = Order.flip(BigDecimal.Order)
      verifyGeneration(Schema.BigDecimal.check(Schema.makeIsGreaterThan({ order })(BigDecimal.make(0n, 0))))
    })
  })

  it("Finite", () => {
    verifyGeneration(Schema.Finite)
  })

  it("Date", () => {
    verifyGeneration(Schema.Date)
  })

  it("URL", () => {
    verifyGeneration(Schema.URL)
  })

  it("RegExp", () => {
    verifyGeneration(Schema.RegExp)
  })

  it("Duration", () => {
    verifyGeneration(Schema.Duration)
  })

  it("BigDecimal", () => {
    verifyGeneration(Schema.BigDecimal)
  })

  it("DateTimeUtc", () => {
    verifyGeneration(Schema.DateTimeUtc)
  })

  it("DateTimeUtc with ordered DateTime constraints", () => {
    const start = DateTime.makeUnsafe(0)
    verifyGeneration(
      Schema.DateTimeUtc.check(
        Schema.makeIsGreaterThan({ order: DateTime.Order })(start)
      )
    )
  })

  it("DateTimeUtc with non-natural DateTime order", () => {
    const order = Order.flip(DateTime.Order)
    verifyGeneration(
      Schema.DateTimeUtc.check(
        Schema.makeIsGreaterThan({ order })(DateTime.makeUnsafe(0))
      )
    )
  })

  it("TimeZoneOffset", () => {
    verifyGeneration(Schema.TimeZoneOffset)
  })

  it("TimeZoneNamed", () => {
    verifyGeneration(Schema.TimeZoneNamed)
  })

  it("TimeZone", () => {
    verifyGeneration(Schema.TimeZone)
  })

  it("DateTimeZoned", () => {
    verifyGeneration(Schema.DateTimeZoned)
  })

  it("DateTimeZoned with ordered DateTime constraints", () => {
    const start = DateTime.makeZonedUnsafe(0, { timeZone: "UTC" })
    verifyGeneration(
      Schema.DateTimeZoned.check(
        Schema.makeIsGreaterThan({ order: DateTime.Order })(start)
      )
    )
  })

  it("DateTimeZoned with non-natural DateTime order", () => {
    const order = Order.flip(DateTime.Order)
    verifyGeneration(
      Schema.DateTimeZoned.check(
        Schema.makeIsGreaterThan({ order })(DateTime.makeZonedUnsafe(0, { timeZone: "UTC" }))
      )
    )
  })

  it("Uint8Array", () => {
    verifyGeneration(Schema.Uint8Array)
  })

  it("UnknownFromJsonString", () => {
    verifyGeneration(Schema.UnknownFromJsonString)
  })

  it("Option(String)", () => {
    verifyGeneration(Schema.Option(Schema.String))
  })

  it("Result(Number, String)", () => {
    verifyGeneration(Schema.Result(Schema.Number, Schema.String))
  })

  describe("ReadonlySet", () => {
    it("ReadonlySet(Number)", () => {
      verifyGeneration(Schema.ReadonlySet(Schema.Number))
    })
  })

  describe("ReadonlyMap", () => {
    it("ReadonlyMap(String, Number)", () => {
      verifyGeneration(Schema.ReadonlyMap(Schema.String, Schema.Number))
    })

    it("isMinSize(2)", () => {
      verifyGeneration(
        Schema.ReadonlyMap(Schema.String, Schema.Number).check(Schema.isMinSize(2))
      )
    })

    it("isMaxSize(4)", () => {
      verifyGeneration(
        Schema.ReadonlyMap(Schema.String, Schema.Number).check(Schema.isMaxSize(4))
      )
    })

    it("isMinSize(2) & isMaxSize(4)", () => {
      verifyGeneration(
        Schema.ReadonlyMap(Schema.String, Schema.Number).check(Schema.isMinSize(2), Schema.isMaxSize(4))
      )
    })

    it("isSizeBetween(2, 2)", () => {
      verifyGeneration(
        Schema.ReadonlyMap(Schema.String, Schema.Number).check(Schema.isSizeBetween(2, 2))
      )
    })
  })

  describe("HashMap", () => {
    it("HashMap(String, Number)", () => {
      verifyGeneration(Schema.HashMap(Schema.String, Schema.Number))
    })
  })

  describe("Redacted", () => {
    it("Redacted(String)", () => {
      const schema = Schema.Redacted(Schema.String)
      verifyGeneration(schema)
    })

    it("with label", () => {
      const schema = Schema.Redacted(Schema.String, { label: "password" })
      verifyGeneration(schema)
    })
  })

  describe("constraint behavior", () => {
    it("String", () => {
      verifyGeneration(Schema.String)
    })

    it("String & nonEmpty", () => {
      verifyGeneration(Schema.NonEmptyString)
    })

    it("String & isNonEmpty & isMinLength(2)", () => {
      verifyGeneration(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMinLength(2)))
    })

    it("String & isMinLength(2) & isNonEmpty", () => {
      verifyGeneration(Schema.String.check(Schema.isMinLength(2)).check(Schema.isNonEmpty()))
    })

    it("String & isNonEmpty & isMaxLength(2)", () => {
      verifyGeneration(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(2)))
    })

    it("String & isLength(2)", () => {
      verifyGeneration(Schema.String.check(Schema.isLengthBetween(2, 2)))
    })

    it("isStartsWith", () => {
      verifyGeneration(Schema.String.check(Schema.isStartsWith("a")))
    })

    it("isEndsWith", () => {
      verifyGeneration(Schema.String.check(Schema.isEndsWith("a")))
    })

    it("literal string checks with regexp syntax", () => {
      verifyGeneration(Schema.String.check(Schema.isStartsWith("a.b")))
      verifyGeneration(Schema.String.check(Schema.isEndsWith("a+b")))
      verifyGeneration(Schema.String.check(Schema.isIncludes("[")))
    })

    it("Number", () => {
      verifyGeneration(Schema.Number)
    })

    it("isFinite", () => {
      verifyGeneration(Schema.Number.check(Schema.isFinite()))
    })

    it("isInt", () => {
      verifyGeneration(Schema.Number.check(Schema.isInt()))
    })

    it("isFinite & isInt", () => {
      verifyGeneration(Schema.Number.check(Schema.isFinite(), Schema.isInt()))
    })

    it("isInt32", () => {
      verifyGeneration(Schema.Number.check(Schema.isInt32()))
    })

    it("isGreaterThan", () => {
      verifyGeneration(Schema.Number.check(Schema.isGreaterThan(10)))
    })

    it("isBetween", () => {
      verifyGeneration(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 })))
    })

    it("Number with non-natural order", () => {
      const order = Order.flip(Order.Number)
      verifyGeneration(Schema.Finite.check(Schema.makeIsGreaterThan({ order })(0)))
    })

    it("ordered lower bounds keep the strongest bound", () => {
      verifyGeneration(Schema.Number.check(Schema.isGreaterThan(1), Schema.isGreaterThanOrEqualTo(3)))
    })

    it("ordered lower bounds preserve exclusivity for equal bounds", () => {
      verifyGeneration(Schema.Number.check(Schema.isGreaterThan(1), Schema.isGreaterThanOrEqualTo(1)))
    })

    it("ordered upper bounds keep the strongest bound", () => {
      verifyGeneration(Schema.Number.check(Schema.isLessThan(10), Schema.isLessThanOrEqualTo(8)))
    })

    it("ordered upper bounds preserve exclusivity for equal bounds", () => {
      verifyGeneration(Schema.Number.check(Schema.isLessThan(1), Schema.isLessThanOrEqualTo(1)))
    })

    it("isInt & isGreaterThan", () => {
      verifyGeneration(Schema.Int.check(Schema.isGreaterThan(1)))
    })

    it("isInt & isGreaterThan fractional", () => {
      verifyGeneration(Schema.Int.check(Schema.isGreaterThan(1.2)))
    })

    it("isInt & isLessThan", () => {
      verifyGeneration(Schema.Int.check(Schema.isLessThan(10)))
    })

    it("isInt & isLessThan fractional", () => {
      verifyGeneration(Schema.Int.check(Schema.isLessThan(10.8)))
    })

    it("isInt & isBetween with fractional bounds", () => {
      verifyGeneration(Schema.Int.check(Schema.isBetween({ minimum: 1.2, maximum: 10.8 })))
    })

    it("isInt & isBetween with exclusive bounds", () => {
      verifyGeneration(Schema.Int.check(Schema.isBetween({
        minimum: 1,
        maximum: 10,
        exclusiveMinimum: true,
        exclusiveMaximum: true
      })))
    })

    it("Int with non-natural order", () => {
      const order = Order.flip(Order.Number)
      verifyGeneration(Schema.Int.check(Schema.makeIsGreaterThan({ order })(0)))
    })

    it("isGreaterThanDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isGreaterThanDate(new Date(0))))
    })

    it("isGreaterThanOrEqualToDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isGreaterThanOrEqualToDate(new Date(0))))
    })

    it("isLessThanDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isLessThanDate(new Date(10))))
    })

    it("isLessThanOrEqualToDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isLessThanOrEqualToDate(new Date(10))))
    })

    it("isBetweenDate", () => {
      verifyGeneration(Schema.Date.check(Schema.isBetweenDate({ minimum: new Date(0), maximum: new Date(10) })))
    })

    it("isBetweenDate with exclusive bounds", () => {
      verifyGeneration(Schema.Date.check(Schema.isBetweenDate({
        minimum: new Date(0),
        maximum: new Date(10),
        exclusiveMinimum: true,
        exclusiveMaximum: true
      })))
    })

    it("Date with non-natural order", () => {
      const order = Order.flip(Order.Date)
      verifyGeneration(Schema.Date.check(Schema.makeIsGreaterThan({ order })(new Date(0))))
    })

    it("isGreaterThanOrEqualToBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(BigInt(0))))
    })

    it("isGreaterThanBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isGreaterThanBigInt(BigInt(0))))
    })

    it("isLessThanOrEqualToBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isLessThanOrEqualToBigInt(BigInt(10))))
    })

    it("isLessThanBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isLessThanBigInt(BigInt(10))))
    })

    it("isBetweenBigInt", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: BigInt(0), maximum: BigInt(10) })))
    })

    it("isBetweenBigInt with exclusive bounds", () => {
      verifyGeneration(Schema.BigInt.check(Schema.isBetweenBigInt({
        minimum: BigInt(0),
        maximum: BigInt(10),
        exclusiveMinimum: true,
        exclusiveMaximum: true
      })))
    })

    it("BigInt with non-natural order", () => {
      const order = Order.flip(Order.BigInt)
      verifyGeneration(Schema.BigInt.check(Schema.makeIsGreaterThan({ order })(BigInt(0))))
    })

    it("isGreaterThanOrEqualToBigDecimal", () => {
      verifyGeneration(Schema.BigDecimal.check(Schema.isGreaterThanOrEqualToBigDecimal(BigDecimal.make(0n, 0))))
    })

    it("isGreaterThanBigDecimal", () => {
      verifyGeneration(Schema.BigDecimal.check(Schema.isGreaterThanBigDecimal(BigDecimal.make(0n, 0))))
    })

    it("isLessThanOrEqualToBigDecimal", () => {
      verifyGeneration(Schema.BigDecimal.check(Schema.isLessThanOrEqualToBigDecimal(BigDecimal.make(10n, 0))))
    })

    it("isLessThanBigDecimal", () => {
      verifyGeneration(Schema.BigDecimal.check(Schema.isLessThanBigDecimal(BigDecimal.make(10n, 0))))
    })

    it("isBetweenBigDecimal", () => {
      verifyGeneration(Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
        minimum: BigDecimal.make(100n, 0),
        maximum: BigDecimal.make(200n, 0)
      })))
    })

    it("isBetweenBigDecimal with decimal scale", () => {
      verifyGeneration(Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
        minimum: BigDecimal.fromStringUnsafe("1.01"),
        maximum: BigDecimal.fromStringUnsafe("1.02")
      })))
    })

    it("isBetweenBigDecimal with exclusive decimal bounds", () => {
      verifyGeneration(
        Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
          minimum: BigDecimal.fromStringUnsafe("1.01"),
          maximum: BigDecimal.fromStringUnsafe("1.02"),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        })),
        1_000
      )
    })

    it("isBetweenBigDecimal with exclusive negative decimal bounds", () => {
      verifyGeneration(
        Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
          minimum: BigDecimal.fromStringUnsafe("-1.02"),
          maximum: BigDecimal.fromStringUnsafe("-1.01"),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        })),
        1_000
      )
    })

    it("isBetweenBigDecimal with a single inclusive decimal value", () => {
      verifyGeneration(
        Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
          minimum: BigDecimal.fromStringUnsafe("1.01"),
          maximum: BigDecimal.fromStringUnsafe("1.01")
        })),
        1_000
      )
    })

    it("isBetweenBigDecimal with exclusive bounds requiring a higher scale", () => {
      verifyGeneration(
        Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
          minimum: BigDecimal.fromStringUnsafe("0"),
          maximum: BigDecimal.fromStringUnsafe("0.00000000000000000001"),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        })),
        1_000
      )
    })

    it("isBetweenBigDecimal with impossible exclusive bounds", () => {
      throws(() =>
        toArbitrary(Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
          minimum: BigDecimal.fromStringUnsafe("1.01"),
          maximum: BigDecimal.fromStringUnsafe("1.01"),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        }))), "Unable to derive an arbitrary for the ordered BigDecimal constraints")
    })

    it("isGreaterThanBigDecimal + isLessThanBigDecimal with impossible bounds", () => {
      throws(() =>
        toArbitrary(Schema.BigDecimal.check(
          Schema.isGreaterThanBigDecimal(BigDecimal.fromStringUnsafe("1.01")),
          Schema.isLessThanBigDecimal(BigDecimal.fromStringUnsafe("1.01"))
        )), "Unable to derive an arbitrary for the ordered BigDecimal constraints")
    })

    it("isGreaterThanBigDecimal + isLessThanBigDecimal", () => {
      verifyGeneration(
        Schema.BigDecimal.check(
          Schema.isGreaterThanBigDecimal(BigDecimal.fromStringUnsafe("1.01")),
          Schema.isLessThanBigDecimal(BigDecimal.fromStringUnsafe("1.02"))
        ),
        1_000
      )
    })

    it("BigDecimal with non-natural order", () => {
      const order = Order.flip(BigDecimal.Order)
      verifyGeneration(Schema.BigDecimal.check(Schema.makeIsGreaterThan({ order })(BigDecimal.make(0n, 0))))
    })

    it("DateTimeUtc with non-natural order", () => {
      const order = Order.flip(DateTime.Order)
      verifyGeneration(Schema.DateTimeUtc.check(Schema.makeIsGreaterThan({ order })(DateTime.makeUnsafe(0))))
    })

    it("DateTimeZoned with non-natural order", () => {
      const order = Order.flip(DateTime.Order)
      verifyGeneration(
        Schema.DateTimeZoned.check(
          Schema.makeIsGreaterThan({ order })(DateTime.makeZonedUnsafe(0, { timeZone: "UTC" }))
        )
      )
    })

    it("UniqueArray", () => {
      verifyGeneration(Schema.UniqueArray(Schema.String))
      verifyGeneration(Schema.UniqueArray(Schema.String).check(Schema.isMaxLength(2)))
    })
  })
})
