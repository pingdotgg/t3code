import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import { describe, it } from "vitest"
import { deepStrictEqual, strictEqual } from "../../utils/assert.ts"

type Category = {
  readonly name: string
  readonly children: ReadonlyArray<Category>
}

const OuterCategory = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Category> => OuterCategory))
}).annotate({ identifier: "Category" })

const InnerCategory = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<Category> => InnerCategory.annotate({ identifier: "Category" }))
  )
})

describe("toCodeDocument", () => {
  type Expected = {
    readonly codes: SchemaRepresentation.Code | ReadonlyArray<SchemaRepresentation.Code>
    readonly references?: {
      readonly nonRecursives?: ReadonlyArray<{
        readonly $ref: string
        readonly code: SchemaRepresentation.Code
      }>
      readonly recursives?: {
        readonly [$ref: string]: SchemaRepresentation.Code
      }
    }
    readonly artifacts?: ReadonlyArray<SchemaRepresentation.Artifact>
  }

  function assertSchema(input: {
    readonly schema: Schema.Top
    readonly reviver?: SchemaRepresentation.Reviver<SchemaRepresentation.Code> | undefined
  }, expected: Expected) {
    const multiDocument = SchemaRepresentation.fromASTs([input.schema.ast])
    assertMultiDocument({ multiDocument }, expected)
  }

  function assertJsonSchema(input: {
    readonly schema: JsonSchema.JsonSchema
    readonly reviver?: SchemaRepresentation.Reviver<SchemaRepresentation.Code> | undefined
  }, expected: Expected) {
    const multiDocument = SchemaRepresentation.toMultiDocument(
      SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(input.schema), {
        onEnter: (js) => {
          if (js.type === "object" && js.additionalProperties === undefined) {
            return { ...js, additionalProperties: false }
          }
          return js
        }
      })
    )
    assertMultiDocument({ multiDocument }, expected)
  }

  function assertMultiDocument(input: {
    readonly multiDocument: SchemaRepresentation.MultiDocument
    readonly reviver?: SchemaRepresentation.Reviver<SchemaRepresentation.Code> | undefined
  }, expected: Expected) {
    const codeDocument = SchemaRepresentation.toCodeDocument(input.multiDocument, { reviver: input.reviver })
    deepStrictEqual(codeDocument, {
      codes: Array.isArray(expected.codes) ? expected.codes : [expected.codes],
      references: {
        nonRecursives: expected.references?.nonRecursives ?? [],
        recursives: expected.references?.recursives ?? {}
      },
      artifacts: expected.artifacts ?? []
    })
  }

  const makeCode = SchemaRepresentation.makeCode

  describe("options", () => {
    it("reviver can override declaration code and recur into type parameters", () => {
    })
  })

  describe("Declaration", () => {
    it("declaration without typeConstructor annotation", () => {
      assertSchema({ schema: Schema.instanceOf(URL) }, {
        codes: makeCode("Schema.Null", "null")
      })
    })

    it("Error", () => {
      assertSchema({ schema: Schema.Error }, {
        codes: makeCode(`Schema.Error`, "globalThis.Error")
      })
    })

    it("RegExp", () => {
      assertSchema({ schema: Schema.RegExp }, {
        codes: makeCode(`Schema.RegExp`, "globalThis.RegExp")
      })
    })

    it("URL", () => {
      assertSchema({ schema: Schema.URL }, {
        codes: makeCode(`Schema.URL`, "globalThis.URL")
      })
    })

    it("Uint8Array", () => {
      assertSchema({ schema: Schema.Uint8Array }, {
        codes: makeCode(`Schema.Uint8Array`, "globalThis.Uint8Array")
      })
    })

    it("URLSearchParams", () => {
      assertSchema({ schema: Schema.URLSearchParams }, {
        codes: makeCode(`Schema.URLSearchParams`, "globalThis.URLSearchParams")
      })
    })

    it("File", () => {
      assertSchema({ schema: Schema.File }, {
        codes: makeCode(`Schema.File`, "globalThis.File")
      })
    })

    it("FormData", () => {
      assertSchema({ schema: Schema.FormData }, {
        codes: makeCode(`Schema.FormData`, "globalThis.FormData")
      })
    })

    it("URLSearchParams", () => {
      assertSchema({ schema: Schema.URLSearchParams }, {
        codes: makeCode(`Schema.URLSearchParams`, "globalThis.URLSearchParams")
      })
    })

    describe("Date", () => {
      it("Date", () => {
        assertSchema({ schema: Schema.Date }, {
          codes: makeCode(`Schema.Date`, "globalThis.Date")
        })
      })

      it("Date & check", () => {
        assertSchema(
          { schema: Schema.Date.check(Schema.isGreaterThanDate(new Date(0))) },
          {
            codes: makeCode(`Schema.Date.check(Schema.isGreaterThanDate(new Date(0)))`, "globalThis.Date")
          }
        )
      })
    })

    it("Option(String)", () => {
      assertSchema(
        { schema: Schema.Option(Schema.String) },
        {
          codes: makeCode("Schema.Option(Schema.String)", "Option.Option<string>"),
          artifacts: [{
            _tag: "Import",
            importDeclaration: `import * as Option from "effect/Option"`
          }]
        }
      )
    })

    it("Result(String, Number)", () => {
      assertSchema(
        { schema: Schema.Result(Schema.String, Schema.Number) },
        {
          codes: makeCode("Schema.Result(Schema.String, Schema.Number)", "Result.Result<string, number>"),
          artifacts: [{
            _tag: "Import",
            importDeclaration: `import * as Result from "effect/Result"`
          }]
        }
      )
    })

    it("CauseReason(String, Number)", () => {
      assertSchema({ schema: Schema.CauseReason(Schema.String, Schema.Number) }, {
        codes: makeCode("Schema.CauseReason(Schema.String, Schema.Number)", "Cause.Failure<string, number>"),
        artifacts: [{ _tag: "Import", importDeclaration: `import * as Cause from "effect/Cause"` }]
      })
    })

    it("Cause(String, Number)", () => {
      assertSchema({ schema: Schema.Cause(Schema.String, Schema.Number) }, {
        codes: makeCode("Schema.Cause(Schema.String, Schema.Number)", "Cause.Cause<string, number>"),
        artifacts: [{ _tag: "Import", importDeclaration: `import * as Cause from "effect/Cause"` }]
      })
    })

    it("Exit(String, Number, String)", () => {
      assertSchema({ schema: Schema.Exit(Schema.String, Schema.Number, Schema.Boolean) }, {
        codes: makeCode(
          "Schema.Exit(Schema.String, Schema.Number, Schema.Boolean)",
          "Exit.Exit<string, number, boolean>"
        ),
        artifacts: [{ _tag: "Import", importDeclaration: `import * as Exit from "effect/Exit"` }]
      })
    })
  })

  it("Null", () => {
    assertSchema({ schema: Schema.Null }, {
      codes: makeCode("Schema.Null", "null")
    })
    assertSchema(
      { schema: Schema.Null.annotate({ "description": "a" }) },
      {
        codes: makeCode(`Schema.Null.annotate({ "description": "a" })`, "null")
      }
    )
    assertSchema({ schema: Schema.Null.annotate({}) }, {
      codes: makeCode("Schema.Null", "null")
    })
  })

  it("Undefined", () => {
    assertSchema({ schema: Schema.Undefined }, {
      codes: makeCode("Schema.Undefined", "undefined")
    })
    assertSchema(
      { schema: Schema.Undefined.annotate({ "description": "a" }) },
      {
        codes: makeCode(`Schema.Undefined.annotate({ "description": "a" })`, "undefined")
      }
    )
  })

  it("Void", () => {
    assertSchema({ schema: Schema.Void }, {
      codes: makeCode("Schema.Void", "void")
    })
    assertSchema(
      { schema: Schema.Void.annotate({ "description": "a" }) },
      {
        codes: makeCode(`Schema.Void.annotate({ "description": "a" })`, "void")
      }
    )
  })

  it("Never", () => {
    assertSchema({ schema: Schema.Never }, {
      codes: makeCode("Schema.Never", "never")
    })
    assertSchema(
      { schema: Schema.Never.annotate({ "description": "a" }) },
      {
        codes: makeCode(`Schema.Never.annotate({ "description": "a" })`, "never")
      }
    )
  })

  it("Unknown", () => {
    assertSchema({ schema: Schema.Unknown }, {
      codes: makeCode("Schema.Unknown", "unknown")
    })
    assertSchema(
      { schema: Schema.Unknown.annotate({ "description": "a" }) },
      {
        codes: makeCode(`Schema.Unknown.annotate({ "description": "a" })`, "unknown")
      }
    )
  })

  it("Any", () => {
    assertSchema({ schema: Schema.Any }, {
      codes: makeCode("Schema.Any", "any")
    })
    assertSchema(
      { schema: Schema.Any.annotate({ "description": "a" }) },
      {
        codes: makeCode(`Schema.Any.annotate({ "description": "a" })`, "any")
      }
    )
  })

  describe("String", () => {
    it("String", () => {
      assertSchema({ schema: Schema.String }, {
        codes: makeCode("Schema.String", "string")
      })
    })

    it("String & identifier", () => {
      assertSchema({ schema: Schema.String.annotate({ identifier: "ID" }) }, {
        codes: makeCode("ID", "ID"),
        references: {
          nonRecursives: [
            {
              $ref: "ID",
              code: makeCode(`Schema.String.annotate({ "identifier": "ID" })`, "string")
            }
          ]
        }
      })
    })

    it("String & annotations", () => {
      assertSchema(
        { schema: Schema.String.annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.String.annotate({ "description": "a" })`, "string")
        }
      )
    })

    it("String & check", () => {
      assertSchema(
        { schema: Schema.String.check(Schema.isMinLength(1)) },
        {
          codes: makeCode(`Schema.String.check(Schema.isMinLength(1))`, "string")
        }
      )
    })

    it("String & annotations & check", () => {
      assertSchema(
        { schema: Schema.String.annotate({ "description": "a" }).check(Schema.isMinLength(1)) },
        {
          codes: makeCode(
            `Schema.String.annotate({ "description": "a" }).check(Schema.isMinLength(1))`,
            "string"
          )
        }
      )
    })

    it("String & check + annotations", () => {
      assertSchema(
        { schema: Schema.String.check(Schema.isMinLength(1, { description: "a" })) },
        {
          codes: makeCode(`Schema.String.check(Schema.isMinLength(1, { "description": "a" }))`, "string")
        }
      )
    })

    it("String & check & annotations", () => {
      assertSchema(
        { schema: Schema.String.check(Schema.isMinLength(1)).annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.String.check(Schema.isMinLength(1, { "description": "a" }))`, "string")
        }
      )
    })

    describe("checks", () => {
      it("isStartsWith", () => {
        assertSchema(
          { schema: Schema.String.check(Schema.isStartsWith("a")) },
          {
            codes: makeCode(`Schema.String.check(Schema.isStartsWith("a"))`, "string")
          }
        )
      })

      it("isEndsWith", () => {
        assertSchema(
          { schema: Schema.String.check(Schema.isEndsWith("a")) },
          {
            codes: makeCode(`Schema.String.check(Schema.isEndsWith("a"))`, "string")
          }
        )
      })

      it("isIncludes", () => {
        assertSchema(
          { schema: Schema.String.check(Schema.isIncludes("a")) },
          {
            codes: makeCode(`Schema.String.check(Schema.isIncludes("a"))`, "string")
          }
        )
      })
    })
  })

  describe("Number", () => {
    it("Number", () => {
      assertSchema({ schema: Schema.Number }, {
        codes: makeCode("Schema.Number", "number")
      })
      assertSchema(
        { schema: Schema.Number.annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.Number.annotate({ "description": "a" })`, "number")
        }
      )
    })

    it("Number & check", () => {
      assertSchema(
        { schema: Schema.Number.check(Schema.isGreaterThan(10)) },
        {
          codes: makeCode(`Schema.Number.check(Schema.isGreaterThan(10))`, "number")
        }
      )
    })
  })

  it("Boolean", () => {
    assertSchema({ schema: Schema.Boolean }, {
      codes: makeCode("Schema.Boolean", "boolean")
    })
    assertSchema(
      { schema: Schema.Boolean.annotate({ "description": "a" }) },
      {
        codes: makeCode(`Schema.Boolean.annotate({ "description": "a" })`, "boolean")
      }
    )
  })

  describe("BigInt", () => {
    it("BigInt", () => {
      assertSchema({ schema: Schema.BigInt }, {
        codes: makeCode("Schema.BigInt", "bigint")
      })
      assertSchema(
        { schema: Schema.BigInt.annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.BigInt.annotate({ "description": "a" })`, "bigint")
        }
      )
    })

    it("BigInt & check", () => {
      assertSchema(
        { schema: Schema.BigInt.check(Schema.isGreaterThanBigInt(10n)) },
        {
          codes: makeCode(`Schema.BigInt.check(Schema.isGreaterThanBigInt(10n))`, "bigint")
        }
      )
    })
  })

  it("Symbol", () => {
    assertSchema({ schema: Schema.Symbol }, {
      codes: makeCode("Schema.Symbol", "symbol")
    })
    assertSchema(
      { schema: Schema.Symbol.annotate({ "description": "a" }) },
      {
        codes: makeCode(`Schema.Symbol.annotate({ "description": "a" })`, "symbol")
      }
    )
  })

  it("ObjectKeyword", () => {
    assertSchema({ schema: Schema.ObjectKeyword }, {
      codes: makeCode("Schema.ObjectKeyword", "object")
    })
    assertSchema(
      { schema: Schema.ObjectKeyword.annotate({ "description": "a" }) },
      {
        codes: makeCode(`Schema.ObjectKeyword.annotate({ "description": "a" })`, "object")
      }
    )
  })

  describe("Literal", () => {
    it("string literal", () => {
      assertSchema({ schema: Schema.Literal("a") }, {
        codes: makeCode(`Schema.Literal("a")`, `"a"`)
      })
      assertSchema(
        { schema: Schema.Literal("a").annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.Literal("a").annotate({ "description": "a" })`, `"a"`)
        }
      )
    })

    it("number literal", () => {
      assertSchema({ schema: Schema.Literal(1) }, {
        codes: makeCode(`Schema.Literal(1)`, "1")
      })
      assertSchema(
        { schema: Schema.Literal(1).annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.Literal(1).annotate({ "description": "a" })`, "1")
        }
      )
    })

    it("boolean literal", () => {
      assertSchema({ schema: Schema.Literal(true) }, {
        codes: makeCode(`Schema.Literal(true)`, "true")
      })
      assertSchema(
        { schema: Schema.Literal(true).annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.Literal(true).annotate({ "description": "a" })`, "true")
        }
      )
    })

    it("bigint literal", () => {
      assertSchema({ schema: Schema.Literal(100n) }, {
        codes: makeCode(`Schema.Literal(100n)`, "100n")
      })
      assertSchema(
        { schema: Schema.Literal(100n).annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.Literal(100n).annotate({ "description": "a" })`, "100n")
        }
      )
    })
  })

  describe("UniqueSymbol", () => {
    it("should create a Symbol artifact", () => {
      assertSchema(
        { schema: Schema.UniqueSymbol(Symbol("a")) },
        {
          codes: makeCode(`Schema.UniqueSymbol(_symbol)`, "typeof _symbol"),
          artifacts: [{
            _tag: "Symbol",
            identifier: "_symbol",
            generation: makeCode(`Symbol("a")`, `typeof _symbol`)
          }]
        }
      )
      assertSchema(
        { schema: Schema.UniqueSymbol(Symbol()) },
        {
          codes: makeCode(`Schema.UniqueSymbol(_symbol)`, "typeof _symbol"),
          artifacts: [{
            _tag: "Symbol",
            identifier: "_symbol",
            generation: makeCode(`Symbol()`, `typeof _symbol`)
          }]
        }
      )
    })

    it("should create a global Symbol artifact", () => {
      assertSchema(
        { schema: Schema.UniqueSymbol(Symbol.for("a")) },
        {
          codes: makeCode(`Schema.UniqueSymbol(_symbol)`, "typeof _symbol"),
          artifacts: [{
            _tag: "Symbol",
            identifier: "_symbol",
            generation: makeCode(`Symbol.for("a")`, `typeof _symbol`)
          }]
        }
      )
      assertSchema(
        { schema: Schema.UniqueSymbol(Symbol.for("a")).annotate({ "description": "a" }) },
        {
          codes: makeCode(
            `Schema.UniqueSymbol(_symbol).annotate({ "description": "a" })`,
            "typeof _symbol"
          ),
          artifacts: [{
            _tag: "Symbol",
            identifier: "_symbol",
            generation: makeCode(`Symbol.for("a")`, `typeof _symbol`)
          }]
        }
      )
    })
  })

  describe("Enum", () => {
    it("string values", () => {
      assertSchema(
        {
          schema: Schema.Enum({
            A: "a",
            B: "b"
          })
        },
        {
          codes: makeCode(`Schema.Enum(_Enum)`, `typeof _Enum`),
          artifacts: [{
            _tag: "Enum",
            identifier: "_Enum",
            generation: makeCode(`enum _Enum { "A": "a", "B": "b" }`, `typeof _Enum`)
          }]
        }
      )
      assertSchema(
        {
          schema: Schema.Enum({
            A: "a",
            B: "b"
          }).annotate({ "description": "a" })
        },
        {
          codes: makeCode(
            `Schema.Enum(_Enum).annotate({ "description": "a" })`,
            `typeof _Enum`
          ),
          artifacts: [{
            _tag: "Enum",
            identifier: "_Enum",
            generation: makeCode(`enum _Enum { "A": "a", "B": "b" }`, `typeof _Enum`)
          }]
        }
      )
    })

    it("number values", () => {
      assertSchema(
        {
          schema: Schema.Enum({
            One: 1,
            Two: 2
          })
        },
        {
          codes: makeCode(`Schema.Enum(_Enum)`, `typeof _Enum`),
          artifacts: [{
            _tag: "Enum",
            identifier: "_Enum",
            generation: makeCode(`enum _Enum { "One": 1, "Two": 2 }`, `typeof _Enum`)
          }]
        }
      )
      assertSchema(
        {
          schema: Schema.Enum({
            One: 1,
            Two: 2
          }).annotate({ "description": "a" })
        },
        {
          codes: makeCode(
            `Schema.Enum(_Enum).annotate({ "description": "a" })`,
            `typeof _Enum`
          ),
          artifacts: [{
            _tag: "Enum",
            identifier: "_Enum",
            generation: makeCode(`enum _Enum { "One": 1, "Two": 2 }`, `typeof _Enum`)
          }]
        }
      )
    })

    it("mixed values", () => {
      assertSchema(
        {
          schema: Schema.Enum({
            A: "a",
            One: 1
          })
        },
        {
          codes: makeCode(`Schema.Enum(_Enum)`, `typeof _Enum`),
          artifacts: [{
            _tag: "Enum",
            identifier: "_Enum",
            generation: makeCode(`enum _Enum { "A": "a", "One": 1 }`, `typeof _Enum`)
          }]
        }
      )
      assertSchema(
        {
          schema: Schema.Enum({
            A: "a",
            One: 1
          }).annotate({ "description": "a" })
        },
        {
          codes: makeCode(
            `Schema.Enum(_Enum).annotate({ "description": "a" })`,
            `typeof _Enum`
          ),
          artifacts: [{
            _tag: "Enum",
            identifier: "_Enum",
            generation: makeCode(`enum _Enum { "A": "a", "One": 1 }`, `typeof _Enum`)
          }]
        }
      )
    })
  })

  describe("TemplateLiteral", () => {
    it("empty template literal", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([]) },
        {
          codes: makeCode(`Schema.TemplateLiteral([])`, "``")
        }
      )
    })

    it("string literal", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Literal("a")]) },
        {
          codes: makeCode(`Schema.TemplateLiteral([Schema.Literal("a")])`, "`a`")
        }
      )
    })

    it("number literal", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Literal(1)]) },
        {
          codes: makeCode(`Schema.TemplateLiteral([Schema.Literal(1)])`, "`1`")
        }
      )
    })

    it("bigint literal", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Literal(1n)]) },
        {
          codes: makeCode(`Schema.TemplateLiteral([Schema.Literal(1n)])`, "`1`")
        }
      )
    })

    it("multiple consecutive literals", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Literal("a"), Schema.Literal("b"), Schema.Literal("c")]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literal("a"), Schema.Literal("b"), Schema.Literal("c")])`,
            "`abc`"
          )
        }
      )
    })

    it("special characters in literals", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Literal("a b"), Schema.String]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literal("a b"), Schema.String])`,
            "`a b${string}`"
          )
        }
      )
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Literal("\n"), Schema.String]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literal("\\n"), Schema.String])`,
            "`\n${string}`"
          )
        }
      )
    })

    it("only schemas", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.String]) },
        {
          codes: makeCode(`Schema.TemplateLiteral([Schema.String])`, "`${string}`")
        }
      )
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Number]) },
        {
          codes: makeCode(`Schema.TemplateLiteral([Schema.Number])`, "`${number}`")
        }
      )
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.BigInt]) },
        {
          codes: makeCode(`Schema.TemplateLiteral([Schema.BigInt])`, "`${bigint}`")
        }
      )
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.String, Schema.Number]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.String, Schema.Number])`,
            "`${string}${number}`"
          )
        }
      )
    })

    it("schema & literal", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.String, Schema.Literal("a")]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.String, Schema.Literal("a")])`,
            "`${string}a`"
          )
        }
      )
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Number, Schema.Literal("a")]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Number, Schema.Literal("a")])`,
            "`${number}a`"
          )
        }
      )
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.BigInt, Schema.Literal("a")]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.BigInt, Schema.Literal("a")])`,
            "`${bigint}a`"
          )
        }
      )
    })

    it("literal & schema", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Literal("a"), Schema.String]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literal("a"), Schema.String])`,
            "`a${string}`"
          )
        }
      )
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Literal("a"), Schema.Number]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literal("a"), Schema.Number])`,
            "`a${number}`"
          )
        }
      )
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.Literal("a"), Schema.BigInt]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literal("a"), Schema.BigInt])`,
            "`a${bigint}`"
          )
        }
      )
    })

    it("schema & literal & schema", () => {
      assertSchema(
        { schema: Schema.TemplateLiteral([Schema.String, Schema.Literal("-"), Schema.Number]) },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.String, Schema.Literal("-"), Schema.Number])`,
            "`${string}-${number}`"
          )
        }
      )
      assertSchema(
        {
          schema: Schema.TemplateLiteral([Schema.String, Schema.Literal("-"), Schema.Number]).annotate({
            "description": "ad"
          })
        },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.String, Schema.Literal("-"), Schema.Number]).annotate({ "description": "ad" })`,
            "`${string}-${number}`"
          )
        }
      )
    })

    it("TemplateLiteral as part", () => {
      assertSchema(
        {
          schema: Schema.TemplateLiteral([
            Schema.Literal("a"),
            Schema.TemplateLiteral([Schema.String, Schema.Literals(["-", "+"]), Schema.Number])
          ])
        },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literal("a"), Schema.TemplateLiteral([Schema.String, Schema.Literals(["-", "+"]), Schema.Number])])`,
            "`a${string}-${number}` | `a${string}+${number}`"
          )
        }
      )
    })

    it("Union as part", () => {
      assertSchema(
        {
          schema: Schema.TemplateLiteral([Schema.Literal("a"), Schema.Union([Schema.String, Schema.Number])])
        },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literal("a"), Schema.Union([Schema.String, Schema.Number])])`,
            "`a${string}` | `a${number}`"
          )
        }
      )
    })

    it("Literals as part", () => {
      assertSchema(
        {
          schema: Schema.TemplateLiteral([Schema.Literals(["a", "b"]), Schema.String])
        },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literals(["a", "b"]), Schema.String])`,
            "`a${string}` | `b${string}`"
          )
        }
      )
    })

    it("multiple unions", () => {
      assertSchema(
        {
          schema: Schema.TemplateLiteral([
            Schema.Union([Schema.Literal("a"), Schema.Literal("b")]),
            Schema.String,
            Schema.Union([Schema.Number, Schema.BigInt])
          ])
        },
        {
          codes: makeCode(
            `Schema.TemplateLiteral([Schema.Literals(["a", "b"]), Schema.String, Schema.Union([Schema.BigInt, Schema.Number])])`,
            "`a${string}${bigint}` | `a${string}${number}` | `b${string}${bigint}` | `b${string}${number}`"
          )
        }
      )
    })
  })

  describe("Tuple", () => {
    it("empty tuple", () => {
      assertSchema({ schema: Schema.Tuple([]) }, {
        codes: makeCode("Schema.Tuple([])", "readonly []")
      })
      assertSchema(
        { schema: Schema.Tuple([]).annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.Tuple([]).annotate({ "description": "a" })`, "readonly []")
        }
      )
    })

    it("required element", () => {
      assertSchema(
        { schema: Schema.Tuple([Schema.String]) },
        {
          codes: makeCode(`Schema.Tuple([Schema.String])`, "readonly [string]")
        }
      )
      assertSchema(
        { schema: Schema.Tuple([Schema.String]).annotate({ "description": "a" }) },
        {
          codes: makeCode(
            `Schema.Tuple([Schema.String]).annotate({ "description": "a" })`,
            "readonly [string]"
          )
        }
      )
    })

    it("optional element", () => {
      assertSchema(
        { schema: Schema.Tuple([Schema.optionalKey(Schema.String)]) },
        {
          codes: makeCode(`Schema.Tuple([Schema.optionalKey(Schema.String)])`, "readonly [string?]")
        }
      )
      assertSchema(
        { schema: Schema.Tuple([Schema.optionalKey(Schema.String)]).annotate({ "description": "a" }) },
        {
          codes: makeCode(
            `Schema.Tuple([Schema.optionalKey(Schema.String)]).annotate({ "description": "a" })`,
            "readonly [string?]"
          )
        }
      )
    })

    it("annotateKey", () => {
      assertSchema(
        { schema: Schema.Tuple([Schema.String.annotateKey({ "description": "a" })]) },
        {
          codes: makeCode(
            `Schema.Tuple([Schema.String.annotateKey({ "description": "a" })])`,
            "readonly [string]"
          )
        }
      )
    })
  })

  it("Array", () => {
    assertSchema(
      { schema: Schema.Array(Schema.String) },
      {
        codes: makeCode("Schema.Array(Schema.String)", "ReadonlyArray<string>")
      }
    )
    assertSchema(
      { schema: Schema.Array(Schema.String).annotate({ "description": "a" }) },
      {
        codes: makeCode(
          `Schema.Array(Schema.String).annotate({ "description": "a" })`,
          "ReadonlyArray<string>"
        )
      }
    )
  })

  it("TupleWithRest", () => {
    assertSchema(
      { schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number]) },
      {
        codes: makeCode(
          `Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number])`,
          "readonly [string, ...Array<number>]"
        )
      }
    )
    assertSchema(
      {
        schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number]).annotate({
          "description": "a"
        })
      },
      {
        codes: makeCode(
          `Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number]).annotate({ "description": "a" })`,
          "readonly [string, ...Array<number>]"
        )
      }
    )
    assertSchema(
      { schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number, Schema.Boolean]) },
      {
        codes: makeCode(
          `Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number, Schema.Boolean])`,
          "readonly [string, ...Array<number>, boolean]"
        )
      }
    )
  })

  describe("Struct", () => {
    it("empty struct", () => {
      assertSchema({ schema: Schema.Struct({}) }, {
        codes: makeCode("Schema.Struct({  })", "{  }")
      })
      assertSchema(
        { schema: Schema.Struct({}).annotate({ "description": "a" }) },
        {
          codes: makeCode(`Schema.Struct({  }).annotate({ "description": "a" })`, "{  }")
        }
      )
    })

    it("required properties", () => {
      assertSchema(
        {
          schema: Schema.Struct({
            a: Schema.String
          })
        },
        {
          codes: makeCode(
            `Schema.Struct({ "a": Schema.String })`,
            `{ readonly "a": string }`
          )
        }
      )
      assertSchema(
        {
          schema: Schema.Struct({
            a: Schema.String,
            b: Schema.Number
          })
        },
        {
          codes: makeCode(
            `Schema.Struct({ "a": Schema.String, "b": Schema.Number })`,
            `{ readonly "a": string, readonly "b": number }`
          )
        }
      )
    })

    it("optional properties", () => {
      assertSchema(
        {
          schema: Schema.Struct({
            a: Schema.optionalKey(Schema.String)
          })
        },
        {
          codes: makeCode(
            `Schema.Struct({ "a": Schema.optionalKey(Schema.String) })`,
            `{ readonly "a"?: string }`
          )
        }
      )
    })

    it("mutable properties", () => {
      assertSchema(
        {
          schema: Schema.Struct({
            a: Schema.mutableKey(Schema.String)
          })
        },
        {
          codes: makeCode(
            `Schema.Struct({ "a": Schema.mutableKey(Schema.String) })`,
            `{ "a": string }`
          )
        }
      )
    })

    it("optional and mutable properties", () => {
      assertSchema(
        {
          schema: Schema.Struct({
            a: Schema.optionalKey(Schema.mutableKey(Schema.String))
          })
        },
        {
          codes: makeCode(
            `Schema.Struct({ "a": Schema.optionalKey(Schema.mutableKey(Schema.String)) })`,
            `{ "a"?: string }`
          )
        }
      )
    })

    it("annotateKey", () => {
      assertSchema(
        {
          schema: Schema.Struct({
            a: Schema.String.annotateKey({ "description": "a" })
          })
        },
        {
          codes: makeCode(
            `Schema.Struct({ "a": Schema.String.annotateKey({ "description": "a" }) })`,
            `{ readonly "a": string }`
          )
        }
      )
    })

    it("struct with symbol property key", () => {
      const sym = Symbol.for("a")
      assertSchema(
        {
          schema: Schema.Struct({
            [sym]: Schema.String
          })
        },
        {
          codes: makeCode(
            `Schema.Struct({ [_symbol]: Schema.String })`,
            `{ readonly [typeof _symbol]: string }`
          ),
          artifacts: [{
            _tag: "Symbol",
            identifier: "_symbol",
            generation: makeCode(`Symbol.for("a")`, `typeof _symbol`)
          }]
        }
      )
    })
  })

  it("Record(String, Number)", () => {
    assertSchema(
      {
        schema: Schema.Record(Schema.String, Schema.Number)
      },
      {
        codes: makeCode("Schema.Record(Schema.String, Schema.Number)", "{ readonly [x: string]: number }")
      }
    )
    assertSchema(
      {
        schema: Schema.Record(Schema.String, Schema.Number).annotate({ "description": "a" })
      },
      {
        codes: makeCode(
          `Schema.Record(Schema.String, Schema.Number).annotate({ "description": "a" })`,
          "{ readonly [x: string]: number }"
        )
      }
    )
  })

  it("StructWithRest", () => {
    assertSchema(
      {
        schema: Schema.StructWithRest(Schema.Struct({ a: Schema.Number }), [
          Schema.Record(Schema.String, Schema.Boolean)
        ])
      },
      {
        codes: makeCode(
          `Schema.StructWithRest(Schema.Struct({ "a": Schema.Number }), [Schema.Record(Schema.String, Schema.Boolean)])`,
          `{ readonly "a": number, readonly [x: string]: boolean }`
        )
      }
    )
    assertSchema(
      {
        schema: Schema.StructWithRest(Schema.Struct({ a: Schema.Number }), [
          Schema.Record(Schema.String, Schema.Boolean)
        ]).annotate({ description: "a" })
      },
      {
        codes: makeCode(
          `Schema.StructWithRest(Schema.Struct({ "a": Schema.Number }), [Schema.Record(Schema.String, Schema.Boolean)]).annotate({ "description": "a" })`,
          `{ readonly "a": number, readonly [x: string]: boolean }`
        )
      }
    )
  })

  describe("Union", () => {
    it("union with anyOf mode (default)", () => {
      assertSchema(
        {
          schema: Schema.Union([Schema.String, Schema.Number])
        },
        {
          codes: makeCode("Schema.Union([Schema.String, Schema.Number])", "string | number")
        }
      )
      assertSchema(
        {
          schema: Schema.Union([Schema.String, Schema.Number]).annotate({ "description": "z" })
        },
        {
          codes: makeCode(
            `Schema.Union([Schema.String, Schema.Number]).annotate({ "description": "z" })`,
            "string | number"
          )
        }
      )
    })

    it("union with oneOf mode", () => {
      assertSchema(
        {
          schema: Schema.Union([Schema.String, Schema.Number], { mode: "oneOf" })
        },
        {
          codes: makeCode(
            `Schema.Union([Schema.String, Schema.Number], { mode: "oneOf" })`,
            "string | number"
          )
        }
      )
      assertSchema(
        {
          schema: Schema.Union([Schema.String, Schema.Number], { mode: "oneOf" }).annotate({ "description": "aa" })
        },
        {
          codes: makeCode(
            `Schema.Union([Schema.String, Schema.Number], { mode: "oneOf" }).annotate({ "description": "aa" })`,
            "string | number"
          )
        }
      )
    })

    it("union with multiple types", () => {
      assertSchema(
        {
          schema: Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
        },
        {
          codes: makeCode(
            "Schema.Union([Schema.String, Schema.Number, Schema.Boolean])",
            "string | number | boolean"
          )
        }
      )
      assertSchema(
        {
          schema: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]).annotate({ "description": "a" })
        },
        {
          codes: makeCode(
            `Schema.Union([Schema.String, Schema.Number, Schema.Boolean]).annotate({ "description": "a" })`,
            "string | number | boolean"
          )
        }
      )
    })
  })

  describe("suspend", () => {
    it("non-recursive", () => {
      assertSchema(
        {
          schema: Schema.suspend(() => Schema.String)
        },
        {
          codes: makeCode(`Schema.suspend((): Schema.Codec<string> => Schema.String)`, "string")
        }
      )
    })

    it("no identifier annotation", () => {
      type A = {
        readonly a?: A
      }
      const A = Schema.Struct({
        a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A))
      })

      assertSchema({ schema: A }, {
        codes: makeCode(`Objects_`, `Objects_`),
        references: {
          recursives: {
            Objects_: makeCode(
              `Schema.Struct({ "a": Schema.optionalKey(Schema.suspend((): Schema.Codec<Objects_> => Objects_)) })`,
              `{ readonly "a"?: Objects_ }`
            )
          }
        }
      })
    })

    it("outer identifier annotation", () => {
      type A = {
        readonly a?: A
      }
      const A = Schema.Struct({
        a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A))
      }).annotate({ identifier: "A" }) // outer identifier annotation

      assertSchema({ schema: A }, {
        codes: makeCode(`A`, `A`),
        references: {
          recursives: {
            A: makeCode(
              `Schema.Struct({ "a": Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A)) }).annotate({ "identifier": "A" })`,
              `{ readonly "a"?: A }`
            )
          }
        }
      })
    })

    it("inner identifier annotation", () => {
      type A = {
        readonly a?: A
      }
      const A = Schema.Struct({
        a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A.annotate({ identifier: "A" })))
      })

      assertSchema({ schema: A }, {
        codes: makeCode(
          `Schema.Struct({ "a": Schema.optionalKey(Suspend_) })`,
          `{ readonly "a"?: Suspend_ }`
        ),
        references: {
          recursives: {
            A: makeCode(
              `Schema.Struct({ "a": Schema.optionalKey(Suspend_) }).annotate({ "identifier": "A" })`,
              `{ readonly "a"?: Suspend_ }`
            ),
            Suspend_: makeCode(
              `Schema.suspend((): Schema.Codec<A> => A)`,
              `A`
            )
          }
        }
      })
    })

    it("suspend identifier annotation", () => {
      type A = {
        readonly a?: A
      }
      const A = Schema.Struct({
        a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A).annotate({ identifier: "A" }))
      })

      assertSchema({ schema: A }, {
        codes: makeCode(`Objects_`, `Objects_`),
        references: {
          recursives: {
            A: makeCode(
              `Schema.suspend((): Schema.Codec<Objects_> => Objects_).annotate({ "identifier": "A" })`,
              `Objects_`
            ),
            Objects_: makeCode(
              `Schema.Struct({ "a": Schema.optionalKey(A) })`,
              `{ readonly "a"?: A }`
            )
          }
        }
      })
    })
  })

  describe("brand", () => {
    it("brand", () => {
      assertSchema(
        {
          schema: Schema.String.pipe(Schema.brand("a"))
        },
        {
          codes: makeCode(
            `Schema.String.pipe(Schema.brand("a"))`,
            `string & Brand.Brand<"a">`
          ),
          artifacts: [{
            _tag: "Import",
            importDeclaration: `import type * as Brand from "effect/Brand"`
          }]
        }
      )
    })

    it("brand & brand", () => {
      assertSchema(
        {
          schema: Schema.String.pipe(Schema.brand("a"), Schema.brand("b"))
        },
        {
          codes: makeCode(
            `Schema.String.pipe(Schema.brand("a"), Schema.brand("b"))`,
            `string & Brand.Brand<"a"> & Brand.Brand<"b">`
          ),
          artifacts: [{
            _tag: "Import",
            importDeclaration: `import type * as Brand from "effect/Brand"`
          }]
        }
      )
    })

    it("check & brand", () => {
      assertSchema(
        {
          schema: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("b"))
        },
        {
          codes: makeCode(
            `Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("b"))`,
            `string & Brand.Brand<"b">`
          ),
          artifacts: [{
            _tag: "Import",
            importDeclaration: `import type * as Brand from "effect/Brand"`
          }]
        }
      )
    })

    it("brand & check & brand", () => {
      assertSchema(
        {
          schema: Schema.String.pipe(Schema.brand("a")).check(Schema.isMinLength(1)).pipe(Schema.brand("b"))
        },
        {
          codes: makeCode(
            `Schema.String.pipe(Schema.brand("a")).check(Schema.isMinLength(1)).pipe(Schema.brand("b"))`,
            `string & Brand.Brand<"a"> & Brand.Brand<"b">`
          ),
          artifacts: [{
            _tag: "Import",
            importDeclaration: `import type * as Brand from "effect/Brand"`
          }]
        }
      )
    })

    it("check & brand & check", () => {
      assertSchema(
        {
          schema: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("b")).check(Schema.isMaxLength(2))
        },
        {
          codes: makeCode(
            `Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("b")).check(Schema.isMaxLength(2))`,
            `string & Brand.Brand<"b">`
          ),
          artifacts: [{
            _tag: "Import",
            importDeclaration: `import type * as Brand from "effect/Brand"`
          }]
        }
      )
    })
  })

  describe("Date", () => {
    it("Date", () => {
      assertSchema({ schema: Schema.Date }, {
        codes: makeCode(`Schema.Date`, "globalThis.Date")
      })
    })

    describe("checks", () => {
      it("isDateValid", () => {
        assertSchema(
          { schema: Schema.Date.check(Schema.isDateValid()) },
          {
            codes: makeCode(`Schema.Date.check(Schema.isDateValid())`, "globalThis.Date")
          }
        )
      })

      it("isGreaterThanDate", () => {
        assertSchema(
          { schema: Schema.Date.check(Schema.isGreaterThanDate(new Date(0))) },
          {
            codes: makeCode(`Schema.Date.check(Schema.isGreaterThanDate(new Date(0)))`, "globalThis.Date")
          }
        )
      })

      it("isGreaterThanOrEqualToDate", () => {
        assertSchema(
          { schema: Schema.Date.check(Schema.isGreaterThanOrEqualToDate(new Date(0))) },
          {
            codes: makeCode(`Schema.Date.check(Schema.isGreaterThanOrEqualToDate(new Date(0)))`, "globalThis.Date")
          }
        )
      })

      it("isLessThanDate", () => {
        assertSchema(
          { schema: Schema.Date.check(Schema.isLessThanDate(new Date(0))) },
          {
            codes: makeCode(`Schema.Date.check(Schema.isLessThanDate(new Date(0)))`, "globalThis.Date")
          }
        )
      })

      it("isLessThanOrEqualToDate", () => {
        assertSchema(
          { schema: Schema.Date.check(Schema.isLessThanOrEqualToDate(new Date(0))) },
          {
            codes: makeCode(`Schema.Date.check(Schema.isLessThanOrEqualToDate(new Date(0)))`, "globalThis.Date")
          }
        )
      })

      it("isBetweenDate", () => {
        assertSchema(
          { schema: Schema.Date.check(Schema.isBetweenDate({ minimum: new Date(0), maximum: new Date(1) })) },
          {
            codes: makeCode(
              `Schema.Date.check(Schema.isBetweenDate({ minimum: new Date(0), maximum: new Date(1), exclusiveMinimum: undefined, exclusiveMaximum: undefined))`,
              "globalThis.Date"
            )
          }
        )
      })
    })
  })

  describe("ReadonlySet", () => {
    it("ReadonlySet(String)", () => {
      assertSchema({ schema: Schema.ReadonlySet(Schema.String) }, {
        codes: makeCode(
          `Schema.ReadonlySet(Schema.String)`,
          "globalThis.ReadonlySet<string>"
        )
      })
    })

    describe("checks", () => {
      it("isMinSize", () => {
        assertSchema(
          { schema: Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(2)) },
          {
            codes: makeCode(
              `Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(2))`,
              "globalThis.ReadonlySet<string>"
            )
          }
        )
      })

      it("isMaxSize", () => {
        assertSchema(
          { schema: Schema.ReadonlySet(Schema.String).check(Schema.isMaxSize(2)) },
          {
            codes: makeCode(
              `Schema.ReadonlySet(Schema.String).check(Schema.isMaxSize(2))`,
              "globalThis.ReadonlySet<string>"
            )
          }
        )
      })
    })

    it("isSizeBetween", () => {
      assertSchema(
        { schema: Schema.ReadonlySet(Schema.String).check(Schema.isSizeBetween(2, 2)) },
        {
          codes: makeCode(
            `Schema.ReadonlySet(Schema.String).check(Schema.isSizeBetween(2, 2))`,
            "globalThis.ReadonlySet<string>"
          )
        }
      )
    })
  })

  describe("HashMap", () => {
    it("HashMap(String, Number)", () => {
      assertSchema({ schema: Schema.HashMap(Schema.String, Schema.Number) }, {
        codes: makeCode(
          `Schema.HashMap(Schema.String, Schema.Number)`,
          "HashMap.HashMap<string, number>"
        ),
        artifacts: [{ _tag: "Import", importDeclaration: `import * as HashMap from "effect/HashMap"` }]
      })
    })
  })

  describe("allOf", () => {
    it("should resolve references", () => {
      assertJsonSchema({
        schema: {
          allOf: [
            { $ref: "#/$defs/A" }
          ],
          $defs: {
            A: {
              type: "string"
            }
          }
        }
      }, {
        codes: makeCode(`Schema.String`, "string")
      })
    })

    it("should resolve references in definitions", () => {
      assertJsonSchema({
        schema: {
          $ref: "#/$defs/A",
          $defs: {
            A: {
              allOf: [
                { $ref: "#/$defs/B" },
                {
                  type: "object",
                  properties: {
                    a: {
                      type: "string"
                    }
                  },
                  required: ["a"]
                }
              ]
            },
            B: {
              type: "object",
              properties: {
                b: {
                  type: "number"
                }
              },
              required: ["b"]
            }
          }
        }
      }, {
        codes: makeCode(`A`, "A"),
        references: {
          nonRecursives: [
            {
              $ref: "A",
              code: makeCode(
                `Schema.Struct({ "b": Schema.Number.check(Schema.isFinite()), "a": Schema.String })`,
                `{ readonly "b": number, readonly "a": string }`
              )
            }
          ]
        }
      })
    })
  })
})

