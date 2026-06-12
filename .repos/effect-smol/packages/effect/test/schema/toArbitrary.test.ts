import { Schema } from "effect"
import * as InternalArbitrary from "effect/internal/schema/arbitrary"
import { TestSchema } from "effect/testing"
import { describe, it } from "vitest"
import { deepStrictEqual, throws } from "../utils/assert.ts"

function assertUnsupportedSchema(schema: Schema.Top, message: string) {
  throws(() => Schema.toArbitrary(schema), message)
}

function assertContext(schema: Schema.Schema<any>, ctx: Schema.Annotations.ToArbitrary.Context) {
  const ast = schema.ast
  const filters = InternalArbitrary.getFilters(ast.checks)
  const f = InternalArbitrary.constraintContext(filters)
  deepStrictEqual(f({}), ctx)
}

function assertIntegerConstraints(
  schema: Schema.Schema<any>,
  expected: { readonly min?: number; readonly max?: number }
) {
  let constraints: { readonly min?: number; readonly max?: number } | undefined
  const arbitrary = {
    filter: () => arbitrary
  }
  Schema.toArbitraryLazy(schema)({
    integer: (c: { readonly min?: number; readonly max?: number }) => {
      constraints = c
      return arbitrary
    }
  } as any)
  deepStrictEqual(constraints, expected)
}

