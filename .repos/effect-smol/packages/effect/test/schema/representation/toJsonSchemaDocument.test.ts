import { assert, describe, it } from "@effect/vitest"
import { Schema, SchemaAST, SchemaRepresentation } from "effect"
import { throws } from "../../utils/assert.ts"

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
  mode: "anyOf",
  checks: []
}

describe("SchemaRepresentation.toJsonSchemaDocument annotations", () => {
  function compile(representation: SchemaRepresentation.Representation) {
    return SchemaRepresentation.toJsonSchemaDocument({ representation, references: {} }).schema
  }

  it("compiles Any", () => {
    assert.deepStrictEqual(compile({ _tag: "Any", checks: [] }), {})
  })

  it("compiles Unknown", () => {
    assert.deepStrictEqual(compile({ _tag: "Unknown", checks: [] }), {})
  })

  it("compiles ObjectKeyword", () => {
    assert.deepStrictEqual(compile({ _tag: "ObjectKeyword", checks: [] }), {
      anyOf: [{ type: "object" }, { type: "array" }]
    })
  })

  it("compiles Void", () => {
    assert.deepStrictEqual(compile({ _tag: "Void", checks: [] }), { type: "null" })
  })

  it("compiles Undefined", () => {
    assert.deepStrictEqual(compile({ _tag: "Undefined", checks: [] }), { type: "null" })
  })

  it("compiles BigInt", () => {
    assert.deepStrictEqual(compile({ _tag: "BigInt", checks: [] }), {
      type: "string",
      allOf: [{ pattern: "^-?\\d+$" }]
    })
  })

  it("compiles Symbol", () => {
    assert.deepStrictEqual(compile({ _tag: "Symbol", checks: [] }), {
      type: "string",
      allOf: [{ pattern: "^Symbol\\((.*)\\)$" }]
    })
  })

  it("compiles UniqueSymbol", () => {
    assert.deepStrictEqual(compile({ _tag: "UniqueSymbol", symbol: Symbol.for("value"), checks: [] }), {
      type: "string",
      allOf: [{ pattern: "^Symbol\\((.*)\\)$" }]
    })
  })

  it("compiles Null", () => {
    assert.deepStrictEqual(compile({ _tag: "Null", checks: [] }), { type: "null" })
  })

  it("compiles Never", () => {
    assert.deepStrictEqual(compile({ _tag: "Never", checks: [] }), { not: {} })
  })

  it("compiles Suspend", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Suspend",
        thunk: StringRepresentation,
        checks: []
      }),
      { type: "string" }
    )
  })

  it("compiles a bigint Literal", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Literal",
        literal: 1n,
        checks: []
      }),
      {
        type: "string",
        enum: ["1"]
      }
    )
  })

  it("compiles a string Literal", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Literal",
        literal: "a",
        checks: []
      }),
      {
        type: "string",
        enum: ["a"]
      }
    )
  })

  it("compiles an empty Enum", () => {
    assert.deepStrictEqual(compile({ _tag: "Enum", enums: [], checks: [] }), { not: {} })
  })

  it("compiles an Enum", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Enum",
        enums: [
          ["A", "a"],
          ["One", 1]
        ],
        checks: []
      }),
      {
        anyOf: [
          { type: "string", enum: ["a"], title: "A" },
          { type: "number", enum: [1], title: "One" }
        ]
      }
    )
  })

  it("preserves ambiguous Enum values", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Enum",
        enums: [
          ["StringNaN", "NaN"],
          ["NumberNaN", Number.NaN],
          ["StringInfinity", "Infinity"],
          ["NumberInfinity", Number.POSITIVE_INFINITY]
        ],
        checks: []
      }),
      {
        anyOf: [
          { type: "string", enum: ["NaN"], title: "StringNaN" },
          { type: "string", enum: ["NaN"], title: "NumberNaN" },
          { type: "string", enum: ["Infinity"], title: "StringInfinity" },
          { type: "string", enum: ["Infinity"], title: "NumberInfinity" }
        ]
      }
    )
  })

  it("compiles a TemplateLiteral", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "TemplateLiteral",
        parts: [
          { _tag: "Literal", literal: "prefix-", checks: [] },
          StringRepresentation
        ],
        checks: []
      }),
      { type: "string", pattern: "^prefix-[\\s\\S]*?$" }
    )
  })

  it("compiles optional tuple elements", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Arrays",
        elements: [
          { type: StringRepresentation, isOptional: false },
          { type: NumberRepresentation, isOptional: true }
        ],
        rest: [],
        checks: []
      }),
      {
        type: "array",
        prefixItems: [{ type: "string" }, {
          anyOf: [
            { type: "number" },
            { type: "string", enum: ["NaN"] },
            { type: "string", enum: ["Infinity"] },
            { type: "string", enum: ["-Infinity"] }
          ]
        }],
        maxItems: 2,
        minItems: 1
      }
    )
  })

  it("rejects multiple tuple rest elements", () => {
    expectError(
      () =>
        compile({
          _tag: "Arrays",
          elements: [],
          rest: [StringRepresentation, NumberRepresentation],
          checks: []
        }),
      `Invalid schema representation document\n  at ["representation"]["rest"]`
    )
  })

  it("rejects a symbol object property", () => {
    expectError(
      () =>
        compile({
          _tag: "Objects",
          propertySignatures: [{
            name: Symbol.for("value"),
            type: StringRepresentation,
            isOptional: false,
            isMutable: false
          }],
          indexSignatures: [],
          checks: []
        }),
      `Invalid schema representation document\n  at ["representation"]["propertySignatures"][0]["name"]`
    )
  })

  it("compiles a Never index-signature value as false", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Objects",
        propertySignatures: [],
        indexSignatures: [{ parameter: StringRepresentation, type: { _tag: "Never", checks: [] } }],
        checks: []
      }),
      { type: "object", additionalProperties: false }
    )
  })

  it("removes an unconstrained index-signature value", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Objects",
        propertySignatures: [],
        indexSignatures: [{ parameter: StringRepresentation, type: { _tag: "Unknown", checks: [] } }],
        checks: []
      }),
      { type: "object" }
    )
  })

  it("compacts a union of same-type literals", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Union",
        types: [
          { _tag: "Literal", literal: "a", checks: [] },
          { _tag: "Literal", literal: "b", checks: [] }
        ],
        mode: "anyOf",
        checks: []
      }),
      { type: "string", enum: ["a", "b"] }
    )
  })

  it("does not compact a union of mixed-type literals", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Union",
        types: [
          { _tag: "Literal", literal: "a", checks: [] },
          { _tag: "Literal", literal: 1, checks: [] }
        ],
        mode: "anyOf",
        checks: []
      }),
      {
        anyOf: [{ type: "string", enum: ["a"] }, { type: "number", enum: [1] }]
      }
    )
  })

  it("emits every supported standard annotation", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "String",
        annotations: {
          title: "Title",
          description: "Description",
          default: "default",
          examples: ["a", "b"],
          readOnly: true,
          writeOnly: false
        },
        checks: []
      }),
      {
        type: "string",
        title: "Title",
        description: "Description",
        default: "default",
        examples: ["a", "b"],
        readOnly: true,
        writeOnly: false
      }
    )
  })

  it("uses a check fragment when the base JSON Schema is empty", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Unknown",
        checks: [{
          _tag: "Filter",
          aborted: false,
          annotations: { toJsonSchema: () => ({ description: "checked" }) }
        }]
      }),
      { description: "checked" }
    )
  })

  it("appends a check to an existing allOf", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "BigInt",
        checks: [{
          _tag: "Filter",
          aborted: false,
          annotations: { toJsonSchema: () => ({ description: "checked" }) }
        }]
      }),
      {
        type: "string",
        allOf: [{ pattern: "^-?\\d+$" }, { description: "checked" }]
      }
    )
  })

  it("lets a check refine number to integer", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Number",
        checks: [{
          _tag: "Filter",
          aborted: false,
          annotations: { toJsonSchema: () => ({ type: "integer" }) }
        }]
      }),
      { type: "integer" }
    )
  })

  it("compiles a callback-free FilterGroup without ordinary annotations", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "String",
        checks: [{
          _tag: "FilterGroup",
          checks: [{
            _tag: "Filter",
            aborted: false,
            annotations: { toJsonSchema: () => ({ minLength: 1 }) }
          }]
        }]
      }),
      { type: "string", allOf: [{ minLength: 1 }] }
    )
  })

  it("compiles tuple element annotations", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Arrays",
        elements: [{
          type: StringRepresentation,
          isOptional: false,
          annotations: { description: "element" }
        }],
        rest: [],
        checks: []
      }),
      {
        type: "array",
        prefixItems: [{ type: "string", allOf: [{ description: "element" }] }],
        maxItems: 1,
        minItems: 1
      }
    )
  })

  it("omits minItems when every tuple element is optional", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Arrays",
        elements: [{ type: StringRepresentation, isOptional: true }],
        rest: [],
        checks: []
      }),
      {
        type: "array",
        prefixItems: [{ type: "string" }],
        maxItems: 1
      }
    )
  })

  it("compiles a constrained tuple rest", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Arrays",
        elements: [],
        rest: [StringRepresentation],
        checks: []
      }),
      { type: "array", items: { type: "string" } }
    )
  })

  it("compiles property annotations", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Objects",
        propertySignatures: [{
          name: "value",
          type: StringRepresentation,
          isOptional: true,
          isMutable: false,
          annotations: { description: "property" }
        }],
        indexSignatures: [],
        checks: []
      }),
      {
        type: "object",
        properties: { value: { type: "string", allOf: [{ description: "property" }] } },
        additionalProperties: false
      }
    )
  })

  it("compiles a single-member Union without compacting it", () => {
    assert.deepStrictEqual(
      compile({
        _tag: "Union",
        types: [StringRepresentation],
        mode: "anyOf",
        checks: []
      }),
      { anyOf: [{ type: "string" }] }
    )
  })

  it("rejects an unsupported index-signature parameter", () => {
    expectError(
      () =>
        compile({
          _tag: "Objects",
          propertySignatures: [],
          indexSignatures: [{ parameter: NumberRepresentation, type: StringRepresentation }],
          checks: []
        }),
      `Invalid schema representation document\n  at ["representation"]["indexSignatures"][0]["parameter"]`
    )
  })

  it("compiles an empty union as Never", () => {
    assert.deepStrictEqual(
      SchemaRepresentation.toJsonSchemaDocument({
        representation: EmptyUnionRepresentation,
        references: {}
      }).schema,
      { not: {} }
    )
  })

  it("removes items when an empty tuple has an open rest", () => {
    assert.deepStrictEqual(
      SchemaRepresentation.toJsonSchemaDocument({
        representation: {
          _tag: "Arrays",
          elements: [],
          rest: [{ _tag: "Unknown", checks: [] }],
          checks: []
        },
        references: {}
      }).schema,
      { type: "array" }
    )
  })

  it("passes the type produced by isInt to following check callbacks", () => {
    let receivedType: unknown
    const dependent = Schema.makeFilter<number>(() => true, {
      toJsonSchema: ({ type }) => {
        receivedType = type
        return { minimum: 0 }
      }
    })
    const document = SchemaRepresentation.toRepresentation(
      Schema.Number.check(Schema.isInt(), dependent).ast
    )

    assert.deepStrictEqual(SchemaRepresentation.toJsonSchemaDocument(document).schema, {
      type: "integer",
      allOf: [{ minimum: 0 }]
    })
    assert.strictEqual(receivedType, "integer")
  })

  it("compiles the isPattern vertical slice", () => {
    const pattern = SchemaRepresentation.toJsonSchemaDocument(
      SchemaRepresentation.toRepresentation(Schema.String.check(Schema.isPattern(/^[a-z]+$/i)).ast)
    )
    assert.deepStrictEqual(pattern, {
      dialect: "draft-2020-12",
      schema: {
        type: "string",
        allOf: [{ pattern: "^[a-z]+$" }]
      },
      definitions: {}
    })
  })

  it("treats an empty override as authoritative and ignores a leaf without a callback", () => {
    let visits = 0
    const document: SchemaRepresentation.Document = {
      representation: {
        _tag: "String",
        checks: [{
          _tag: "FilterGroup",
          annotations: { toJsonSchema: () => ({}) },
          checks: [{
            _tag: "Filter",
            aborted: false,
            annotations: {
              description: "ignored",
              toJsonSchema: () => {
                visits++
                return { minLength: 1 }
              }
            }
          }]
        }, {
          _tag: "Filter",
          aborted: false,
          annotations: { description: "no callback" }
        }]
      },
      references: {}
    }

    assert.deepStrictEqual(SchemaRepresentation.toJsonSchemaDocument(document).schema, { type: "string" })
    assert.strictEqual(visits, 0)
  })

  it("compiles representation.schemas before invoking a callback", () => {
    const document: SchemaRepresentation.Document = {
      representation: {
        _tag: "Objects",
        propertySignatures: [],
        indexSignatures: [],
        checks: [{
          _tag: "Filter",
          aborted: false,
          representation: {
            id: "acme/schema/propertyNames",
            payload: null,
            schemas: [StringRepresentation]
          },
          annotations: {
            toJsonSchema: ({ schemas }: SchemaRepresentation.ToJsonSchema.CheckInput) => ({
              propertyNames: schemas[0]
            })
          }
        }]
      },
      references: {}
    }

    assert.deepStrictEqual(SchemaRepresentation.toJsonSchemaDocument(document).schema, {
      anyOf: [{ type: "object" }, { type: "array" }],
      allOf: [{ propertyNames: { type: "string" } }]
    })
  })

  it("approximates declarations", () => {
    const document: SchemaRepresentation.Document = {
      representation: {
        _tag: "Declaration",
        typeParameters: [StringRepresentation],
        checks: [],
        representation: {
          id: "acme/schema/Box",
          payload: null
        }
      },
      references: {}
    }

    assert.deepStrictEqual(SchemaRepresentation.toJsonSchemaDocument(document).schema, {})
  })

  it("compiles every member of a union index-signature parameter", () => {
    const template = SchemaRepresentation.toRepresentation(
      Schema.TemplateLiteral(["a", Schema.String]).ast
    ).representation
    const pattern = SchemaRepresentation.toRepresentation(
      Schema.String.check(Schema.isPattern(/^b/)).ast
    ).representation
    const document: SchemaRepresentation.Document = {
      representation: {
        _tag: "Objects",
        propertySignatures: [],
        indexSignatures: [{
          parameter: {
            _tag: "Union",
            types: [template, pattern],
            mode: "anyOf",
            checks: []
          },
          type: StringRepresentation
        }],
        checks: []
      },
      references: {}
    }

    const schema = SchemaRepresentation.toJsonSchemaDocument(document).schema
    assert.deepStrictEqual(Object.keys(schema.patternProperties ?? {}), ["^a[\\s\\S]*?$", "^b"])
  })

  it("ignores boolean members while collecting index-signature patterns", () => {
    const document: SchemaRepresentation.Document = {
      representation: {
        _tag: "Objects",
        propertySignatures: [],
        indexSignatures: [{
          parameter: {
            _tag: "String",
            checks: [{
              _tag: "Filter",
              aborted: false,
              annotations: {
                toJsonSchema: () => ({ allOf: [false, { pattern: "^a" }] })
              }
            }]
          },
          type: StringRepresentation
        }],
        checks: []
      },
      references: {}
    }

    assert.deepStrictEqual(SchemaRepresentation.toJsonSchemaDocument(document).schema, {
      type: "object",
      patternProperties: { "^a": { type: "string" } }
    })
  })

  it("compiles all supported template-literal parts and rejects other nodes", () => {
    const representation: SchemaRepresentation.Representation = {
      _tag: "TemplateLiteral",
      parts: [
        { _tag: "Literal", literal: "p", checks: [] },
        NumberRepresentation,
        {
          _tag: "TemplateLiteral",
          parts: [
            { _tag: "Literal", literal: "x", checks: [] },
            StringRepresentation
          ],
          checks: []
        },
        {
          _tag: "Union",
          types: [
            { _tag: "Literal", literal: "a", checks: [] },
            { _tag: "Literal", literal: "b", checks: [] }
          ],
          mode: "anyOf",
          checks: []
        }
      ],
      checks: []
    }

    assert.deepStrictEqual(
      SchemaRepresentation.toJsonSchemaDocument({ representation, references: {} }).schema,
      {
        type: "string",
        pattern: `^p${SchemaAST.FINITE_PATTERN}x${SchemaAST.STRING_PATTERN}a|b$`
      }
    )

    expectError(
      () =>
        SchemaRepresentation.toJsonSchemaDocument({
          representation: {
            _tag: "TemplateLiteral",
            parts: [{ _tag: "Boolean", checks: [] }],
            checks: []
          },
          references: {}
        }),
      "Invalid schema representation document"
    )
  })

  it("extracts nested number types without losing other allOf members", () => {
    const output = SchemaRepresentation.toJsonSchemaDocument({
      representation: {
        _tag: "Number",
        checks: [{
          _tag: "Filter",
          aborted: false,
          annotations: {
            toJsonSchema: () => ({
              allOf: [
                {
                  description: "nested",
                  allOf: [{ type: "number" }, { minimum: 1 }]
                },
                { type: "integer", maximum: 10 },
                { title: "kept" }
              ]
            })
          }
        }]
      },
      references: {}
    })

    assert.deepStrictEqual(output.schema, {
      type: "integer",
      allOf: [
        { description: "nested", allOf: [{ minimum: 1 }] },
        { maximum: 10 },
        { title: "kept" }
      ]
    })

    assert.deepStrictEqual(
      SchemaRepresentation.toJsonSchemaDocument({
        representation: {
          _tag: "Number",
          checks: [{
            _tag: "Filter",
            aborted: false,
            annotations: {
              toJsonSchema: () => ({ allOf: [{ type: "number" }, { type: "number" }] })
            }
          }]
        },
        references: {}
      }).schema,
      { type: "number" }
    )
  })

  it("never exposes compiler capabilities as extension annotations", () => {
    const document: SchemaRepresentation.Document = {
      representation: {
        _tag: "String",
        annotations: {
          description: "text",
          identifier: "id",
          representation: { id: "acme/schema/String", payload: null },
          toCode: () => ({ runtime: "ignored" }),
          toJsonSchema: () => ({ title: "ignored" }),
          "x-custom": { enabled: true },
          "x-invalid": () => "ignored"
        },
        checks: []
      },
      references: {}
    }

    assert.deepStrictEqual(
      SchemaRepresentation.toJsonSchemaDocument(document, {
        includeAnnotationKey: () => true
      }).schema,
      {
        type: "string",
        description: "text",
        identifier: "id",
        "x-custom": { enabled: true }
      }
    )
  })

  it("captures exceptions from JSON Schema callbacks", () => {
    const cause = new Error("json schema callback")
    const document: SchemaRepresentation.Document = {
      representation: {
        _tag: "String",
        checks: [{
          _tag: "Filter",
          aborted: false,
          annotations: {
            toJsonSchema: () => {
              throw cause
            }
          }
        }]
      },
      references: {}
    }
    expectError(
      () => SchemaRepresentation.toJsonSchemaDocument(document),
      cause
    )
  })

  it("supports __proto__ as a reference", () => {
    const document = SchemaRepresentation.toJsonSchemaDocument(
      SchemaRepresentation.toRepresentation(
        Schema.String.annotate({ identifier: "__proto__" }).ast
      )
    )

    assert.deepStrictEqual(document.schema, {
      $ref: "#/$defs/__proto__"
    })
    assert.deepStrictEqual(Object.keys(document.definitions), ["__proto__"])
    assert.deepStrictEqual(document.definitions["__proto__"], {
      type: "string"
    })
  })

  it("reports missing references with their document path", () => {
    const document: SchemaRepresentation.Document = {
      representation: { _tag: "Reference", $ref: "Missing" },
      references: {}
    }
    expectError(
      () => SchemaRepresentation.toJsonSchemaDocument(document),
      `Invalid reference Missing\n  at ["representation"]["$ref"]`
    )
  })
})