describe("sanitizeJavaScriptIdentifier", () => {
  const sanitizeJavaScriptIdentifier = SchemaRepresentation.sanitizeJavaScriptIdentifier

  it("returns '_' for empty input", () => {
    strictEqual(sanitizeJavaScriptIdentifier(""), "_")
  })

  it("returns input when already a valid uppercase-start identifier", () => {
    strictEqual(sanitizeJavaScriptIdentifier("Abc"), "Abc")
    strictEqual(sanitizeJavaScriptIdentifier("_"), "_")
    strictEqual(sanitizeJavaScriptIdentifier("$"), "$")
    strictEqual(sanitizeJavaScriptIdentifier("$a_b9"), "$a_b9")
    strictEqual(sanitizeJavaScriptIdentifier("A1b2"), "A1b2")
  })

  it("uppercases a leading ASCII letter", () => {
    strictEqual(sanitizeJavaScriptIdentifier("abc"), "Abc")
    strictEqual(sanitizeJavaScriptIdentifier("a0"), "A0")
    strictEqual(sanitizeJavaScriptIdentifier("a1b2c3"), "A1b2c3")
    strictEqual(sanitizeJavaScriptIdentifier("class"), "Class")
  })

  it("prefixes '_' when starting with a digit", () => {
    strictEqual(sanitizeJavaScriptIdentifier("1"), "_1")
    strictEqual(sanitizeJavaScriptIdentifier("1a"), "_1a")
    strictEqual(sanitizeJavaScriptIdentifier("9lives"), "_9lives")
  })

  it("replaces invalid leading characters with '_'", () => {
    strictEqual(sanitizeJavaScriptIdentifier(" abc"), "_abc")
    strictEqual(sanitizeJavaScriptIdentifier("-a"), "_a")
    strictEqual(sanitizeJavaScriptIdentifier(".a"), "_a")
    strictEqual(sanitizeJavaScriptIdentifier(" a"), "_a")
    strictEqual(sanitizeJavaScriptIdentifier("\ta"), "_a")
  })

  it("replaces invalid characters with '_'", () => {
    strictEqual(sanitizeJavaScriptIdentifier("a-b"), "A_b")
    strictEqual(sanitizeJavaScriptIdentifier("a b"), "A_b")
    strictEqual(sanitizeJavaScriptIdentifier("a.b"), "A_b")
    strictEqual(sanitizeJavaScriptIdentifier("a/b"), "A_b")
  })

  it("replaces multiple invalid characters with '_'", () => {
    strictEqual(sanitizeJavaScriptIdentifier("a-b c"), "A_b_c")
    strictEqual(sanitizeJavaScriptIdentifier("a..b"), "A__b")
    strictEqual(sanitizeJavaScriptIdentifier("a--b"), "A__b")
    strictEqual(sanitizeJavaScriptIdentifier("a b\tc"), "A_b_c")
  })

  it("replaces non-ascii characters with '_' under ASCII rules", () => {
    strictEqual(sanitizeJavaScriptIdentifier("café"), "Caf_")
    strictEqual(sanitizeJavaScriptIdentifier("你好"), "__")
    strictEqual(sanitizeJavaScriptIdentifier("🤖"), "_")
    strictEqual(sanitizeJavaScriptIdentifier("a🤖b"), "A_b")
  })

  it("allows '$' and '_' anywhere", () => {
    strictEqual(sanitizeJavaScriptIdentifier("a$b"), "A$b")
    strictEqual(sanitizeJavaScriptIdentifier("a_b"), "A_b")
    strictEqual(sanitizeJavaScriptIdentifier("$a_b9"), "$a_b9")
  })

  it("keeps already-sanitized results stable (idempotent)", () => {
    const cases = [
      "",
      "abc",
      "_",
      "$",
      "a1b2",
      "a-b",
      "a b",
      "1a",
      "-a",
      "class",
      "café",
      "a🤖b"
    ] as const

    for (const input of cases) {
      const once = sanitizeJavaScriptIdentifier(input)
      const twice = sanitizeJavaScriptIdentifier(once)
      strictEqual(twice, once)
    }
  })

  it("preserves length when only replacements are needed", () => {
    strictEqual(sanitizeJavaScriptIdentifier("a-b").length, "a-b".length)
    strictEqual(sanitizeJavaScriptIdentifier("a b").length, "a b".length)
    strictEqual(sanitizeJavaScriptIdentifier("..").length, "..".length)
  })

  it("increases length only when prefixing is required", () => {
    strictEqual(sanitizeJavaScriptIdentifier("1a"), "_1a")
    strictEqual(sanitizeJavaScriptIdentifier("1a").length, "1a".length + 1)
  })
})