function verifyGeneration<S extends Schema.Codec<unknown, unknown, never, unknown>>(schema: S) {
  const asserts = new TestSchema.Asserts(schema)
  asserts.arbitrary().verifyGeneration()
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
  })

  it("should pass constraints to the override annotation", () => {
    let constraints: Schema.Annotations.ToArbitrary.NumberConstraints | undefined
    const schema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      toArbitrary: () => (fc, ctx) => {
        constraints = ctx.constraints?.number
        return fc.float(constraints)
      }
    })
    verifyGeneration(schema)
    deepStrictEqual(constraints, { min: 1, max: 100, isInteger: true })
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

    it.skip("mutually suspended schemas", { retry: 5 }, () => {
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

    it("DateValid", () => {
      verifyGeneration(Schema.DateValid)
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

  describe("context constraints", () => {
    it("String", () => {
      assertContext(Schema.String, {
        constraints: {}
      })
    })

    it("String & nonEmpty", () => {
      assertContext(Schema.NonEmptyString, {
        constraints: {
          array: {
            minLength: 1
          },
          string: {
            minLength: 1
          }
        }
      })
    })

    it("String & isNonEmpty & isMinLength(2)", () => {
      assertContext(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMinLength(2)), {
        constraints: {
          array: {
            minLength: 2
          },
          string: {
            minLength: 2
          }
        }
      })
    })

    it("String & isMinLength(2) & isNonEmpty", () => {
      assertContext(Schema.String.check(Schema.isMinLength(2)).check(Schema.isNonEmpty()), {
        constraints: {
          array: {
            minLength: 2
          },
          string: {
            minLength: 2
          }
        }
      })
    })

    it("String & isNonEmpty & isMaxLength(2)", () => {
      assertContext(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(2)), {
        constraints: {
          array: {
            minLength: 1,
            maxLength: 2
          },
          string: {
            minLength: 1,
            maxLength: 2
          }
        }
      })
    })

    it("String & isLength(2)", () => {
      assertContext(Schema.String.check(Schema.isLengthBetween(2, 2)), {
        constraints: {
          array: {
            minLength: 2,
            maxLength: 2
          },
          string: {
            minLength: 2,
            maxLength: 2
          }
        }
      })
    })

    it("isStartsWith", () => {
      assertContext(Schema.String.check(Schema.isStartsWith("a")), {
        constraints: {
          string: {
            patterns: ["^a"]
          }
        }
      })
    })

    it("isEndsWith", () => {
      assertContext(Schema.String.check(Schema.isEndsWith("a")), {
        constraints: {
          string: {
            patterns: ["a$"]
          }
        }
      })
    })

    it("Number", () => {
      assertContext(Schema.Number, {
        constraints: {}
      })
    })

    it("isFinite", () => {
      assertContext(Schema.Number.check(Schema.isFinite()), {
        constraints: {
          number: {
            noDefaultInfinity: true,
            noNaN: true
          }
        }
      })
    })

    it("isInt", () => {
      assertContext(Schema.Number.check(Schema.isInt()), {
        constraints: {
          number: {
            isInteger: true
          }
        }
      })
    })

    it("isFinite & isInt", () => {
      assertContext(Schema.Number.check(Schema.isFinite(), Schema.isInt()), {
        constraints: {
          number: {
            noDefaultInfinity: true,
            noNaN: true,
            isInteger: true
          }
        }
      })
    })

    it("isInt32", () => {
      assertContext(Schema.Number.check(Schema.isInt32()), {
        constraints: {
          number: {
            isInteger: true,
            max: 2147483647,
            min: -2147483648
          }
        }
      })
    })

    it("isGreaterThan", () => {
      assertContext(Schema.Number.check(Schema.isGreaterThan(10)), {
        constraints: {
          number: {
            min: 10,
            minExcluded: true
          }
        }
      })
    })

    it("isInt & isGreaterThan", () => {
      assertIntegerConstraints(Schema.Int.check(Schema.isGreaterThan(1)), { min: 2 })
    })

    it("isInt & isGreaterThan fractional", () => {
      assertIntegerConstraints(Schema.Int.check(Schema.isGreaterThan(1.2)), { min: 2 })
    })

    it("isInt & isLessThan", () => {
      assertIntegerConstraints(Schema.Int.check(Schema.isLessThan(10)), { max: 9 })
    })

    it("isInt & isLessThan fractional", () => {
      assertIntegerConstraints(Schema.Int.check(Schema.isLessThan(10.8)), { max: 10 })
    })

    it("isInt & isBetween with fractional bounds", () => {
      assertIntegerConstraints(Schema.Int.check(Schema.isBetween({ minimum: 1.2, maximum: 10.8 })), {
        min: 2,
        max: 10
      })
    })

    it("isInt & isBetween with exclusive bounds", () => {
      assertIntegerConstraints(
        Schema.Int.check(Schema.isBetween({
          minimum: 1,
          maximum: 10,
          exclusiveMinimum: true,
          exclusiveMaximum: true
        })),
        {
          min: 2,
          max: 9
        }
      )
    })

    it("isGreaterThanDate", () => {
      assertContext(Schema.Date.check(Schema.isGreaterThanDate(new Date(0))), {
        constraints: {
          date: {
            min: new Date(1)
          }
        }
      })
    })

    it("isGreaterThanOrEqualToDate", () => {
      assertContext(Schema.Date.check(Schema.isGreaterThanOrEqualToDate(new Date(0))), {
        constraints: {
          date: {
            min: new Date(0)
          }
        }
      })
    })

    it("isLessThanDate", () => {
      assertContext(Schema.Date.check(Schema.isLessThanDate(new Date(10))), {
        constraints: {
          date: {
            max: new Date(9)
          }
        }
      })
    })

    it("isLessThanOrEqualToDate", () => {
      assertContext(Schema.Date.check(Schema.isLessThanOrEqualToDate(new Date(10))), {
        constraints: {
          date: {
            max: new Date(10)
          }
        }
      })
    })

    it("isBetweenDate", () => {
      assertContext(Schema.Date.check(Schema.isBetweenDate({ minimum: new Date(0), maximum: new Date(10) })), {
        constraints: {
          date: {
            min: new Date(0),
            max: new Date(10)
          }
        }
      })
    })

    it("isBetweenDate with exclusive bounds", () => {
      assertContext(
        Schema.Date.check(Schema.isBetweenDate({
          minimum: new Date(0),
          maximum: new Date(10),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        })),
        {
          constraints: {
            date: {
              min: new Date(1),
              max: new Date(9)
            }
          }
        }
      )
    })

    it("isValidDate", () => {
      assertContext(Schema.Date.check(Schema.isDateValid()), {
        constraints: {
          date: {
            noInvalidDate: true
          }
        }
      })
    })

    it("isValidDate & isGreaterThanOrEqualToDate", () => {
      assertContext(Schema.Date.check(Schema.isDateValid(), Schema.isGreaterThanOrEqualToDate(new Date(0))), {
        constraints: {
          date: {
            noInvalidDate: true,
            min: new Date(0)
          }
        }
      })
    })

    it("isGreaterThanOrEqualToBigInt", () => {
      assertContext(Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(BigInt(0))), {
        constraints: {
          bigint: {
            min: BigInt(0)
          }
        }
      })
    })

    it("isGreaterThanBigInt", () => {
      assertContext(Schema.BigInt.check(Schema.isGreaterThanBigInt(BigInt(0))), {
        constraints: {
          bigint: {
            min: BigInt(1)
          }
        }
      })
    })

    it("isLessThanOrEqualToBigInt", () => {
      assertContext(Schema.BigInt.check(Schema.isLessThanOrEqualToBigInt(BigInt(10))), {
        constraints: {
          bigint: {
            max: BigInt(10)
          }
        }
      })
    })

    it("isLessThanBigInt", () => {
      assertContext(Schema.BigInt.check(Schema.isLessThanBigInt(BigInt(10))), {
        constraints: {
          bigint: {
            max: BigInt(9)
          }
        }
      })
    })

    it("isBetweenBigInt", () => {
      assertContext(Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: BigInt(0), maximum: BigInt(10) })), {
        constraints: {
          bigint: {
            min: BigInt(0),
            max: BigInt(10)
          }
        }
      })
    })

    it("isBetweenBigInt with exclusive bounds", () => {
      assertContext(
        Schema.BigInt.check(Schema.isBetweenBigInt({
          minimum: BigInt(0),
          maximum: BigInt(10),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        })),
        {
          constraints: {
            bigint: {
              min: BigInt(1),
              max: BigInt(9)
            }
          }
        }
      )
    })

    it("UniqueArray", () => {
      const comparator = Schema.toEquivalence(Schema.String)
      assertContext(Schema.UniqueArray(Schema.String), {
        constraints: {
          array: {
            comparator
          }
        }
      })
      assertContext(Schema.UniqueArray(Schema.String).check(Schema.isMaxLength(2)), {
        constraints: {
          array: {
            maxLength: 2,
            comparator
          },
          string: {
            maxLength: 2
          }
        }
      })
    })
  })
})
