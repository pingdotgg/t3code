import { afterAll, assert, describe, it } from "@effect/vitest"
import {
  Brand,
  Cause,
  type Codegen,
  Exit,
  HashMap,
  JsonSchema,
  Option,
  Redacted,
  Result,
  Schema,
  type SchemaAST,
  SchemaRepresentation
} from "effect"
import { checkGeneratedModules, withGeneratedModule } from "../../utils/generatedModule.ts"
import { declaration, declarationNames, makeModule } from "../../utils/schemaCodegen.ts"

type Generated = Record<string, Schema.Codec<unknown>>
type Samples = { readonly accepts: ReadonlyArray<unknown>; readonly rejects: ReadonlyArray<unknown> }

const compilation = new Map<string, string>()

function generate(...schemas: readonly [Schema.Constraint, ...Array<Schema.Constraint>]) {
  const input = SchemaRepresentation.toRepresentations([
    schemas[0].ast,
    ...schemas.slice(1).map((schema) => schema.ast)
  ])
  return makeModule(input)
}

function symbolValue(schema: Schema.Codec<unknown>): symbol {
  assert.strictEqual(schema.ast._tag, "UniqueSymbol")
  if (schema.ast._tag !== "UniqueSymbol") return assert.fail("Expected a symbol schema")
  return schema.ast.symbol
}

function referenceNames(module: Codegen.Module): ReadonlyArray<string> {
  return declarationNames(module).filter((name) => !name.startsWith("TestRoot"))
}

function assertSamples(schema: Schema.Codec<unknown>, { accepts, rejects }: Samples): void {
  const decode = Schema.decodeUnknownSync(schema)
  const encode = Schema.encodeSync(schema)
  for (const value of accepts) {
    const decoded = decode(value)
    assert.deepStrictEqual(decoded, value)
    assert.deepStrictEqual(encode(decoded), value)
  }
  for (const value of rejects) {
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(schema)(value)), "Expected a schema validation failure")
  }
}

// Equality also checks readonly, optional, any and never distinctions.
const typeAssertions = [
  "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false",
  "type Normalize<T> = T extends object ? { [K in keyof T]: T[K] } : T",
  "type Assert<A extends true> = A"
].join("\n")

function register(name: string, source: string, expectedTypes: ReadonlyArray<string> = []): void {
  const checks = expectedTypes.flatMap((expected, i) => [
    "type Alias" + i + " = Assert<Equal<Normalize<TestRoot" + i + ">, Normalize<" + expected + ">>>",
    "type Inferred" + i + " = Assert<Equal<Normalize<typeof TestRoot" + i + ".Type>, Normalize<" + expected + ">>>"
  ])
  compilation.set(
    String(compilation.size).padStart(3, "0") + "_" + name.replaceAll(/[^a-zA-Z0-9_-]/g, "_"),
    source + "\n" + typeAssertions + "\n" + checks.join("\n")
  )
}

function example(name: string, schema: Schema.Top, expectedType: string, samples: Samples): void {
  it(name, async () => {
    const document = generate(schema)
    const source = document.print()
    register(name, source, [expectedType])
    await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => assertSamples(TestRoot0, samples))
    // Exercise annotations on every schema shape without normalizing generated code.
    const annotated = generate(schema.annotate({ description: "generated annotation" })).print()
    await withGeneratedModule<Generated>(annotated, ({ TestRoot0 }) => {
      assert.strictEqual(Schema.resolveAnnotations(TestRoot0)?.description, "generated annotation")
      assertSamples(TestRoot0, samples)
    })
  })
}

function fromJson(schema: JsonSchema.JsonSchema): Schema.Top {
  return SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(schema), {
    onEnter: (js) =>
      js.type === "object" && js.additionalProperties === undefined ? { ...js, additionalProperties: false } : js
  })
}

