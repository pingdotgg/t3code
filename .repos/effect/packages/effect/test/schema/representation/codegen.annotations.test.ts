import { assert, describe, it } from "@effect/vitest"
import { Schema, SchemaRepresentation } from "effect"
import { runInNewContext } from "node:vm"
import { assertInclude, throws } from "../../utils/assert.ts"
import { withGeneratedModule } from "../../utils/generatedModule.ts"
import { assertSchemas, declaration, declarationNames, makeModule } from "../../utils/schemaCodegen.ts"

function expectError(thunk: () => void, expected: string | Error): void {
  if (typeof expected === "string") {
    throws(thunk, expected)
  } else {
    throws(thunk, (error: unknown) => {
      assert.strictEqual(error, expected)
      return undefined
    })
  }
}

const StringRepresentation: SchemaRepresentation.Representation = {
  _tag: "String",
  checks: []
}

const NumberRepresentation: SchemaRepresentation.Representation = {
  _tag: "Number",
  checks: []
}

const EmptyUnionRepresentation: SchemaRepresentation.Representation = {
  _tag: "Union",
  types: [],
  options: { mode: "anyOf" },
  checks: []
}

describe("Codegen.Module.addSchemas annotations", () => {
  it("prefers live overrides on built-ins, including an explicitly removed callback", () => {
    const schema = Schema.Option(Schema.String.check(Schema.isMinLength(2, {
      toCode: () => ({ runtime: "Custom.check()" })
    }))).annotate({
      toCode: ({ typeParameters: [value] }: SchemaRepresentation.Generation.DeclarationInput) => ({
        runtime: `Custom.box(${value.runtime})`,
        Type: value.Type
      })
    })
    const source = makeModule(SchemaRepresentation.toRepresentations([schema.ast])).print()
    assert.include(source, "Custom.box(Schema.String.check(Custom.check()")
    for (
      const disabled of [
        Schema.Date.annotate({ toCode: undefined }),
        Schema.String.check(Schema.isMinLength(2, { toCode: undefined })),
        Schema.String.check(Schema.isMinLength(2, { representation: { id: "acme/min", payload: 2 } }))
      ]
    ) {
      assert.throws(() => makeModule(SchemaRepresentation.toRepresentations([disabled.ast])), "Missing toCode callback")
    }
  })

  it("prints the date bound recorded when the check was created", () => {
    const date = new Date(0)
    const schema = Schema.Date.check(Schema.isGreaterThanDate(date))
    date.setTime(42)
    const source = makeModule(SchemaRepresentation.toRepresentations([schema.ast])).print()
    assert.include(source, "Schema.isGreaterThanDate(new globalThis.Date(0))")
  })

  it("validates built-in payloads and schema arguments at their document paths", () => {
    for (
      const [id, payload] of [
        ["effect/schema/isMinLength", { minLength: "2" }],
        ["effect/schema/isPattern", { source: "[", flags: "" }],
        ["effect/schema/isLessThanBigInt", { exclusiveMaximum: "1.5" }]
      ] as const
    ) {
      expectError(
        () =>
          makeModule({
            representations: [{
              _tag: "String",
              checks: [{ _tag: "Filter", aborted: false, representation: { id, payload } }]
            }],
            references: {}
          }),
        `Invalid representation payload for ${id}\n  at ["representations"][0]["checks"][0]["representation"]["payload"]`
      )
    }
    expectError(
      () =>
        makeModule({
          representations: [{
            _tag: "Declaration",
            typeParameters: [],
            checks: [],
            representation: { id: "effect/schema/Option", payload: null }
          }],
          references: {}
        }),
      "Invalid number of schema arguments for effect/schema/Option: expected 1, got 0\n  at [\"representations\"][0][\"typeParameters\"]"
    )
  })

  it("preserves explicit options on an empty union", () => {
    assertSchemas(
      makeModule({
        representations: [EmptyUnionRepresentation],
        references: {}
      }),
      { TestRoot0: { runtime: `Schema.Union([], { mode: "anyOf" })`, Type: "never" } },
      ["import * as Schema from \"effect/Schema\""]
    )
  })

  it("generates isPattern and Option without attaching printers to either built-in", () => {
    const pattern = Schema.isPattern(/^a+$/)
    const option = Schema.Option(Schema.String)
    assert.isUndefined(pattern.annotations?.toCode)
    assert.isUndefined(option.ast.annotations?.toCode)
    const document = SchemaRepresentation.toRepresentations([
      Schema.String.check(pattern).ast,
      option.ast
    ])
    const output = makeModule(document)

    assertSchemas(output, {
      TestRoot0: {
        runtime:
          `Schema.String.check(Schema.isPattern(new globalThis.RegExp("^a+$")).annotate({ "expected": "a string matching the RegExp ^a+$" }))`,
        Type: "string"
      },
      TestRoot1: {
        runtime: `Schema.Option(Schema.String).annotate({ "expected": "Option" })`,
        Type: "Option.Option<string>"
      }
    }, ["import * as Schema from \"effect/Schema\"", `import * as Option from "effect/Option"`])
  })

  it("passes compiled dependencies to checks and deduplicates imports", () => {
    const check = (name: string): SchemaRepresentation.Filter => ({
      _tag: "Filter",
      aborted: false,
      representation: {
        id: `acme/schema/${name}`,
        payload: null,
        schemas: [StringRepresentation]
      },
      annotations: {
        toCode: ({ schemas }: SchemaRepresentation.Generation.CheckInput) => ({
          runtime: `Custom.${name}(${schemas[0].runtime})`,
          importDeclarations: [`import * as Custom from "acme/Custom"`]
        })
      }
    })
    const document: SchemaRepresentation.MultiDocument = {
      representations: [{ _tag: "String", checks: [check("first"), check("second")] }],
      references: {}
    }

    const output = makeModule(document)
    assert.strictEqual(
      declaration(output, "TestRoot0")[1],
      "export const TestRoot0 = Schema.String.check(Custom.first(Schema.String)).check(Custom.second(Schema.String))"
    )
    assert.sameMembers([...output.finalize().imports], [
      "import * as Schema from \"effect/Schema\"",
      `import * as Custom from "acme/Custom"`
    ])
  })

  it("emits supported annotation trees atomically", () => {
    const document = SchemaRepresentation.toRepresentations([
      Schema.String.annotate({
        emitted: {
          bigint: 1n,
          symbol: Symbol.for("shared"),
          nan: NaN,
          positive: Infinity,
          negative: -Infinity,
          nullPrototype: Object.create(null),
          crossRealm: runInNewContext("({ value: 1 })") as unknown
        },
        omitted: { value: 1, callback: () => 2 }
      }).ast
    ])

    const runtime = makeModule(document).print()
    assertInclude(runtime, `"bigint": 1n`)
    assertInclude(runtime, `"symbol": globalThis.Symbol.for("shared")`)
    assertInclude(runtime, `"nan": globalThis.NaN`)
    assertInclude(runtime, `"positive": globalThis.Infinity`)
    assertInclude(runtime, `"negative": -globalThis.Infinity`)
    assertInclude(runtime, `"nullPrototype": {}`)
    assertInclude(runtime, `"crossRealm": { "value": 1 }`)
    assert.isFalse(runtime.includes("omitted"))
    assert.isFalse(runtime.includes("callback"))
  })

  it("omits unsupported object annotations atomically", () => {
    const schema = Schema.String.annotate({
      kept: { value: 1 },
      map: new Map([["a", 1]]),
      set: new Set([1]),
      date: new Date(0),
      bytes: new Uint8Array([1, 2]),
      instance: new (class {
        value = 1
      })(),
      nested: { value: 1, map: new Map([["a", 1]]) },
      array: [1, new Set([1])]
    })
    const document = SchemaRepresentation.toRepresentations([schema.ast])

    assert.strictEqual(
      declaration(makeModule(document), "TestRoot0")[1],
      "export const TestRoot0 = Schema.String.annotate({ \"kept\": { \"value\": 1 } })"
    )
  })

  it("preserves top-level and nested __proto__ annotations in generated code", async () => {
    const value = { ["__proto__"]: { trusted: true } }
    const annotations = { ...value, examples: [value] }
    const schema = Schema.Unknown.annotate(annotations)
    const document = makeModule(SchemaRepresentation.toRepresentations([schema.ast]))
    await withGeneratedModule<{ TestRoot0: typeof schema }>(document.print(), ({ TestRoot0 }) => {
      assert.deepStrictEqual(Schema.resolveAnnotations(TestRoot0), annotations)
    })
  })

  it("preserves fallback identifiers", () => {
    const output = makeModule({
      representations: [{
        _tag: "String",
        checks: [],
        annotations: { "~identifier": "Person" }
      }],
      references: {}
    })

    assertInclude(output.print(), `.annotate({ "~identifier": "Person" })`)
  })

  it("emits tuple element and property annotations", () => {
    const document: SchemaRepresentation.MultiDocument = {
      representations: [
        {
          _tag: "Arrays",
          elements: [{
            isOptional: false,
            type: StringRepresentation,
            annotations: {
              element: { value: 1 },
              omitted: { callback: () => 1 },
              map: new Map([["a", 1]])
            }
          }],
          rest: [],
          checks: []
        },
        {
          _tag: "Objects",
          propertySignatures: [{
            name: "value",
            type: NumberRepresentation,
            isOptional: false,
            isMutable: false,
            annotations: { property: true, nested: { set: new Set([1]) } }
          }],
          indexSignatures: [],
          checks: []
        }
      ],
      references: {}
    }

    assertSchemas(makeModule(document), {
      TestRoot0: {
        runtime: `Schema.Tuple([Schema.String.annotateKey({ "element": { "value": 1 } })])`,
        Type: "readonly [string]"
      },
      TestRoot1: {
        runtime: `Schema.Struct({ "value": Schema.Number.annotateKey({ "property": true }) })`,
        Type: `{ readonly "value": number }`
      }
    }, ["import * as Schema from \"effect/Schema\""])
  })

  it("uses group overrides without visiting children and preserves abort", () => {
    let visits = 0
    const child: SchemaRepresentation.Filter = {
      _tag: "Filter",
      aborted: true,
      annotations: {
        toCode: () => {
          visits++
          return { runtime: "Custom.child()" }
        }
      }
    }
    const document: SchemaRepresentation.MultiDocument = {
      representations: [
        {
          _tag: "String",
          checks: [{
            _tag: "FilterGroup",
            checks: [child],
            annotations: { toCode: () => ({ runtime: "Custom.group()" }) }
          }]
        },
        {
          _tag: "String",
          checks: [{ _tag: "FilterGroup", checks: [child] }]
        }
      ],
      references: {}
    }

    const output = makeModule(document)
    assert.strictEqual(visits, 1)
    assert.strictEqual(
      declaration(output, "TestRoot0")[1],
      "export const TestRoot0 = Schema.String.check(Custom.group())"
    )
    assert.strictEqual(
      declaration(output, "TestRoot1")[1],
      "export const TestRoot1 = Schema.String.check(Schema.makeFilterGroup([Custom.child().abort()]))"
    )
  })

  it("passes type parameters to declaration callbacks", () => {
    const declaration: SchemaRepresentation.Representation = {
      _tag: "Declaration",
      typeParameters: [StringRepresentation],
      checks: [],
      representation: {
        id: "acme/schema/Box",
        payload: null
      },
      annotations: {
        toCode: ({ typeParameters }: SchemaRepresentation.Generation.DeclarationInput) => ({
          runtime: `Custom.box(${typeParameters[0].runtime})`,
          Type: `Custom.Box<${typeParameters[0].Type}>`,
          importDeclarations: [`import * as Custom from "acme/Custom"`]
        })
      }
    }
    const output = makeModule({
      representations: [declaration],
      references: {}
    })

    assertSchemas(output, {
      TestRoot0: {
        runtime: "Custom.box(Schema.String)",
        Type: "Custom.Box<string>"
      }
    }, ["import * as Schema from \"effect/Schema\"", "import * as Custom from \"acme/Custom\""])
  })

  it("reports missing toCode callbacks and preserves callback exceptions", () => {
    const missing: SchemaRepresentation.MultiDocument = {
      representations: [{
        _tag: "String",
        checks: [{ _tag: "Filter", aborted: false }]
      }],
      references: {}
    }
    expectError(
      () => makeModule(missing),
      `Missing toCode callback\n  at ["representations"][0]["checks"][0]["annotations"]["toCode"]`
    )

    const cause = new Error("toCode callback")
    const throwing: SchemaRepresentation.MultiDocument = {
      representations: [{
        _tag: "String",
        checks: [{
          _tag: "Filter",
          aborted: false,
          annotations: {
            toCode: () => {
              throw cause
            }
          }
        }]
      }],
      references: {}
    }
    expectError(
      () => makeModule(throwing),
      cause
    )
  })

  it("rejects imports that reuse a callback argument without retrying", () => {
    let calls = 0
    expectError(
      () =>
        makeModule({
          references: { A: StringRepresentation },
          representations: [{
            _tag: "Declaration",
            typeParameters: [{ _tag: "Reference", $ref: "A" }],
            checks: [],
            annotations: {
              toCode: ({ typeParameters }: SchemaRepresentation.Generation.DeclarationInput) => {
                calls++
                return {
                  ...typeParameters[0],
                  importDeclarations: [`import * as ${typeParameters[0].Type} from "acme/Custom"`]
                }
              }
            }
          }]
        }),
      `Import shadows a callback argument\n  at ["representations"][0]["annotations"]["toCode"]["importDeclarations"][0]`
    )
    assert.strictEqual(calls, 1)
  })

  it("reports unsupported callback syntax with its document path", () => {
    assert.throws(
      () =>
        makeModule({
          references: {},
          representations: [{
            _tag: "String",
            checks: [{
              _tag: "Filter",
              aborted: false,
              annotations: { toCode: () => ({ runtime: "Schema.makeFilter((value) => value)" }) }
            }]
          }]
        }),
      /Unsupported runtime syntax.*\n  at \["representations"\]\[0\]\["checks"\]\[0\]\["annotations"\]\["toCode"\]\["runtime"\]/
    )
  })

  it("generates content media types, optional pre-rest elements and numeric properties", () => {
    const output = makeModule({
      representations: [
        {
          _tag: "String",
          annotations: { contentMediaType: "text/plain" },
          checks: []
        },
        {
          _tag: "Arrays",
          elements: [{
            type: StringRepresentation,
            isOptional: true
          }],
          rest: [NumberRepresentation],
          checks: []
        },
        {
          _tag: "Objects",
          propertySignatures: [{
            name: 1,
            type: { _tag: "Boolean", checks: [] },
            isOptional: false,
            isMutable: false
          }],
          indexSignatures: [],
          checks: []
        }
      ],
      references: {}
    })

    assertSchemas(output, {
      TestRoot0: {
        runtime: `Schema.String.annotate({ "contentMediaType": "text/plain" })`,
        Type: "string"
      },
      TestRoot1: {
        runtime: `Schema.TupleWithRest(Schema.Tuple([Schema.optionalKey(Schema.String)]), [Schema.Number])`,
        Type: `readonly [(string)?, ...globalThis.Array<number>]`
      },
      TestRoot2: {
        runtime: `Schema.Struct({ 1: Schema.Boolean })`,
        Type: `{ readonly 1: boolean }`
      }
    }, ["import * as Schema from \"effect/Schema\""])
  })

  it("emits references that are not reachable from a root", () => {
    const document: SchemaRepresentation.MultiDocument = {
      representations: [StringRepresentation],
      references: {
        Unused: NumberRepresentation
      }
    }
    assertSchemas(makeModule(document), {
      Unused: { runtime: "Schema.Number", Type: "number" },
      TestRoot0: { runtime: "Schema.String", Type: "string" }
    })
  })

  it("sanitizes reference identifiers", () => {
    const sanitize = (identifier: string) =>
      declarationNames(makeModule({
        representations: [StringRepresentation],
        references: { [identifier]: NumberRepresentation }
      }))[0]
    assert.deepStrictEqual(
      ["abc", "Abc", "1a", "a-b", "café", "🤖", ""].map(sanitize),
      ["Abc", "Abc", "_1a", "A_b", "Caf_", "_", "_"]
    )
  })

  it("preserves a lowercase identifier annotation", () => {
    const schema = Schema.Struct({ a: Schema.String }).annotate({ identifier: "hello" })
    const output = makeModule(
      SchemaRepresentation.toMultiDocument(Schema.toRepresentation(schema))
    )
    assertSchemas(output, {
      Hello: {
        runtime: `Schema.Struct({ "a": Schema.String }).annotate({ "identifier": "hello" })`,
        Type: `{ readonly "a": string }`
      },
      TestRoot0: { runtime: "Hello", Type: "Hello" }
    })
  })

  it("makes colliding sanitized reference identifiers unique", () => {
    const output = makeModule({
      representations: [StringRepresentation],
      references: {
        "a-b": NumberRepresentation,
        a_b: StringRepresentation
      }
    })
    assert.deepStrictEqual(
      declarationNames(output),
      ["A_b", "A_b1", "TestRoot0"]
    )
  })

  it("orders definitions after dependencies found in every representation position", () => {
    const reference = ($ref: string): SchemaRepresentation.Reference => ({ _tag: "Reference", $ref })
    const filter: SchemaRepresentation.Filter = {
      _tag: "Filter",
      aborted: false,
      representation: { id: "acme/schema/filter", payload: null, schemas: [reference("C")] },
      annotations: {
        toCode: () => ({ runtime: "Schema.makeFilter(() => true)" })
      }
    }
    const output = makeModule({
      representations: [StringRepresentation],
      references: {
        A: StringRepresentation,
        B: NumberRepresentation,
        C: { _tag: "Boolean", checks: [] },
        D: {
          _tag: "Declaration",
          typeParameters: [reference("A")],
          representation: { id: "acme/schema/declaration", payload: null },
          annotations: {
            toCode: () => ({ runtime: "Schema.String", Type: "string" })
          },
          checks: [{ _tag: "FilterGroup", checks: [filter] }]
        },
        E: { _tag: "TemplateLiteral", parts: [reference("D")], checks: [] },
        F: { _tag: "Union", types: [reference("E"), reference("A")], options: { mode: "anyOf" }, checks: [] },
        G: {
          _tag: "Arrays",
          elements: [{ type: reference("F"), isOptional: false }],
          rest: [reference("A")],
          checks: []
        },
        H: {
          _tag: "Objects",
          propertySignatures: [{
            name: "value",
            type: reference("G"),
            isOptional: false,
            isMutable: false
          }],
          indexSignatures: [{ parameter: reference("A"), type: reference("B") }],
          checks: []
        },
        I: { _tag: "Suspend", thunk: reference("H"), checks: [] }
      }
    })

    assert.deepStrictEqual(
      declarationNames(output),
      ["A", "B", "C", "D", "E", "F", "G", "H", "I", "TestRoot0"]
    )
  })

  it("orders a shared dependency referenced from multiple representation positions once", () => {
    const shared: SchemaRepresentation.Reference = { _tag: "Reference", $ref: "A" }
    const output = makeModule({
      representations: [StringRepresentation],
      references: {
        A: StringRepresentation,
        B: {
          _tag: "Arrays",
          elements: [{ type: shared, isOptional: false }],
          rest: [shared],
          checks: []
        },
        C: {
          _tag: "Objects",
          propertySignatures: [],
          indexSignatures: [{ parameter: shared, type: shared }],
          checks: []
        }
      }
    })

    assert.deepStrictEqual(
      declarationNames(output),
      ["A", "B", "C", "TestRoot0"]
    )
  })

  it("generates a StructWithRest without fixed properties", () => {
    const output = makeModule({
      representations: [{
        _tag: "Objects",
        propertySignatures: [],
        indexSignatures: [
          { parameter: StringRepresentation, type: NumberRepresentation },
          { parameter: { _tag: "Symbol", checks: [] }, type: { _tag: "Boolean", checks: [] } }
        ],
        checks: []
      }],
      references: {}
    })

    assert.strictEqual(
      declaration(output, "TestRoot0")[0],
      "export type TestRoot0 = { readonly [x: string]: number, readonly [x: symbol]: boolean }"
    )
  })

  it("preserves explicit options on a single-literal Union", () => {
    const output = makeModule({
      representations: [{
        _tag: "Union",
        types: [{ _tag: "Literal", literal: "a", checks: [] }],
        options: { mode: "anyOf" },
        checks: []
      }],
      references: {}
    })

    assertSchemas(output, {
      TestRoot0: {
        runtime: `Schema.Union([Schema.Literal("a")], { mode: "anyOf" })`,
        Type: `"a"`
      }
    })
  })

  it("preserves optional Union option properties", () => {
    const output = makeModule({
      representations: [
        {
          _tag: "Union",
          types: [StringRepresentation],
          options: {},
          checks: []
        },
        {
          _tag: "Union",
          types: [NumberRepresentation],
          options: { mode: undefined },
          checks: []
        }
      ],
      references: {}
    })

    assertSchemas(output, {
      TestRoot0: { runtime: "Schema.Union([Schema.String], {})", Type: "string" },
      TestRoot1: { runtime: `Schema.Union([Schema.Number], { mode: undefined })`, Type: "number" }
    }, ["import * as Schema from \"effect/Schema\""])
  })

  it("reports missing references with their document path", () => {
    const document: SchemaRepresentation.MultiDocument = {
      representations: [{ _tag: "Reference", $ref: "Missing" }],
      references: {}
    }
    expectError(
      () => makeModule(document),
      `Invalid reference Missing\n  at ["representations"][0]["$ref"]`
    )
  })

  it("reports a missing reference from a definition", () => {
    expectError(
      () =>
        makeModule({
          representations: [StringRepresentation],
          references: { Value: { _tag: "Reference", $ref: "Missing" } }
        }),
      `Invalid reference Missing\n  at ["references"]["Value"]["$ref"]`
    )
  })
})