describe("topologicalSort", () => {
  function assertTopologicalSort(
    definitions: Record<string, SchemaRepresentation.Representation>,
    expected: SchemaRepresentation.TopologicalSort
  ) {
    deepStrictEqual(SchemaRepresentation.topologicalSort(definitions), expected)
  }

  it("empty definitions", () => {
    assertTopologicalSort(
      {},
      { nonRecursives: [], recursives: {} }
    )
  })

  it("single definition with no dependencies", () => {
    assertTopologicalSort(
      {
        A: { _tag: "String", checks: [] }
      },
      {
        nonRecursives: [
          { $ref: "A", representation: { _tag: "String", checks: [] } }
        ],
        recursives: {}
      }
    )
  })

  it("multiple independent definitions", () => {
    assertTopologicalSort({
      A: { _tag: "String", checks: [] },
      B: { _tag: "Number", checks: [] },
      C: { _tag: "Boolean" }
    }, {
      nonRecursives: [
        { $ref: "A", representation: { _tag: "String", checks: [] } },
        { $ref: "B", representation: { _tag: "Number", checks: [] } },
        { $ref: "C", representation: { _tag: "Boolean" } }
      ],
      recursives: {}
    })
  })

  it("A -> B -> C", () => {
    assertTopologicalSort({
      A: { _tag: "String", checks: [] },
      B: { _tag: "Reference", $ref: "A" },
      C: { _tag: "Reference", $ref: "B" }
    }, {
      nonRecursives: [
        { $ref: "A", representation: { _tag: "String", checks: [] } },
        { $ref: "B", representation: { _tag: "Reference", $ref: "A" } },
        { $ref: "C", representation: { _tag: "Reference", $ref: "B" } }
      ],
      recursives: {}
    })
  })

  it("A -> B, A -> C", () => {
    assertTopologicalSort({
      A: { _tag: "String", checks: [] },
      B: { _tag: "Reference", $ref: "A" },
      C: { _tag: "Reference", $ref: "A" }
    }, {
      nonRecursives: [
        { $ref: "A", representation: { _tag: "String", checks: [] } },
        { $ref: "B", representation: { _tag: "Reference", $ref: "A" } },
        { $ref: "C", representation: { _tag: "Reference", $ref: "A" } }
      ],
      recursives: {}
    })
  })

  it("A -> B -> C, A -> D", () => {
    assertTopologicalSort({
      A: { _tag: "String", checks: [] },
      B: { _tag: "Reference", $ref: "A" },
      C: { _tag: "Reference", $ref: "B" },
      D: { _tag: "Reference", $ref: "A" }
    }, {
      nonRecursives: [
        { $ref: "A", representation: { _tag: "String", checks: [] } },
        { $ref: "B", representation: { _tag: "Reference", $ref: "A" } },
        { $ref: "D", representation: { _tag: "Reference", $ref: "A" } },
        { $ref: "C", representation: { _tag: "Reference", $ref: "B" } }
      ],
      recursives: {}
    })
  })

  it("self-referential definition (A -> A)", () => {
    assertTopologicalSort({
      A: { _tag: "Reference", $ref: "A" }
    }, {
      nonRecursives: [],
      recursives: {
        A: { _tag: "Reference", $ref: "A" }
      }
    })
  })

  it("mutual recursion (A -> B -> A)", () => {
    assertTopologicalSort({
      A: { _tag: "Reference", $ref: "B" },
      B: { _tag: "Reference", $ref: "A" }
    }, {
      nonRecursives: [],
      recursives: {
        A: { _tag: "Reference", $ref: "B" },
        B: { _tag: "Reference", $ref: "A" }
      }
    })
  })

  it("complex cycle (A -> B -> C -> A)", () => {
    assertTopologicalSort({
      A: { _tag: "Reference", $ref: "B" },
      B: { _tag: "Reference", $ref: "C" },
      C: { _tag: "Reference", $ref: "A" }
    }, {
      nonRecursives: [],
      recursives: {
        A: { _tag: "Reference", $ref: "B" },
        B: { _tag: "Reference", $ref: "C" },
        C: { _tag: "Reference", $ref: "A" }
      }
    })
  })

  it("mixed recursive and non-recursive definitions", () => {
    assertTopologicalSort({
      A: { _tag: "String", checks: [] },
      B: { _tag: "Reference", $ref: "A" },
      C: { _tag: "Reference", $ref: "C" },
      D: { _tag: "Reference", $ref: "E" },
      E: { _tag: "Reference", $ref: "D" }
    }, {
      nonRecursives: [
        { $ref: "A", representation: { _tag: "String", checks: [] } },
        { $ref: "B", representation: { _tag: "Reference", $ref: "A" } }
      ],
      recursives: {
        C: { _tag: "Reference", $ref: "C" },
        D: { _tag: "Reference", $ref: "E" },
        E: { _tag: "Reference", $ref: "D" }
      }
    })
  })

  it("nested $ref in object properties", () => {
    assertTopologicalSort({
      A: { _tag: "String", checks: [] },
      B: {
        _tag: "Objects",
        propertySignatures: [{
          name: "value",
          type: { _tag: "Reference", $ref: "A" },
          isOptional: false,
          isMutable: false
        }],
        indexSignatures: [],
        checks: []
      }
    }, {
      nonRecursives: [
        { $ref: "A", representation: { _tag: "String", checks: [] } },
        {
          $ref: "B",
          representation: {
            _tag: "Objects",
            propertySignatures: [{
              name: "value",
              type: { _tag: "Reference", $ref: "A" },
              isOptional: false,
              isMutable: false
            }],
            indexSignatures: [],
            checks: []
          }
        }
      ],
      recursives: {}
    })
  })

  it("nested $ref in array rest", () => {
    assertTopologicalSort({
      A: { _tag: "String", checks: [] },
      B: {
        _tag: "Arrays",
        elements: [],
        rest: [{ _tag: "Reference", $ref: "A" }],
        checks: []
      }
    }, {
      nonRecursives: [
        { $ref: "A", representation: { _tag: "String", checks: [] } },
        {
          $ref: "B",
          representation: { _tag: "Arrays", elements: [], rest: [{ _tag: "Reference", $ref: "A" }], checks: [] }
        }
      ],
      recursives: {}
    })
  })

  it("external $ref (not in definitions) should be ignored", () => {
    assertTopologicalSort({
      A: { _tag: "Reference", $ref: "#/definitions/External" },
      B: { _tag: "Reference", $ref: "A" }
    }, {
      nonRecursives: [
        { $ref: "A", representation: { _tag: "Reference", $ref: "#/definitions/External" } },
        { $ref: "B", representation: { _tag: "Reference", $ref: "A" } }
      ],
      recursives: {}
    })
  })

  it("multiple cycles with independent definitions", () => {
    assertTopologicalSort({
      Independent: { _tag: "String", checks: [] },
      A: { _tag: "Reference", $ref: "B" },
      B: { _tag: "Reference", $ref: "A" },
      C: { _tag: "Reference", $ref: "D" },
      D: { _tag: "Reference", $ref: "C" }
    }, {
      nonRecursives: [
        { $ref: "Independent", representation: { _tag: "String", checks: [] } }
      ],
      recursives: {
        A: { _tag: "Reference", $ref: "B" },
        B: { _tag: "Reference", $ref: "A" },
        C: { _tag: "Reference", $ref: "D" },
        D: { _tag: "Reference", $ref: "C" }
      }
    })
  })

  it("definition depending on recursive definition", () => {
    assertTopologicalSort({
      A: { _tag: "Reference", $ref: "A" },
      B: { _tag: "Reference", $ref: "A" }
    }, {
      nonRecursives: [
        { $ref: "B", representation: { _tag: "Reference", $ref: "A" } }
      ],
      recursives: {
        A: { _tag: "Reference", $ref: "A" }
      }
    })
  })
})