describe("Codegen.Module.addSchemas", { concurrent: false }, () => {
  describe("values and generated types", () => {
    example("Null", Schema.Null, "null", { accepts: [null], rejects: [undefined, 0] })
    example("Undefined", Schema.Undefined, "undefined", { accepts: [undefined], rejects: [null, 0] })
    example("Void", Schema.Void, "void", { accepts: [undefined], rejects: [] })
    example("Never", Schema.Never, "never", { accepts: [], rejects: [undefined, null, {}, 0] })
    example("Unknown", Schema.Unknown, "unknown", { accepts: [null, undefined, {}, 1], rejects: [] })
    example("Any", Schema.Any, "any", { accepts: [null, undefined, {}, 1], rejects: [] })
    example("String", Schema.String, "string", { accepts: ["", "a"], rejects: [1, null] })
    example("Number", Schema.Number, "number", { accepts: [0, NaN, Infinity], rejects: ["1", null] })
    example("Boolean", Schema.Boolean, "boolean", { accepts: [true, false], rejects: [0, "true"] })
    example("BigInt", Schema.BigInt, "bigint", { accepts: [0n, -1n], rejects: [0, "0"] })
    example("Symbol", Schema.Symbol, "symbol", { accepts: [Symbol(), Symbol.for("a")], rejects: ["a"] })
    example("ObjectKeyword", Schema.ObjectKeyword, "object", { accepts: [{}, []], rejects: [null, 1] })
    example("empty annotations", Schema.Null.annotate({}), "null", { accepts: [null], rejects: [undefined] })
    for (const value of ["a", 1, true, 100n, "quote\"\n\\`"] as const) {
      example(
        "Literal " + String(value),
        Schema.Literal(value),
        typeof value === "bigint" ? "100n" : JSON.stringify(value),
        {
          accepts: [value],
          rejects: [null, "different"]
        }
      )
    }
    example("empty tuple", Schema.Tuple([]), "readonly []", { accepts: [[]], rejects: [[1], null] })
    example("required tuple", Schema.Tuple([Schema.String]), "readonly [string]", {
      accepts: [["a"]],
      rejects: [[], [1]]
    })
    example("optional tuple", Schema.Tuple([Schema.optionalKey(Schema.String)]), "readonly [string?]", {
      accepts: [[], ["a"]],
      rejects: [[1], ["a", "b"], [undefined]]
    })
    example(
      "optional union tuple",
      Schema.Tuple([Schema.optionalKey(Schema.Union([Schema.String, Schema.Number]))]),
      "readonly [(string | number)?]",
      { accepts: [[], ["a"], [1]], rejects: [[true]] }
    )
    example(
      "optional literals tuple",
      Schema.Tuple([Schema.optionalKey(Schema.Literals(["a", "b"]))]),
      "readonly [(\"a\" | \"b\")?]",
      { accepts: [[], ["a"], ["b"]], rejects: [["c"]] }
    )
    example(
      "optional nested tuple",
      Schema.Tuple([Schema.optionalKey(Schema.Tuple([Schema.String]))]),
      "readonly [(readonly [string])?]",
      { accepts: [[], [["a"]]], rejects: [[[]], [["a", "b"]]] }
    )
    example("Array", Schema.Array(Schema.String), "ReadonlyArray<string>", {
      accepts: [[], ["a", "b"]],
      rejects: [[1], null]
    })
    example(
      "required tuple with rest",
      Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number]),
      "readonly [string, ...Array<number>]",
      { accepts: [["a"], ["a", 1, 2]], rejects: [[], ["a", true]] }
    )
    example(
      "optional tuple with rest",
      Schema.TupleWithRest(Schema.Tuple([Schema.optionalKey(Schema.Union([Schema.String, Schema.Number]))]), [
        Schema.Boolean
      ]),
      "readonly [(string | number)?, ...Array<boolean>]",
      {
        accepts: [[], ["a"], [1, true, false]],
        rejects: [[true], ["a", 1]]
      }
    )
    example(
      "tuple with post-rest element",
      Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number, Schema.Boolean]),
      "readonly [string, ...Array<number>, boolean]",
      {
        accepts: [["a", true], ["a", 1, 2, false]],
        rejects: [["a"], ["a", true, 1]]
      }
    )
    example(
      "rest with post-rest and no prefix",
      Schema.TupleWithRest(Schema.Tuple([]), [Schema.Number, Schema.Boolean]),
      "readonly [...Array<number>, boolean]",
      { accepts: [[true], [1, 2, false]], rejects: [[], [true, 1]] }
    )
    example("empty struct", Schema.Struct({}), "{}", { accepts: [{}], rejects: [null] })
    example(
      "required properties",
      Schema.Struct({ a: Schema.String, b: Schema.Number }),
      "{ readonly a: string; readonly b: number }",
      {
        accepts: [{ a: "a", b: 1 }],
        rejects: [{ a: "a" }, { a: 1, b: 1 }]
      }
    )
    example("optional property", Schema.Struct({ a: Schema.optionalKey(Schema.String) }), "{ readonly a?: string }", {
      accepts: [{}, { a: "a" }],
      rejects: [{ a: 1 }, { a: undefined }]
    })
    example("mutable property", Schema.Struct({ a: Schema.mutableKey(Schema.String) }), "{ a: string }", {
      accepts: [{ a: "a" }],
      rejects: [{}, { a: 1 }]
    })
    example(
      "optional mutable property",
      Schema.Struct({ a: Schema.optionalKey(Schema.mutableKey(Schema.String)) }),
      "{ a?: string }",
      { accepts: [{}, { a: "a" }], rejects: [{ a: 1 }] }
    )
    example(
      "required __proto__ property",
      Schema.Struct({ ["__proto__"]: Schema.String }),
      "{ readonly \"__proto__\": string }",
      {
        accepts: [{ ["__proto__"]: "value" }],
        rejects: [{}, { ["__proto__"]: 123 }]
      }
    )
    example(
      "optional __proto__ property",
      Schema.Struct({ ["__proto__"]: Schema.optionalKey(Schema.String) }),
      "{ readonly \"__proto__\"?: string }",
      {
        accepts: [{}, { ["__proto__"]: "value" }],
        rejects: [{ ["__proto__"]: 123 }]
      }
    )
    example("escaped property", Schema.Struct({ ["\"\n\\"]: Schema.String }), "{ readonly \"\\\"\\n\\\\\": string }", {
      accepts: [{ ["\"\n\\"]: "a" }],
      rejects: [{}, { ["\"\n\\"]: 1 }]
    })
    example("numeric property", Schema.Struct({ 1: Schema.Boolean }), "{ readonly 1: boolean }", {
      accepts: [{ 1: true }],
      rejects: [{}, { 1: "true" }]
    })
    example("Record", Schema.Record(Schema.String, Schema.Number), "{ readonly [x: string]: number }", {
      accepts: [{}, { a: 1, b: 2 }],
      rejects: [{ a: "a" }]
    })
    example(
      "StructWithRest",
      Schema.StructWithRest(Schema.Struct({ a: Schema.Number }), [
        Schema.Record(Schema.String, Schema.Number)
      ]),
      "{ readonly a: number } & { readonly [x: string]: number }",
      {
        accepts: [{ a: 1 }, { a: 1, b: 2 }],
        rejects: [{}, { a: 1, b: "a" }]
      }
    )
    example(
      "multiple index signatures",
      Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(Schema.String, Schema.Number),
        Schema.Record(Schema.Symbol, Schema.Boolean)
      ]),
      "{ readonly [x: string]: number; readonly [x: symbol]: boolean }",
      {
        accepts: [{}, { a: 1, [Symbol.for("a")]: true }],
        rejects: [{ a: false }, { [Symbol.for("a")]: 1 }]
      }
    )
    example("Union anyOf", Schema.Union([Schema.String, Schema.Number]), "string | number", {
      accepts: ["a", 1],
      rejects: [true, null]
    })
    example(
      "Union multiple members",
      Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
      "string | number | boolean",
      {
        accepts: ["a", 1, true],
        rejects: [null]
      }
    )
    example("Union overlapping anyOf", Schema.Union([Schema.String, Schema.Literal("a")]), "string", {
      accepts: ["a", "b"],
      rejects: [1]
    })
    example(
      "Union overlapping oneOf",
      Schema.Union([Schema.String, Schema.Literal("a")], { mode: "oneOf" }),
      "string",
      {
        accepts: ["b"],
        rejects: ["a", 1]
      }
    )
    example("non-recursive suspension", Schema.suspend(() => Schema.String), "string", { accepts: ["a"], rejects: [1] })
    example("brands omitted", Schema.String.pipe(Schema.brand("a"), Schema.brand("b")), "string", {
      accepts: ["a"],
      rejects: [1]
    })
    example(
      "union brands omitted",
      Schema.Union([Schema.String, Schema.Number]).pipe(Schema.brand("a")),
      "string | number",
      {
        accepts: ["a", 1],
        rejects: [true]
      }
    )
  })

  describe("checks", () => {
    const stringChecks: ReadonlyArray<
      readonly [string, SchemaAST.Check<string>, ReadonlyArray<string>, ReadonlyArray<string>]
    > = [
      ["min length", Schema.isMinLength(1), ["a"], [""]],
      ["min code points", Schema.isMinCodePoints(2), ["😀a"], ["😀"]],
      ["max code points", Schema.isMaxCodePoints(3), ["😀😀😀"], ["abcd"]],
      ["between code points", Schema.isBetweenCodePoints(2, 3), ["😀a", "abc"], ["😀", "abcd"]],
      ["starts with", Schema.isStartingWith("a"), ["ab"], ["ba"]],
      ["ends with", Schema.isEndingWith("a"), ["ba"], ["ab"]],
      ["includes", Schema.isIncluding("a"), ["bab"], ["bb"]],
      ["GUID", Schema.isGUID({ message: "message" }), ["00000000-0000-0000-0000-000000000000"], ["a"]],
      ["ASCII", Schema.isAscii(), ["abc"], ["é"]],
      ["pattern and flags", Schema.isPattern(/^a+$/i), ["AAA"], ["b"]]
    ]
    for (const [name, check, accepts, rejects] of stringChecks) {
      example(name, Schema.String.check(check), "string", { accepts, rejects })
    }
    example("Finite", Schema.Finite, "number", { accepts: [0, 1.5], rejects: [NaN, Infinity, -Infinity] })
    example("Int", Schema.Int, "number", { accepts: [0, 1], rejects: [1.5, Infinity] })
    example("canonical finite then check", Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)), "number", {
      accepts: [1],
      rejects: [0, Infinity]
    })
    example("check then finite", Schema.Number.check(Schema.isGreaterThan(0), Schema.isFinite()), "number", {
      accepts: [1],
      rejects: [0, Infinity]
    })
    example(
      "finite with node annotation",
      Schema.Number.annotate({ description: "a" }).check(Schema.isFinite()),
      "number",
      {
        accepts: [1],
        rejects: [Infinity]
      }
    )
    example("finite custom expected", Schema.Number.check(Schema.isFinite({ expected: "a real number" })), "number", {
      accepts: [1],
      rejects: [Infinity]
    })
    example("aborting finite", Schema.Number.check(Schema.isFinite().abort()), "number", {
      accepts: [1],
      rejects: [Infinity]
    })
    example(
      "filter group",
      Schema.Number.check(Schema.makeFilterGroup([Schema.isFinite(), Schema.isGreaterThan(0)])),
      "number",
      { accepts: [1], rejects: [0, Infinity] }
    )
    example("greater than", Schema.Number.check(Schema.isGreaterThan(10)), "number", { accepts: [11], rejects: [10] })
    example("greater than bigint", Schema.BigInt.check(Schema.isGreaterThanBigInt(10n)), "bigint", {
      accepts: [11n],
      rejects: [10n]
    })
    const Int = Brand.check<number & Brand.Brand<"Int">>(Schema.isInt())
    const Positive = Brand.check<number & Brand.Brand<"Positive">>(Schema.isGreaterThan(0))
    example(
      "fromBrand retains checks",
      Schema.Number.pipe(Schema.fromBrand("Int", Int), Schema.fromBrand("Positive", Positive)),
      "number",
      { accepts: [1], rejects: [0, -1, 1.5] }
    )
    for (
      const [name, check, accepts, rejects] of [
        ["date greater", Schema.isGreaterThanDate(new Date(0)), [1], [0, -1]],
        ["date greater equal", Schema.isGreaterThanOrEqualToDate(new Date(0)), [0, 1], [-1]],
        ["date less", Schema.isLessThanDate(new Date(0)), [-1], [0, 1]],
        ["date less equal", Schema.isLessThanOrEqualToDate(new Date(0)), [-1, 0], [1]],
        ["date between", Schema.isBetweenDate({ minimum: new Date(0), maximum: new Date(1) }), [0, 1], [-1, 2]]
      ] as const
    ) {
      example(name, Schema.Date.check(check), "globalThis.Date", {
        accepts: accepts.map((n) => new Date(n)),
        rejects: rejects.map((n) => new Date(n))
      })
    }
    for (
      const [name, check, accepts, rejects] of [
        ["set min size", Schema.isMinSize(2), [["a", "b"]], [["a"]]],
        ["set max size", Schema.isMaxSize(2), [["a", "b"]], [["a", "b", "c"]]],
        ["set between size", Schema.isBetweenSize(2, 2), [["a", "b"]], [["a"], ["a", "b", "c"]]]
      ] as const
    ) {
      example(name, Schema.ReadonlySet(Schema.String).check(check), "ReadonlySet<string>", {
        accepts: accepts.map((values) => new Set(values)),
        rejects: rejects.map((values) => new Set(values))
      })
    }
  })

  describe("declarations", () => {
    example("Error", Schema.ErrorInstance(), "globalThis.Error", { accepts: [new Error("error")], rejects: ["error"] })
    example("Error with stack", Schema.ErrorInstance({ includeStack: true }), "globalThis.Error", {
      accepts: [new Error("error")],
      rejects: ["error"]
    })
    example("Error without cause", Schema.ErrorInstance({ excludeCause: true }), "globalThis.Error", {
      accepts: [new Error("error")],
      rejects: ["error"]
    })
    example("RegExp", Schema.RegExp, "globalThis.RegExp", { accepts: [/a+/gi], rejects: ["/a/"] })
    example("URL", Schema.URL, "globalThis.URL", {
      accepts: [new URL("https://example.com")],
      rejects: ["https://example.com"]
    })
    example("Uint8Array", Schema.Uint8Array, "globalThis.Uint8Array", {
      accepts: [new Uint8Array([1])],
      rejects: [[1]]
    })
    example("URLSearchParams", Schema.URLSearchParams, "globalThis.URLSearchParams", {
      accepts: [new URLSearchParams("a=1")],
      rejects: ["a=1"]
    })
    example("File", Schema.File, "globalThis.File", { accepts: [new File(["a"], "a.txt")], rejects: ["a.txt"] })
    example("FormData", Schema.FormData, "globalThis.FormData", { accepts: [new FormData()], rejects: [{}] })
    example("Date", Schema.Date, "globalThis.Date", { accepts: [new Date(0)], rejects: [0] })
    example("Option", Schema.Option(Schema.String), "Option.Option<string>", {
      accepts: [Option.none(), Option.some("a")],
      rejects: [Option.some(1), null]
    })
    example("Result", Schema.Result(Schema.String, Schema.Number), "Result.Result<string, number>", {
      accepts: [Result.succeed("a"), Result.fail(1)],
      rejects: [Result.succeed(1), Result.fail("a")]
    })
    example(
      "Redacted",
      Schema.Redacted(Schema.String, { label: "password", disallowJsonEncode: true }),
      "Redacted.Redacted<string>",
      {
        accepts: [Redacted.make("a", { label: "password" })],
        rejects: [Redacted.make(1), "a"]
      }
    )
    example("CauseReason", Schema.CauseReason(Schema.String, Schema.Number), "Cause.Reason<string>", {
      accepts: [Cause.makeFailReason("a"), Cause.makeDieReason(1)],
      rejects: [Cause.makeFailReason(1), Cause.makeDieReason("a")]
    })
    example("Cause", Schema.Cause(Schema.String, Schema.Number), "Cause.Cause<string>", {
      accepts: [Cause.fail("a"), Cause.die(1)],
      rejects: [Cause.fail(1), Cause.die("a")]
    })
    example("Exit", Schema.Exit(Schema.String, Schema.Number, Schema.Boolean), "Exit.Exit<string, number>", {
      accepts: [Exit.succeed("a"), Exit.fail(1), Exit.die(true)],
      rejects: [Exit.succeed(1), Exit.fail("a"), Exit.die(1)]
    })
    example("ReadonlySet", Schema.ReadonlySet(Schema.String), "ReadonlySet<string>", {
      accepts: [new Set(), new Set(["a"])],
      rejects: [new Set([1]), []]
    })
    example("HashMap", Schema.HashMap(Schema.String, Schema.Number), "HashMap.HashMap<string, number>", {
      accepts: [HashMap.empty(), HashMap.make(["a", 1])],
      rejects: [HashMap.make(["a", "b"]), {}]
    })
  })

  describe("templates", () => {
    example("empty template", Schema.TemplateLiteral([]), "\"\"", { accepts: [""], rejects: ["a"] })
    for (const value of ["a", 1, 1n, "`", "${number}", "\\", "\n"] as const) {
      example(
        "template literal " + typeof value + " " + String(value),
        Schema.TemplateLiteral([Schema.Literal(value)]),
        JSON.stringify(String(value)),
        {
          accepts: [String(value)],
          rejects: ["wrong", 1]
        }
      )
    }
    example(
      "consecutive literals",
      Schema.TemplateLiteral([Schema.Literal("a"), Schema.Literal("b"), Schema.Literal("c")]),
      "\"abc\"",
      { accepts: ["abc"], rejects: ["ab", "acb"] }
    )
    const template = (types: ReadonlyArray<string>) => "`" + types.map((type) => "${" + type + "}").join("") + "`"
    for (
      const [name, part, type, valid, invalid] of [
        ["string", Schema.String, "string", "x", null],
        ["number", Schema.Number, "number", "1.5", "x"],
        ["bigint", Schema.BigInt, "bigint", "123", "1.5"]
      ] as const
    ) {
      example("template " + name, Schema.TemplateLiteral([part]), template([type]), {
        accepts: [valid],
        rejects: [invalid]
      })
      example(
        "template " + name + " then literal",
        Schema.TemplateLiteral([part, Schema.Literal("a")]),
        template([type, "\"a\""]),
        {
          accepts: [valid + "a"],
          rejects: ["b"]
        }
      )
      example(
        "template literal then " + name,
        Schema.TemplateLiteral([Schema.Literal("a b\n"), part]),
        template(["\"a b\\n\"", type]),
        {
          accepts: ["a b\n" + valid],
          rejects: ["a"]
        }
      )
    }
    example(
      "template schemas",
      Schema.TemplateLiteral([Schema.String, Schema.Number]),
      template(["string", "number"]),
      {
        accepts: ["abc123"],
        rejects: ["abc"]
      }
    )
    example(
      "template separated schemas",
      Schema.TemplateLiteral([Schema.String, Schema.Literal("-"), Schema.Number]),
      template(["string", "\"-\"", "number"]),
      { accepts: ["abc-123"], rejects: ["abc-x"] }
    )
    example(
      "nested template",
      Schema.TemplateLiteral([
        Schema.Literal("a"),
        Schema.TemplateLiteral([Schema.String, Schema.Literals(["-", "+"]), Schema.Number])
      ]),
      template(["\"a\"", template(["string", "\"-\" | \"+\"", "number"])]),
      {
        accepts: ["abc-123", "abc+123"],
        rejects: ["bc-123", "abc+x"]
      }
    )
    example(
      "template union",
      Schema.TemplateLiteral([Schema.Literal("a"), Schema.Union([Schema.String, Schema.Number])]),
      template(["\"a\"", "string | number"]),
      { accepts: ["abc", "a123"], rejects: ["bc"] }
    )
    example(
      "template literals",
      Schema.TemplateLiteral([Schema.Literals(["a", "b"]), Schema.String]),
      template(["\"a\" | \"b\"", "string"]),
      { accepts: ["a", "bc"], rejects: ["c"] }
    )
    example(
      "template multiple unions",
      Schema.TemplateLiteral([
        Schema.Union([Schema.Literal("a"), Schema.Literal("b")]),
        Schema.String,
        Schema.Union([Schema.Number, Schema.BigInt])
      ]),
      template(["\"a\" | \"b\"", "string", "number | bigint"]),
      { accepts: ["ab1", "bc1"], rejects: ["c1", "ab"] }
    )
    example(
      "template brands omitted",
      Schema.TemplateLiteral([
        Schema.String.pipe(Schema.brand("StringPart")),
        Schema.Union([Schema.Number.pipe(Schema.brand("NumberPart")), Schema.String.pipe(Schema.brand("OtherPart"))])
      ]),
      template(["string", "number | string"]),
      { accepts: ["abc", "123"], rejects: [1] }
    )
    example(
      "template named branded part",
      Schema.TemplateLiteral([
        Schema.String.pipe(Schema.brand("Part")).annotate({ identifier: "Part" })
      ]),
      "string",
      { accepts: ["abc"], rejects: [1] }
    )

    it("keeps union combinations compact", () => {
      const part = Schema.Literals(["a", "b"])
      const document = generate(Schema.TemplateLiteral(Array.from({ length: 20 }, () => part)))
      // Deliberately avoid asking tsc to expand a million-member union.
      assert.strictEqual(
        declaration(document, "TestRoot0")[0],
        "export type TestRoot0 = " + template(Array.from({ length: 20 }, () => "\"a\" | \"b\""))
      )
      assert.isBelow(declaration(document, "TestRoot0")[0].length, 500)
    })
  })

  describe("artifacts and identifiers", () => {
    for (
      const [name, values, accepts, rejects] of [
        ["string enum", { A: "a", B: "b" }, ["a", "b"], ["c", 1]],
        ["numeric enum", { One: 1, Two: 2 }, [1, 2], [0, "One"]],
        ["mixed enum", { A: "a", One: 1 }, ["a", 1], ["b", 2]]
      ] as const
    ) {
      it(name, async () => {
        const schema = Schema.Enum(values).annotate({ description: "enum" })
        const source = generate(schema).print()
        register(
          name,
          source + [
            "",
            "declare const alias: TestRoot0",
            "declare const inferred: typeof TestRoot0.Type",
            "const asInferred: typeof TestRoot0.Type = alias",
            "const asAlias: TestRoot0 = inferred",
            "// @ts-expect-error An unknown member must not be assignable",
            "const invalid: TestRoot0 = \"not a member\""
          ].join("\n")
        )
        await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => {
          assertSamples(TestRoot0, { accepts, rejects })
          assert.strictEqual(Schema.resolveAnnotations(TestRoot0)?.description, "enum")
        })
      })
    }

    for (const symbol of [Symbol(), Symbol("a"), Symbol.for("a")]) {
      it(
        "preserves " + (Symbol.keyFor(symbol) === undefined ? "local " : "global ") + String(symbol) + " identity",
        async () => {
          const document = generate(
            Schema.UniqueSymbol(symbol).annotate({ description: "symbol" }),
            Schema.Struct({ [symbol]: Schema.String })
          )
          const source = document.print()
          register("symbol " + (Symbol.keyFor(symbol) ?? "local " + symbol.description), source)
          await withGeneratedModule<Record<string, unknown>>(source, (module) => {
            assert.strictEqual(
              Schema.resolveAnnotations(module.TestRoot0 as Schema.Codec<unknown>)?.description,
              "symbol"
            )
            const value = symbolValue(module.TestRoot0 as Schema.Codec<unknown>)
            const propertySchema = module.TestRoot1 as Schema.Codec<unknown>
            assert.strictEqual(propertySchema.ast._tag, "Objects")
            if (propertySchema.ast._tag !== "Objects") return assert.fail("Expected an object schema")
            const key = propertySchema.ast.propertySignatures[0].name
            assert.strictEqual(value.description, symbol.description)
            assert.strictEqual(Symbol.keyFor(value), Symbol.keyFor(symbol))
            assertSamples(module.TestRoot0 as Schema.Codec<unknown>, {
              accepts: [value],
              rejects: [Symbol(symbol.description)]
            })
            assertSamples(module.TestRoot1 as Schema.Codec<unknown>, {
              accepts: [{ [key]: "a" }],
              rejects: [{}, { [key]: 1 }]
            })
            // The same source symbol denotes the same key and literal in both roots.
            assert.strictEqual(key, value)
          })
        }
      )
    }

    it("keeps distinct symbols with identical descriptions distinct", async () => {
      const document = generate(
        Schema.UniqueSymbol(Symbol("same")),
        Schema.UniqueSymbol(Symbol("same"))
      )
      const source = document.print()
      register("distinct symbols with identical descriptions", source)
      await withGeneratedModule<Record<string, unknown>>(source, (module) => {
        const first = symbolValue(module.TestRoot0 as Schema.Codec<unknown>)
        const second = symbolValue(module.TestRoot1 as Schema.Codec<unknown>)
        assert.notStrictEqual(first, second)
        assertSamples(module.TestRoot0 as Schema.Codec<unknown>, { accepts: [first], rejects: [second] })
        assertSamples(module.TestRoot1 as Schema.Codec<unknown>, { accepts: [second], rejects: [first] })
      })
    })

    for (const identifier of ["ID", "hello", "Abc", "Schema", "1a", "0", "a-b", "café", "🤖", "", "__proto__"]) {
      example("identifier " + identifier, Schema.String.annotate({ identifier }), "string", {
        accepts: ["a"],
        rejects: [1]
      })
    }

    it("keeps colliding sanitized identifiers distinct", async () => {
      const schemas = ["a-b", "a_b", "A_b", "Schema"].map((identifier, i) => Schema.Literal(i).annotate({ identifier }))
      const document = generate(schemas[0], ...schemas.slice(1))
      assert.lengthOf(referenceNames(document), schemas.length)
      const source = document.print()
      register("colliding identifiers", source, ["0", "1", "2", "3"])
      await withGeneratedModule<Generated>(source, (module) => {
        for (let i = 0; i < schemas.length; i++) {
          assertSamples(module["TestRoot" + i], { accepts: [i], rejects: [(i + 1) % 4] })
        }
      })
    })

    it("avoids collisions between references and symbol or enum artifacts", async () => {
      const symbol = Symbol.for("artifact")
      const document = generate(
        Schema.String.annotate({ identifier: "_symbol" }),
        Schema.Number.annotate({ identifier: "_Enum" }),
        Schema.UniqueSymbol(symbol),
        Schema.Enum({ A: "a" })
      )
      const source = document.print()
      register("artifact collisions", source)
      await withGeneratedModule<Generated>(source, (module) => {
        assertSamples(module.TestRoot0, { accepts: ["a"], rejects: [1] })
        assertSamples(module.TestRoot1, { accepts: [1], rejects: ["a"] })
        assertSamples(module.TestRoot2, { accepts: [symbol], rejects: [Symbol("artifact")] })
        assertSamples(module.TestRoot3, { accepts: ["a"], rejects: ["b"] })
      })
    })

    it("avoids collisions between reference names and declaration imports", async () => {
      const Named = Schema.String.annotate({ identifier: "Option" })
      const source = generate(Named, Schema.Option(Named)).print()
      register("declaration import collision", source)
      await withGeneratedModule<Generated>(source, (module) => {
        assertSamples(module.TestRoot0, { accepts: ["a"], rejects: [1] })
        assertSamples(module.TestRoot1, { accepts: [Option.some("a")], rejects: [Option.some(1)] })
      })
    })

    it("propagates renamed imports through nested declaration callbacks", async () => {
      const Named = Schema.String.annotate({ identifier: "Option" })
      const source = generate(Schema.Option(Schema.Option(Named))).print()
      register("nested declaration import collision", source, [
        "import(\"effect/Option\").Option<import(\"effect/Option\").Option<string>>"
      ])
      await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => {
        assertSamples(TestRoot0, {
          accepts: [Option.some(Option.some("a"))],
          rejects: [Option.some(Option.some(1))]
        })
      })
    })

    it("reuses the Schema import without rerunning callbacks", async () => {
      let calls = 0
      const Named = Schema.String.annotate({ identifier: "Schema" })
      const schema = Schema.Option(Named).annotate({
        toCode: ({ typeParameters }: SchemaRepresentation.Generation.DeclarationInput) => {
          calls++
          return {
            runtime: `Schema.Option(${typeParameters[0].runtime})`,
            Type: `Option.Option<${typeParameters[0].Type}>`,
            importDeclarations: [
              "import * as Schema from \"effect/Schema\"",
              "import * as Option from \"effect/Option\""
            ]
          }
        }
      })
      const source = generate(schema).print()
      assert.strictEqual(calls, 1)
      register("predefined Schema import", source, ["Option.Option<string>"])
      await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => {
        assertSamples(TestRoot0, { accepts: [Option.some("a")], rejects: [Option.some(1)] })
      })
    })

    it("resolves named and type-only imports without repeating callbacks", async () => {
      const calls: Array<SchemaRepresentation.Code> = []
      let unaffectedCalls = 0
      const document = makeModule({
        references: {
          Box: { _tag: "String", checks: [] },
          BoxType: { _tag: "Number", checks: [] }
        },
        representations: [{
          _tag: "Declaration",
          checks: [],
          typeParameters: [{ _tag: "Reference", $ref: "Box" }],
          annotations: {
            toCode: ({ typeParameters }: SchemaRepresentation.Generation.DeclarationInput) => {
              calls.push(typeParameters[0])
              return {
                runtime: `Box(${typeParameters[0].runtime}).annotate({ description: "Box" })`,
                Type: `BoxType<${typeParameters[0].Type}>`,
                importDeclarations: [
                  `import { /* namespace member */ Option as Box } from 'effect/Schema';`,
                  `import { type Option as BoxType } from "effect/Option"`
                ]
              }
            }
          }
        }, {
          _tag: "Declaration",
          checks: [],
          typeParameters: [],
          annotations: {
            toCode: () => {
              unaffectedCalls++
              return {
                runtime: "Schema.String",
                Type: "string",
                importDeclarations: [`import { Option as Box } from "effect/Schema"`]
              }
            }
          }
        }]
      })
      assert.lengthOf(calls, 1)
      const name = referenceNames(document)[0]
      assert.strictEqual(name, "Box")
      assert.strictEqual(unaffectedCalls, 1)
      const source = document.print()
      register("named import collision", source, ["import(\"effect/Option\").Option<string>", "string"])
      await withGeneratedModule<Generated>(source, ({ TestRoot0, TestRoot1 }) => {
        assertSamples(TestRoot0, { accepts: [Option.some("a")], rejects: [Option.some(1)] })
        assert.strictEqual(Schema.resolveAnnotations(TestRoot0)?.description, "Box")
        assertSamples(TestRoot1, { accepts: ["a"], rejects: [1] })
      })
    })

    it("resolves imports colliding with symbol and enum artifacts", async () => {
      const symbol = Symbol.for("import collision")
      const input = SchemaRepresentation.toRepresentations([
        Schema.UniqueSymbol(symbol).ast,
        Schema.Enum({ A: "a" }).ast
      ])
      const document = makeModule({
        ...input,
        representations: [{
          _tag: "Declaration",
          checks: [],
          typeParameters: input.representations,
          annotations: {
            toCode: ({ typeParameters }: SchemaRepresentation.Generation.DeclarationInput) => ({
              runtime: `Schema.Struct({ s: ${typeParameters[0].runtime}, e: ${typeParameters[1].runtime} })`,
              Type: `{ readonly s: ${typeParameters[0].Type}; readonly e: ${typeParameters[1].Type} }`,
              importDeclarations: [
                `import * as _symbol from "effect/Option"`,
                `import { Enum as _Enum } from "effect/Schema"`
              ]
            })
          }
        }]
      })
      const source = document.print()
      register("artifact import collision", source)
      await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => {
        assertSamples(TestRoot0, {
          accepts: [{ s: symbol, e: "a" }],
          rejects: [{ s: Symbol("import collision"), e: "a" }, { s: symbol, e: "b" }]
        })
      })
    })

    it("resolves imports returned by check callbacks", async () => {
      const document = makeModule({
        references: { Is: { _tag: "String", checks: [] } },
        representations: [{
          _tag: "Unknown",
          checks: [{
            _tag: "Filter",
            aborted: false,
            representation: { id: "test/import", payload: null, schemas: [{ _tag: "Reference", $ref: "Is" }] },
            annotations: {
              toCode: ({ schemas }: SchemaRepresentation.Generation.CheckInput) => ({
                runtime: `Schema.makeFilter(Is(${schemas[0].runtime}))`,
                importDeclarations: [`import { is as Is } from "effect/Schema"`]
              })
            }
          }]
        }]
      })
      const source = document.print()
      register("check import collision", source)
      await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => {
        assertSamples(TestRoot0, { accepts: ["a"], rejects: [1] })
      })
    })

    it("resolves callback-local imports while preserving declaration names and literal text", async () => {
      const document = makeModule({
        references: { Library: { _tag: "String", checks: [] } },
        representations: [{
          _tag: "Declaration",
          typeParameters: [],
          checks: [],
          annotations: {
            toCode: () => ({
              runtime: "Schema.Option(Schema.String).annotate({ description: \"Library.Option\" })",
              Type: "Library.Option<string>",
              importDeclarations: [
                "import type * as Library from \"effect/Option\"",
                "import * as Library from \"effect/Option\""
              ]
            })
          }
        }, {
          _tag: "Declaration",
          typeParameters: [],
          checks: [],
          annotations: {
            toCode: () => ({
              runtime: "Library(Schema.Number)",
              Type: "number",
              importDeclarations: ["import { identity as Library } from \"effect/Function\""]
            })
          }
        }]
      })
      assert.strictEqual(referenceNames(document)[0], "Library")
      const source = document.print()
      register("callback-local imports", source, ["import(\"effect/Option\").Option<string>", "number"])
      await withGeneratedModule<Generated>(source, ({ TestRoot0, TestRoot1 }) => {
        assertSamples(TestRoot0, { accepts: [Option.some("a")], rejects: [Option.some(1)] })
        assertSamples(TestRoot1, { accepts: [1], rejects: ["a"] })
        assert.strictEqual(Schema.resolveAnnotations(TestRoot0)?.description, "Library.Option")
      })
    })

    it("keeps generated names from shadowing emitted globals", async () => {
      const names = ["NaN", "Infinity", "Array", "ReadonlyArray", "globalThis"]
      const schemas = names.map((identifier) => Schema.String.annotate({ identifier }))
      const document = generate(
        Schema.Array(Schema.Number).annotate({ examples: [[NaN, Infinity]] }),
        ...schemas
      )
      const source = document.print()
      register("global name collisions", source, ["globalThis.ReadonlyArray<number>"])
      await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => {
        assertSamples(TestRoot0, { accepts: [[1, 2]], rejects: [["a"]] })
        assert.deepStrictEqual(Schema.resolveAnnotations(TestRoot0)?.examples, [[NaN, Infinity]])
      })
    })

    it("allows an import named Array", async () => {
      const input = SchemaRepresentation.toRepresentations([
        Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number]).ast
      ])
      const document = makeModule({
        ...input,
        representations: [{
          _tag: "Declaration",
          typeParameters: [],
          checks: [],
          annotations: {
            toCode: () => ({
              runtime: "Array(Schema.String)",
              Type: "string",
              importDeclarations: [
                "import { identity as Array } from \"effect/Function\""
              ]
            })
          }
        }, ...input.representations]
      })
      const source = document.print()
      register("imports named after globals", source, [
        "string",
        "readonly [string, ...globalThis.Array<number>]"
      ])
      await withGeneratedModule<Generated>(source, ({ TestRoot0, TestRoot1 }) => {
        assertSamples(TestRoot0, { accepts: ["a"], rejects: [1] })
        assertSamples(TestRoot1, { accepts: [["a"], ["a", 1, 2]], rejects: [[1], ["a", "b"]] })
      })
    })

    it("deduplicates imports across definitions and roots", async () => {
      const Named = Schema.Option(Schema.String).annotate({ identifier: "Named" })
      const document = generate(Named, Schema.Array(Named), Schema.Option(Schema.Number))
      const imports = document.finalize().imports
      assert.sameMembers([...imports], [
        "import * as Schema from \"effect/Schema\"",
        "import * as Option from \"effect/Option\""
      ])
      const source = document.print()
      register("shared imports", source, [
        "Option.Option<string>",
        "ReadonlyArray<Option.Option<string>>",
        "Option.Option<number>"
      ])
      await withGeneratedModule<Generated>(source, (module) => {
        assertSamples(module.TestRoot0, { accepts: [Option.some("a")], rejects: [Option.some(1)] })
        assertSamples(module.TestRoot1, { accepts: [[Option.none()]], rejects: [[Option.some(1)]] })
        assertSamples(module.TestRoot2, { accepts: [Option.some(1)], rejects: [Option.some("a")] })
      })
    })
  })

  describe("definition initialization", () => {
    type Node = { readonly a?: Node }
    const Anonymous = Schema.Struct({ a: Schema.optionalKey(Schema.suspend((): Schema.Codec<Node> => Anonymous)) })
    const Outer = Schema.Struct({ a: Schema.optionalKey(Schema.suspend((): Schema.Codec<Node> => Outer)) })
      .annotate({ identifier: "A" })
    const Inner = Schema.Struct({
      a: Schema.optionalKey(Schema.suspend((): Schema.Codec<Node> => Inner.annotate({ identifier: "A" })))
    })
    const NamedSuspend = Schema.Struct({
      a: Schema.optionalKey(Schema.suspend((): Schema.Codec<Node> => NamedSuspend).annotate({ identifier: "A" }))
    })
    const Proto = Schema.Struct({ a: Schema.optionalKey(Schema.suspend((): Schema.Codec<Node> => Proto)) })
      .annotate({ identifier: "__proto__" })

    for (
      const [name, schema] of [
        ["anonymous", Anonymous],
        ["outer identifier", Outer],
        ["inner identifier", Inner],
        ["suspend identifier", NamedSuspend],
        ["__proto__ recursive identifier", Proto]
      ] as const
    ) {
      it("self recursion with " + name, async () => {
        const document = generate(schema)
        const source = document.print()
        assert.lengthOf(source.match(/Schema\.suspend\(/g) ?? [], 1, "Only the original suspension is emitted")
        register(name, source + "\ntype Expected = { readonly a?: Expected }", ["Expected"])
        await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => {
          assertSamples(TestRoot0, { accepts: [{}, { a: { a: {} } }], rejects: [{ a: { a: 1 } }] })
        })
      })
    }

    it("initializes mixed dependencies and disconnected recursive components in either record order", async () => {
      const Meta = Schema.Struct({ n: Schema.Number }).annotate({ identifier: "Meta" })
      type Tree = { readonly meta: { readonly n: number }; readonly children: ReadonlyArray<Tree> }
      const Tree = Schema.Struct({
        meta: Meta,
        children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree))
      }).annotate({ identifier: "Tree" })
      const Forest = Schema.Struct({ trees: Schema.Array(Tree) }).annotate({ identifier: "Forest" })
      const input = SchemaRepresentation.toRepresentations([Forest.ast, Tree.ast, Outer.ast, Proto.ast, Forest.ast])
      for (const references of [input.references, Object.fromEntries(Object.entries(input.references).reverse())]) {
        const document = makeModule({ ...input, references })
        const names = referenceNames(document)
        assert.sameMembers([...names], ["Meta", "Tree", "Forest", "A", "__proto__"])
        assert.isBelow(names.indexOf("Meta"), names.indexOf("Tree"))
        assert.isBelow(names.indexOf("Tree"), names.indexOf("Forest"))
        const source = document.print()
        assert.lengthOf(source.match(/Schema\.suspend\(/g) ?? [], 3, "Only the original suspensions are emitted")
        register(
          "mixed dependencies " + (references === input.references),
          source +
            "\ntype ExpectedTree = { readonly meta: { readonly n: number }; readonly children: ReadonlyArray<ExpectedTree> }",
          [
            "{ readonly trees: ReadonlyArray<ExpectedTree> }",
            "ExpectedTree"
          ]
        )
        await withGeneratedModule<Generated>(source, (module) => {
          const tree = { meta: { n: 1 }, children: [{ meta: { n: 2 }, children: [] }] }
          assertSamples(module.TestRoot0, {
            accepts: [{ trees: [tree] }],
            rejects: [{ trees: [{ ...tree, children: [{ meta: { n: "bad" }, children: [] }] }] }]
          })
          assertSamples(module.TestRoot1, { accepts: [tree], rejects: [{ meta: { n: "bad" }, children: [] }] })
          for (const root of [module.TestRoot2, module.TestRoot3]) {
            assertSamples(root, { accepts: [{ a: {} }], rejects: [{ a: 1 }] })
          }
          assert.strictEqual(module.TestRoot0, module.TestRoot4, "Repeated roots reuse the definition")
          assert.strictEqual(module.TestRoot1, module.Tree)
        })
      }
    })

    it("emits every member of a productive mutual cycle", async () => {
      type A = { readonly b?: B }
      type B = { readonly a: A }
      const A = Schema.Struct({ b: Schema.optionalKey(Schema.suspend((): Schema.Codec<B> => B)) })
        .annotate({ identifier: "A" })
      const B = Schema.Struct({ a: A }).annotate({ identifier: "B" })
      for (const schemas of [[A, B], [B, A]] as const) {
        const document = generate(schemas[0], ...schemas.slice(1))
        assert.deepStrictEqual(referenceNames(document), ["A", "B"])
        const source = document.print()
        assert.lengthOf(source.match(/Schema\.suspend\(/g) ?? [], 1, "Only the original suspension is emitted")
        register("mutual cycle " + (schemas[0] === A), source)
        await withGeneratedModule<Generated>(source, (module) => {
          assertSamples(module.A, {
            accepts: [{}, { b: { a: { b: { a: {} } } } }],
            rejects: [{ b: {} }, { b: { a: 1 } }]
          })
          assertSamples(module.B, { accepts: [{ a: {} }], rejects: [{}, { a: { b: {} } }] })
        })
      }
    })

    it("orders numeric identifiers regardless of reference enumeration", async () => {
      type Nested = ReadonlyArray<Nested>
      const Nested = Schema.Array(Schema.suspend((): Schema.Codec<Nested> => Nested).annotate({ identifier: "1" }))
        .annotate({ identifier: "0" })
      const input = SchemaRepresentation.toRepresentations([Nested.ast, Outer.ast, Proto.ast])
      for (const reverse of [false, true]) {
        const document = makeModule({
          ...input,
          references: Object.fromEntries(
            reverse ? Object.entries(input.references).reverse() : Object.entries(input.references)
          )
        })
        assert.sameMembers([...referenceNames(document)], ["_0", "_1", "A", "__proto__"])
        const source = document.print()
        register("numeric references " + reverse, source + "\ntype Nested = ReadonlyArray<Nested>", ["Nested"])
        await withGeneratedModule<Generated>(source, (module) => {
          assertSamples(module.TestRoot0, { accepts: [[], [[], [[]]]], rejects: [[1], [[], ["bad"]]] })
          for (const root of [module.TestRoot1, module.TestRoot2]) {
            assertSamples(root, { accepts: [{ a: {} }], rejects: [{ a: 1 }] })
          }
        })
      }
    })

    it("orders a diamond dependency once regardless of input order", async () => {
      const Leaf = Schema.String.annotate({ identifier: "Leaf" })
      const Left = Schema.Struct({ value: Leaf }).annotate({ identifier: "Left" })
      const Right = Schema.Array(Leaf).annotate({ identifier: "Right" })
      const Root = Schema.Struct({ left: Left, right: Right }).annotate({ identifier: "Root" })
      const input = SchemaRepresentation.toRepresentations([Root.ast, Leaf.ast])
      const document = makeModule({
        ...input,
        references: Object.fromEntries(Object.entries(input.references).reverse())
      })
      assert.lengthOf(referenceNames(document), 4)
      const order = referenceNames(document)
      for (
        const [dependency, dependent] of [["Leaf", "Left"], ["Leaf", "Right"], ["Left", "Root"], ["Right", "Root"]]
      ) {
        assert.isBelow(order.indexOf(dependency), order.indexOf(dependent))
      }
      const source = document.print()
      register("diamond dependencies", source, [
        "{ readonly left: { readonly value: string }; readonly right: ReadonlyArray<string> }",
        "string"
      ])
      await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => {
        assertSamples(TestRoot0, {
          accepts: [{ left: { value: "a" }, right: ["b"] }],
          rejects: [{ left: { value: "a" }, right: [1] }]
        })
      })
    })

    const Child = Schema.String.annotate({ identifier: "Child" })
    for (
      const [name, schema, accepts, rejects] of [
        ["tuple element", Schema.Tuple([Child]), [["a"]], [[1]]],
        ["array rest", Schema.Array(Child), [["a"]], [[1]]],
        ["tuple rest", Schema.TupleWithRest(Schema.Tuple([Schema.Number]), [Child]), [[1, "a"]], [[1, 2]]],
        ["tuple post-rest", Schema.TupleWithRest(Schema.Tuple([Schema.Boolean]), [Schema.Number, Child]), [[
          true,
          1,
          "a"
        ]], [[true, 1, 2]]],
        ["property", Schema.Struct({ value: Child }), [{ value: "a" }], [{ value: 1 }]],
        ["index value", Schema.Record(Schema.String, Child), [{ a: "a" }], [{ a: 1 }]],
        ["index parameter", Schema.Record(Child, Schema.Number), [{ a: 1 }], [{ a: "a" }]],
        ["union member", Schema.Union([Schema.Number, Child]), [1, "a"], [true]],
        ["template part", Schema.TemplateLiteral([Child, Schema.Literal("!")]), ["a!"], ["a"]],
        ["declaration parameter", Schema.Option(Child), [Option.some("a")], [Option.some(1)]]
      ] as const
    ) {
      it("orders an eager reference in a " + name, async () => {
        const input = SchemaRepresentation.toRepresentations([schema.annotate({ identifier: "Parent" }).ast])
        // Put the dependent first so a test cannot pass by preserving input order.
        const document = makeModule({
          ...input,
          references: { Parent: input.references.Parent, Child: input.references.Child }
        })
        assert.deepStrictEqual(referenceNames(document), ["Child", "Parent"])
        const source = document.print()
        register("dependency " + name, source)
        await withGeneratedModule<Generated>(source, ({ TestRoot0 }) => assertSamples(TestRoot0, { accepts, rejects }))
      })
    }

    for (const group of [false, true]) {
      it("orders dependencies passed to a " + (group ? "grouped" : "direct") + " check callback", async () => {
        const check: SchemaRepresentation.Filter = {
          _tag: "Filter",
          aborted: false,
          representation: { id: "test/check", payload: null, schemas: [{ _tag: "Reference", $ref: "Child" }] },
          annotations: {
            toCode: ({ schemas }: SchemaRepresentation.Generation.CheckInput) => {
              assert.lengthOf(schemas, 1)
              return { runtime: "Schema.makeFilter(Schema.is(" + schemas[0].runtime + "))" }
            }
          }
        }
        const document = makeModule({
          representations: [{ _tag: "Reference", $ref: "Parent" }],
          references: {
            Parent: { _tag: "Unknown", checks: group ? [{ _tag: "FilterGroup", checks: [check] }] : [check] },
            Child: { _tag: "String", checks: [] }
          }
        })
        assert.deepStrictEqual(referenceNames(document), ["Child", "Parent"])
        const source = document.print()
        register("check dependency " + group, source)
        await withGeneratedModule<Generated>(
          source,
          ({ TestRoot0 }) => assertSamples(TestRoot0, { accepts: ["a"], rejects: [1] })
        )
      })
    }

    it("emits unreachable definitions", async () => {
      const document = makeModule({
        representations: [{ _tag: "String", checks: [] }],
        references: { Unused: { _tag: "Number", checks: [] } }
      })
      const source = document.print()
      register("unreachable", source)
      await withGeneratedModule<Generated>(
        source,
        ({ Unused }) => assertSamples(Unused, { accepts: [1], rejects: ["a"] })
      )
    })
  })

  describe("JSON Schema inputs", () => {
    example(
      "imported optional union tuple",
      fromJson({
        type: "array",
        prefixItems: [{ anyOf: [{ type: "string" }, { type: "number" }] }],
        items: false
      }),
      "readonly [(string | number)?]",
      { accepts: [[], ["a"], [1]], rejects: [[true], [1, 2]] }
    )
    example(
      "allOf reference",
      fromJson({ allOf: [{ $ref: "#/$defs/A" }], $defs: { A: { type: "string" } } }),
      "string",
      { accepts: ["a"], rejects: [1] }
    )
    example(
      "allOf references within definitions",
      fromJson({
        $ref: "#/$defs/A",
        $defs: {
          A: {
            allOf: [{ $ref: "#/$defs/B" }, {
              type: "object",
              properties: { a: { type: "string" }, b: {} },
              required: ["a"]
            }]
          },
          B: { type: "object", properties: { b: { type: "number" }, a: {} }, required: ["b"] }
        }
      }),
      "{ readonly a: string; readonly b: number }",
      {
        accepts: [{ a: "a", b: 1 }],
        rejects: [{ a: "a" }, { b: 1 }, { a: "a", b: "b" }]
      }
    )
  })

  describe("metadata and errors", () => {
    it("preserves Void's discarded input behavior", async () => {
      await withGeneratedModule<Generated>(generate(Schema.Void).print(), ({ TestRoot0 }) => {
        for (const input of [null, 1, "a"]) assert.strictEqual(Schema.decodeUnknownSync(TestRoot0)(input), undefined)
      })
    })

    it("preserves node, check and key annotations at their original locations", async () => {
      const schemas = [
        Schema.String.annotate({ description: "node" }).check(Schema.isMinLength(1)),
        Schema.String.check(Schema.isMinLength(1, { description: "check" })),
        Schema.String.check(Schema.isMinLength(1)).annotate({ description: "check" }),
        Schema.Number.check(Schema.isFinite({ expected: "a real number" })),
        Schema.Number.check(Schema.isFinite().abort()),
        Schema.Number.check(Schema.isGreaterThan(0), Schema.isFinite()),
        Schema.String.check(Schema.isGUID({ message: "message" })),
        Schema.Tuple([Schema.String.annotateKey({ description: "element" })]),
        Schema.Struct({ a: Schema.String.annotateKey({ description: "property" }) }),
        Schema.suspend(() => Schema.String),
        Schema.ErrorInstance({ includeStack: true }),
        Schema.ErrorInstance({ excludeCause: true }),
        Schema.Redacted(Schema.String, { label: "password", disallowJsonEncode: true })
      ]
      const source = generate(schemas[0], ...schemas.slice(1)).print()
      register("annotation locations", source)
      await withGeneratedModule<Generated>(source, (module) => {
        // The live AST exposes placement and all serializable annotations; this
        // catches dropped "expected" metadata without depending on printed syntax.
        for (let i = 0; i < schemas.length; i++) {
          assert.deepStrictEqual(
            SchemaRepresentation.toJson(Schema.toRepresentation(module["TestRoot" + i])),
            SchemaRepresentation.toJson(Schema.toRepresentation(schemas[i]))
          )
        }
      })
    })

    for (
      const [name, schema, path] of [
        ["declaration", Schema.instanceOf(URL), "[\"representations\"][0][\"annotations\"][\"toCode\"]"],
        [
          "named content declaration",
          Schema.fromJsonString(Schema.instanceOf(URL).annotate({ identifier: "Content" })),
          "[\"references\"][\"Content\"][\"annotations\"][\"toCode\"]"
        ]
      ] as const
    ) {
      it("reports missing callback for " + name, () => {
        assert.throws(() => generate(schema), "Missing toCode callback\n  at " + path)
      })
    }
  })

  // Compile just the modules exercised by this run, once, including filtered runs.
  afterAll(async () => {
    if (compilation.size > 0) await checkGeneratedModules(compilation)
  }, 60_000)
})
