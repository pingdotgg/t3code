import { JsonSchema, SchemaRepresentation } from "effect"
import { describe, it } from "vitest"
import { deepStrictEqual, strictEqual } from "../../utils/assert.ts"

describe("fromJsonSchemaDocument", () => {
  function assertFromJsonSchema(
    input: {
      readonly schema: JsonSchema.JsonSchema
      readonly options?: {
        readonly onEnter?: ((js: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
      }
    },
    expected: {
      readonly representation: SchemaRepresentation.Representation
      readonly references?: Record<string, SchemaRepresentation.Representation>
    },
    runtime?: string
  ) {
    const expectedDocument: SchemaRepresentation.Document = {
      representation: expected.representation,
      references: expected.references ?? {}
    }
    const jsonDocument = JsonSchema.fromSchemaDraft2020_12(input.schema)
    const document = SchemaRepresentation.fromJsonSchemaDocument(jsonDocument, input.options)
    deepStrictEqual(document, expectedDocument)
    const multiDocument = SchemaRepresentation.toMultiDocument(document)
    if (runtime !== undefined) {
      strictEqual(SchemaRepresentation.toCodeDocument(multiDocument).codes[0].runtime, runtime)
    }
  }

  it("{}", () => {
    assertFromJsonSchema(
      { schema: {} },
      {
        representation: { _tag: "Unknown" }
      },
      "Schema.Unknown"
    )
    assertFromJsonSchema(
      {
        schema: {
          title: "a",
          description: "b",
          default: "c",
          examples: ["d"],
          readOnly: true,
          writeOnly: true
        }
      },
      {
        representation: {
          _tag: "Unknown",
          annotations: {
            title: "a",
            description: "b",
            default: "c",
            examples: ["d"],
            readOnly: true,
            writeOnly: true
          }
        }
      },
      `Schema.Unknown.annotate({ "title": "a", "description": "b", "default": "c", "examples": ["d"], "readOnly": true, "writeOnly": true })`
    )
  })

  describe("const", () => {
    it("const: literal (string)", () => {
      assertFromJsonSchema(
        { schema: { const: "a" } },
        {
          representation: { _tag: "Literal", literal: "a" }
        },
        `Schema.Literal("a")`
      )
      assertFromJsonSchema(
        { schema: { const: "a", description: "a" } },
        {
          representation: { _tag: "Literal", literal: "a", annotations: { description: "a" } }
        },
        `Schema.Literal("a").annotate({ "description": "a" })`
      )
    })

    it("const: literal (number)", () => {
      assertFromJsonSchema(
        { schema: { const: 1 } },
        {
          representation: { _tag: "Literal", literal: 1 }
        },
        `Schema.Literal(1)`
      )
    })

    it("const: literal (boolean)", () => {
      assertFromJsonSchema(
        { schema: { const: true } },
        {
          representation: { _tag: "Literal", literal: true }
        },
        `Schema.Literal(true)`
      )
    })

    it("const: null", () => {
      assertFromJsonSchema(
        { schema: { const: null } },
        {
          representation: { _tag: "Null" }
        },
        `Schema.Null`
      )
      assertFromJsonSchema(
        { schema: { const: null, description: "a" } },
        {
          representation: { _tag: "Null", annotations: { description: "a" } }
        },
        `Schema.Null.annotate({ "description": "a" })`
      )
    })

    it("const: non-literal", () => {
      assertFromJsonSchema(
        { schema: { const: {} } },
        {
          representation: { _tag: "Unknown" }
        },
        `Schema.Unknown`
      )
    })
  })

  describe("enum", () => {
    it("single enum (string)", () => {
      assertFromJsonSchema(
        { schema: { enum: ["a"] } },
        {
          representation: { _tag: "Literal", literal: "a" }
        },
        `Schema.Literal("a")`
      )
      assertFromJsonSchema(
        { schema: { enum: ["a"], description: "a" } },
        {
          representation: { _tag: "Literal", literal: "a", annotations: { description: "a" } }
        },
        `Schema.Literal("a").annotate({ "description": "a" })`
      )
    })

    it("single enum (number)", () => {
      assertFromJsonSchema(
        { schema: { enum: [1] } },
        {
          representation: { _tag: "Literal", literal: 1 }
        },
        `Schema.Literal(1)`
      )
    })

    it("single enum (boolean)", () => {
      assertFromJsonSchema(
        { schema: { enum: [true] } },
        {
          representation: { _tag: "Literal", literal: true }
        },
        `Schema.Literal(true)`
      )
    })

    it("multiple enum (literals)", () => {
      assertFromJsonSchema(
        { schema: { enum: ["a", 1] } },
        {
          representation: {
            _tag: "Union",
            types: [
              { _tag: "Literal", literal: "a" },
              { _tag: "Literal", literal: 1 }
            ],
            mode: "anyOf"
          }
        },
        `Schema.Literals(["a", 1])`
      )
      assertFromJsonSchema(
        { schema: { enum: ["a", 1], description: "a" } },
        {
          representation: {
            _tag: "Union",
            types: [
              { _tag: "Literal", literal: "a" },
              { _tag: "Literal", literal: 1 }
            ],
            mode: "anyOf",
            annotations: { description: "a" }
          }
        },
        `Schema.Literals(["a", 1]).annotate({ "description": "a" })`
      )
    })

    it("enum containing null", () => {
      assertFromJsonSchema(
        { schema: { enum: ["a", null] } },
        {
          representation: {
            _tag: "Union",
            types: [
              { _tag: "Literal", literal: "a" },
              { _tag: "Null" }
            ],
            mode: "anyOf"
          }
        },
        `Schema.Union([Schema.Literal("a"), Schema.Null])`
      )
    })
  })

  it("anyOf", () => {
    assertFromJsonSchema(
      { schema: { anyOf: [{ const: "a" }, { enum: [1, 2] }] } },
      {
        representation: {
          _tag: "Union",
          types: [
            { _tag: "Literal", literal: "a" },
            {
              _tag: "Union",
              types: [
                { _tag: "Literal", literal: 1 },
                { _tag: "Literal", literal: 2 }
              ],
              mode: "anyOf"
            }
          ],
          mode: "anyOf"
        }
      },
      `Schema.Union([Schema.Literal("a"), Schema.Literals([1, 2])])`
    )
  })

  it("anyOf with siblings", () => {
    assertFromJsonSchema(
      {
        schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          anyOf: [
            { properties: { a: { type: "string" } }, required: ["a"] },
            { properties: { b: { type: "number" } }, required: ["b"] }
          ]
        }
      },
      {
        representation: {
          _tag: "Union",
          types: [
            {
              _tag: "Objects",
              propertySignatures: [
                { name: "a", isOptional: false, isMutable: false, type: { _tag: "String", checks: [] } },
                { name: "id", isOptional: false, isMutable: false, type: { _tag: "String", checks: [] } }
              ],
              indexSignatures: [{ parameter: { _tag: "String", checks: [] }, type: { _tag: "Unknown" } }],
              checks: []
            },
            {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "b",
                  isOptional: false,
                  isMutable: false,
                  type: { _tag: "Number", checks: [{ _tag: "Filter", meta: { _tag: "isFinite" } }] }
                },
                { name: "id", isOptional: false, isMutable: false, type: { _tag: "String", checks: [] } }
              ],
              indexSignatures: [{ parameter: { _tag: "String", checks: [] }, type: { _tag: "Unknown" } }],
              checks: []
            }
          ],
          mode: "anyOf"
        }
      }
    )
  })

  it("oneOf", () => {
    assertFromJsonSchema(
      { schema: { oneOf: [{ const: "a" }, { enum: [1, 2] }] } },
      {
        representation: {
          _tag: "Union",
          types: [
            { _tag: "Literal", literal: "a" },
            {
              _tag: "Union",
              types: [
                { _tag: "Literal", literal: 1 },
                { _tag: "Literal", literal: 2 }
              ],
              mode: "anyOf"
            }
          ],
          mode: "oneOf"
        }
      },
      `Schema.Union([Schema.Literal("a"), Schema.Literals([1, 2])], { mode: "oneOf" })`
    )
  })

  it("oneOf with siblings", () => {
    assertFromJsonSchema(
      {
        schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          oneOf: [
            { properties: { a: { type: "string" } }, required: ["a"] },
            { properties: { b: { type: "number" } }, required: ["b"] }
          ]
        }
      },
      {
        representation: {
          _tag: "Union",
          types: [
            {
              _tag: "Objects",
              propertySignatures: [
                { name: "a", isOptional: false, isMutable: false, type: { _tag: "String", checks: [] } },
                { name: "id", isOptional: false, isMutable: false, type: { _tag: "String", checks: [] } }
              ],
              indexSignatures: [{ parameter: { _tag: "String", checks: [] }, type: { _tag: "Unknown" } }],
              checks: []
            },
            {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "b",
                  isOptional: false,
                  isMutable: false,
                  type: { _tag: "Number", checks: [{ _tag: "Filter", meta: { _tag: "isFinite" } }] }
                },
                { name: "id", isOptional: false, isMutable: false, type: { _tag: "String", checks: [] } }
              ],
              indexSignatures: [{ parameter: { _tag: "String", checks: [] }, type: { _tag: "Unknown" } }],
              checks: []
            }
          ],
          mode: "oneOf"
        }
      }
    )
  })

  describe("type: null", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "null" } },
        {
          representation: { _tag: "Null" }
        },
        `Schema.Null`
      )
    })
  })

  describe("type: string", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "string" } },
        {
          representation: { _tag: "String", checks: [] }
        },
        `Schema.String`
      )
    })

    describe("checks", () => {
      it("minLength", () => {
        assertFromJsonSchema(
          { schema: { type: "string", minLength: 1 } },
          {
            representation: {
              _tag: "String",
              checks: [{ _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } }]
            }
          },
          `Schema.String.check(Schema.isMinLength(1))`
        )
      })

      it("maxLength", () => {
        assertFromJsonSchema(
          { schema: { type: "string", maxLength: 1 } },
          {
            representation: {
              _tag: "String",
              checks: [{ _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: 1 } }]
            }
          },
          `Schema.String.check(Schema.isMaxLength(1))`
        )
      })

      it("pattern", () => {
        assertFromJsonSchema(
          { schema: { type: "string", pattern: "a*" } },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isPattern", regExp: new RegExp("a*") } }
              ]
            }
          },
          `Schema.String.check(Schema.isPattern(new RegExp("a*")))`
        )
        assertFromJsonSchema(
          { schema: { pattern: "a*" } },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isPattern", regExp: new RegExp("a*") } }
              ]
            }
          },
          `Schema.String.check(Schema.isPattern(new RegExp("a*")))`
        )
      })
    })
  })

  describe("type: number", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "number" } },
        {
          representation: {
            _tag: "Number",
            checks: [
              { _tag: "Filter", meta: { _tag: "isFinite" } }
            ]
          }
        },
        `Schema.Number.check(Schema.isFinite())`
      )
    })

    describe("checks", () => {
      it("minimum", () => {
        assertFromJsonSchema(
          { schema: { type: "number", minimum: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isFinite" } },
                { _tag: "Filter", meta: { _tag: "isGreaterThanOrEqualTo", minimum: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(1))`
        )
      })

      it("maximum", () => {
        assertFromJsonSchema(
          { schema: { type: "number", maximum: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isFinite" } },
                { _tag: "Filter", meta: { _tag: "isLessThanOrEqualTo", maximum: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isFinite()).check(Schema.isLessThanOrEqualTo(1))`
        )
      })

      it("exclusiveMinimum", () => {
        assertFromJsonSchema(
          { schema: { type: "number", exclusiveMinimum: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isFinite" } },
                { _tag: "Filter", meta: { _tag: "isGreaterThan", exclusiveMinimum: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThan(1))`
        )
      })

      it("exclusiveMaximum", () => {
        assertFromJsonSchema(
          { schema: { type: "number", exclusiveMaximum: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isFinite" } },
                { _tag: "Filter", meta: { _tag: "isLessThan", exclusiveMaximum: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isFinite()).check(Schema.isLessThan(1))`
        )
      })

      it("multipleOf", () => {
        assertFromJsonSchema(
          { schema: { type: "number", multipleOf: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isFinite" } },
                { _tag: "Filter", meta: { _tag: "isMultipleOf", divisor: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isFinite()).check(Schema.isMultipleOf(1))`
        )
      })
    })
  })

  describe("type: integer", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "integer" } },
        {
          representation: {
            _tag: "Number",
            checks: [
              { _tag: "Filter", meta: { _tag: "isInt" } }
            ]
          }
        },
        `Schema.Number.check(Schema.isInt())`
      )
    })

    describe("checks", () => {
      it("minimum", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", minimum: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isInt" } },
                { _tag: "Filter", meta: { _tag: "isGreaterThanOrEqualTo", minimum: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))`
        )
      })

      it("maximum", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", maximum: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isInt" } },
                { _tag: "Filter", meta: { _tag: "isLessThanOrEqualTo", maximum: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isInt()).check(Schema.isLessThanOrEqualTo(1))`
        )
      })

      it("exclusiveMinimum", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", exclusiveMinimum: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isInt" } },
                { _tag: "Filter", meta: { _tag: "isGreaterThan", exclusiveMinimum: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(1))`
        )
      })

      it("exclusiveMaximum", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", exclusiveMaximum: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isInt" } },
                { _tag: "Filter", meta: { _tag: "isLessThan", exclusiveMaximum: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isInt()).check(Schema.isLessThan(1))`
        )
      })

      it("multipleOf", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", multipleOf: 1 } },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isInt" } },
                { _tag: "Filter", meta: { _tag: "isMultipleOf", divisor: 1 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isInt()).check(Schema.isMultipleOf(1))`
        )
      })
    })
  })

  describe("type: boolean", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "boolean" } },
        {
          representation: { _tag: "Boolean" }
        },
        `Schema.Boolean`
      )
    })
  })

  describe("type: array", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "array" } },
        {
          representation: {
            _tag: "Arrays",
            elements: [],
            rest: [{ _tag: "Unknown" }],
            checks: []
          }
        },
        `Schema.Array(Schema.Unknown)`
      )
    })

    it("items", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "array",
            items: { type: "string" }
          }
        },
        {
          representation: { _tag: "Arrays", elements: [], rest: [{ _tag: "String", checks: [] }], checks: [] }
        },
        `Schema.Array(Schema.String)`
      )
    })

    it("prefixItems", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "array",
            prefixItems: [{ type: "string" }],
            maxItems: 1
          }
        },
        {
          representation: {
            _tag: "Arrays",
            elements: [
              { isOptional: true, type: { _tag: "String", checks: [] } }
            ],
            rest: [],
            checks: []
          }
        },
        `Schema.Tuple([Schema.optionalKey(Schema.String)])`
      )

      assertFromJsonSchema(
        {
          schema: {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            maxItems: 1
          }
        },
        {
          representation: {
            _tag: "Arrays",
            elements: [
              { isOptional: false, type: { _tag: "String", checks: [] } }
            ],
            rest: [],
            checks: []
          }
        },
        `Schema.Tuple([Schema.String])`
      )
    })

    it("prefixItems & minItems", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            items: { type: "number" }
          }
        },
        {
          representation: {
            _tag: "Arrays",
            elements: [
              { isOptional: false, type: { _tag: "String", checks: [] } }
            ],
            rest: [
              { _tag: "Number", checks: [{ _tag: "Filter", meta: { _tag: "isFinite" } }] }
            ],
            checks: []
          }
        },
        `Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number.check(Schema.isFinite())])`
      )
    })

    describe("checks", () => {
      it("minItems", () => {
        assertFromJsonSchema(
          { schema: { type: "array", minItems: 1 } },
          {
            representation: {
              _tag: "Arrays",
              elements: [],
              rest: [{ _tag: "Unknown" }],
              checks: [{ _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } }]
            }
          },
          `Schema.Array(Schema.Unknown).check(Schema.isMinLength(1))`
        )
      })

      it("maxItems", () => {
        assertFromJsonSchema(
          { schema: { type: "array", maxItems: 1 } },
          {
            representation: {
              _tag: "Arrays",
              elements: [],
              rest: [{ _tag: "Unknown" }],
              checks: [{ _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: 1 } }]
            }
          },
          `Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1))`
        )
      })

      it("uniqueItems", () => {
        assertFromJsonSchema(
          { schema: { type: "array", uniqueItems: true } },
          {
            representation: {
              _tag: "Arrays",
              elements: [],
              rest: [{ _tag: "Unknown" }],
              checks: [{ _tag: "Filter", meta: { _tag: "isUnique" } }]
            }
          },
          `Schema.Array(Schema.Unknown).check(Schema.isUnique())`
        )
      })
    })
  })

  describe("type: object", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "object" } },
        {
          representation: {
            _tag: "Objects",
            propertySignatures: [],
            indexSignatures: [
              { parameter: { _tag: "String", checks: [] }, type: { _tag: "Unknown" } }
            ],
            checks: []
          }
        },
        `Schema.Record(Schema.String, Schema.Unknown)`
      )
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            additionalProperties: false
          }
        },
        {
          representation: {
            _tag: "Objects",
            propertySignatures: [],
            indexSignatures: [],
            checks: []
          }
        },
        `Schema.Struct({  })`
      )
    })

    it("additionalProperties", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            additionalProperties: { type: "boolean" }
          }
        },
        {
          representation: {
            _tag: "Objects",
            propertySignatures: [],
            indexSignatures: [
              { parameter: { _tag: "String", checks: [] }, type: { _tag: "Boolean" } }
            ],
            checks: []
          }
        },
        `Schema.Record(Schema.String, Schema.Boolean)`
      )
    })

    it("properties", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" } },
            required: ["a"],
            additionalProperties: false
          }
        },
        {
          representation: {
            _tag: "Objects",
            propertySignatures: [
              {
                name: "a",
                type: { _tag: "String", checks: [] },
                isOptional: false,
                isMutable: false
              },
              {
                name: "b",
                type: { _tag: "String", checks: [] },
                isOptional: true,
                isMutable: false
              }
            ],
            indexSignatures: [],
            checks: []
          }
        },
        `Schema.Struct({ "a": Schema.String, "b": Schema.optionalKey(Schema.String) })`
      )
    })

    it("properties & additionalProperties", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
            additionalProperties: { type: "boolean" }
          }
        },
        {
          representation: {
            _tag: "Objects",
            propertySignatures: [{
              name: "a",
              type: { _tag: "String", checks: [] },
              isOptional: false,
              isMutable: false
            }],
            indexSignatures: [
              { parameter: { _tag: "String", checks: [] }, type: { _tag: "Boolean" } }
            ],
            checks: []
          }
        },
        `Schema.StructWithRest(Schema.Struct({ "a": Schema.String }), [Schema.Record(Schema.String, Schema.Boolean)])`
      )
    })

    it("patternProperties", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            patternProperties: {
              "a*": { type: "string" }
            },
            additionalProperties: false
          }
        },
        {
          representation: {
            _tag: "Objects",
            propertySignatures: [],
            indexSignatures: [
              {
                parameter: {
                  _tag: "String",
                  checks: [{ _tag: "Filter", meta: { _tag: "isPattern", regExp: new RegExp("a*") } }]
                },
                type: { _tag: "String", checks: [] }
              }
            ],
            checks: []
          }
        },
        `Schema.Record(Schema.String.check(Schema.isPattern(new RegExp("a*"))), Schema.String)`
      )
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            patternProperties: {
              "a*": { type: "string" },
              "b*": { type: "number" }
            },
            additionalProperties: false
          }
        },
        {
          representation: {
            _tag: "Objects",
            propertySignatures: [],
            indexSignatures: [
              {
                parameter: {
                  _tag: "String",
                  checks: [{ _tag: "Filter", meta: { _tag: "isPattern", regExp: new RegExp("a*") } }]
                },
                type: { _tag: "String", checks: [] }
              },
              {
                parameter: {
                  _tag: "String",
                  checks: [{ _tag: "Filter", meta: { _tag: "isPattern", regExp: new RegExp("b*") } }]
                },
                type: { _tag: "Number", checks: [{ _tag: "Filter", meta: { _tag: "isFinite" } }] }
              }
            ],
            checks: []
          }
        },
        `Schema.StructWithRest(Schema.Struct({  }), [Schema.Record(Schema.String.check(Schema.isPattern(new RegExp("a*"))), Schema.String), Schema.Record(Schema.String.check(Schema.isPattern(new RegExp("b*"))), Schema.Number.check(Schema.isFinite()))])`
      )
    })

    describe("checks", () => {
      it("minProperties", () => {
        assertFromJsonSchema(
          { schema: { type: "object", minProperties: 1 } },
          {
            representation: {
              _tag: "Objects",
              propertySignatures: [],
              indexSignatures: [
                { parameter: { _tag: "String", checks: [] }, type: { _tag: "Unknown" } }
              ],
              checks: [{ _tag: "Filter", meta: { _tag: "isMinProperties", minProperties: 1 } }]
            }
          },
          `Schema.Record(Schema.String, Schema.Unknown).check(Schema.isMinProperties(1))`
        )
      })

      it("maxProperties", () => {
        assertFromJsonSchema(
          { schema: { type: "object", maxProperties: 1 } },
          {
            representation: {
              _tag: "Objects",
              propertySignatures: [],
              indexSignatures: [
                { parameter: { _tag: "String", checks: [] }, type: { _tag: "Unknown" } }
              ],
              checks: [{ _tag: "Filter", meta: { _tag: "isMaxProperties", maxProperties: 1 } }]
            }
          },
          `Schema.Record(Schema.String, Schema.Unknown).check(Schema.isMaxProperties(1))`
        )
      })
    })

    describe("propertyNames", () => {
      it("pattern", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              propertyNames: { pattern: "^[A-Z]" }
            }
          },
          {
            representation: {
              _tag: "Objects",
              propertySignatures: [],
              indexSignatures: [
                {
                  parameter: { _tag: "String", checks: [] },
                  type: { _tag: "Unknown" }
                }
              ],
              checks: [{
                _tag: "Filter",
                meta: {
                  _tag: "isPropertyNames",
                  propertyNames: {
                    _tag: "String",
                    checks: [{ _tag: "Filter", meta: { _tag: "isPattern", regExp: new RegExp("^[A-Z]") } }]
                  }
                }
              }]
            }
          },
          `Schema.Record(Schema.String, Schema.Unknown).check(Schema.isPropertyNames(Schema.String.check(Schema.isPattern(new RegExp("^[A-Z]")))))`
        )
      })

      it("false", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              propertyNames: false
            }
          },
          {
            representation: {
              _tag: "Objects",
              propertySignatures: [],
              indexSignatures: [
                { parameter: { _tag: "String", checks: [] }, type: { _tag: "Unknown" } }
              ],
              checks: [
                { _tag: "Filter", meta: { _tag: "isPropertyNames", propertyNames: { _tag: "Never" } } }
              ]
            }
          },
          `Schema.Record(Schema.String, Schema.Unknown).check(Schema.isPropertyNames(Schema.Never))`
        )
      })

      it("allOf combines checks", () => {
        assertFromJsonSchema(
          {
            schema: {
              allOf: [
                { type: "object", propertyNames: { pattern: "^[A-Z]" } },
                { type: "object", propertyNames: { minLength: 2 } }
              ]
            }
          },
          {
            representation: {
              _tag: "Objects",
              propertySignatures: [],
              indexSignatures: [
                { parameter: { _tag: "String", checks: [] }, type: { _tag: "Unknown" } }
              ],
              checks: [
                {
                  _tag: "Filter",
                  meta: {
                    _tag: "isPropertyNames",
                    propertyNames: {
                      _tag: "String",
                      checks: [{ _tag: "Filter", meta: { _tag: "isPattern", regExp: new RegExp("^[A-Z]") } }]
                    }
                  }
                },
                {
                  _tag: "Filter",
                  meta: {
                    _tag: "isPropertyNames",
                    propertyNames: {
                      _tag: "String",
                      checks: [{ _tag: "Filter", meta: { _tag: "isMinLength", minLength: 2 } }]
                    }
                  }
                }
              ]
            }
          },
          `Schema.Record(Schema.String, Schema.Unknown).check(Schema.isPropertyNames(Schema.String.check(Schema.isPattern(new RegExp("^[A-Z]"))))).check(Schema.isPropertyNames(Schema.String.check(Schema.isMinLength(2))))`
        )
      })
    })
  })

  it("type: array of strings", () => {
    assertFromJsonSchema(
      {
        schema: { type: ["string", "null"] }
      },
      {
        representation: {
          _tag: "Union",
          types: [{ _tag: "String", checks: [] }, { _tag: "Null" }],
          mode: "anyOf"
        }
      },
      `Schema.Union([Schema.String, Schema.Null])`
    )
    assertFromJsonSchema(
      {
        schema: {
          type: ["string", "null"],
          description: "a"
        }
      },
      {
        representation: {
          _tag: "Union",
          types: [{ _tag: "String", checks: [] }, { _tag: "Null" }],
          mode: "anyOf",
          annotations: { description: "a" }
        }
      },
      `Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "a" })`
    )
  })

  describe("$ref", () => {
    it("should create a Reference and a definition", () => {
      assertFromJsonSchema(
        {
          schema: {
            $ref: "#/$defs/A",
            $defs: {
              A: {
                type: "string"
              }
            }
          }
        },
        {
          representation: { _tag: "Reference", $ref: "A" },
          references: {
            A: {
              _tag: "String",
              checks: []
            }
          }
        }
      )
    })

    it("should resolve the $ref if there are annotations", () => {
      assertFromJsonSchema(
        {
          schema: {
            $ref: "#/$defs/A",
            description: "a",
            $defs: {
              A: {
                type: "string"
              }
            }
          }
        },
        {
          representation: {
            _tag: "String",
            checks: [],
            annotations: { description: "a" }
          },
          references: {
            A: {
              _tag: "String",
              checks: []
            }
          }
        }
      )
    })

    it("should resolve the $ref if there is an allOf", () => {
      assertFromJsonSchema(
        {
          schema: {
            allOf: [
              { $ref: "#/$defs/A" },
              { description: "a" }
            ],
            $defs: {
              A: {
                type: "string"
              }
            }
          }
        },
        {
          representation: {
            _tag: "String",
            checks: [],
            annotations: { description: "a" }
          },
          references: {
            A: {
              _tag: "String",
              checks: []
            }
          }
        }
      )
    })

    it("recursive schema", () => {
      assertFromJsonSchema(
        {
          schema: {
            $ref: "#/$defs/A",
            $defs: {
              A: {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "children": {
                    "type": "array",
                    "items": {
                      "$ref": "#/$defs/A"
                    }
                  }
                },
                "required": [
                  "name",
                  "children"
                ],
                "additionalProperties": false
              }
            }
          }
        },
        {
          representation: { _tag: "Reference", $ref: "A" },
          references: {
            A: {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "name",
                  type: { _tag: "String", checks: [] },
                  isOptional: false,
                  isMutable: false
                },
                {
                  name: "children",
                  type: {
                    _tag: "Arrays",
                    elements: [],
                    rest: [{
                      _tag: "Suspend",
                      checks: [],
                      thunk: {
                        _tag: "Reference",
                        $ref: "A"
                      }
                    }],
                    checks: []
                  },
                  isOptional: false,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            }
          }
        }
      )
    })
  })

  describe("allOf", () => {
    it("no type", () => {
      assertFromJsonSchema(
        {
          schema: {
            allOf: [
              { type: "string" }
            ]
          }
        },
        {
          representation: {
            _tag: "String",
            checks: []
          }
        },
        `Schema.String`
      )
    })

    describe("type: string", () => {
      it("& minLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1 }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } }
              ]
            }
          },
          `Schema.String.check(Schema.isMinLength(1))`
        )
      })

      it("& minLength + description", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, description: "b" }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 }, annotations: { description: "b" } }
              ]
            }
          },
          `Schema.String.check(Schema.isMinLength(1, { "description": "b" }))`
        )
      })

      it("description & minLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              allOf: [
                { minLength: 1 }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } }
              ],
              annotations: { description: "a" }
            }
          },
          `Schema.String.annotate({ "description": "a" }).check(Schema.isMinLength(1))`
        )
      })

      it("description & minLength + description", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              allOf: [
                { minLength: 1, description: "b" }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 }, annotations: { description: "b" } }
              ],
              annotations: { description: "a" }
            }
          },
          `Schema.String.annotate({ "description": "a" }).check(Schema.isMinLength(1, { "description": "b" }))`
        )
      })

      it("maxLength & minLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              maxLength: 2,
              allOf: [
                { minLength: 1 }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: 2 } },
                { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } }
              ]
            }
          },
          `Schema.String.check(Schema.isMaxLength(2)).check(Schema.isMinLength(1))`
        )
      })

      it("description + maxLength & minLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              maxLength: 2,
              allOf: [
                { minLength: 1 }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: 2 } },
                { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } }
              ],
              annotations: { description: "a" }
            }
          },
          `Schema.String.annotate({ "description": "a" }).check(Schema.isMaxLength(2)).check(Schema.isMinLength(1))`
        )
      })

      it("description + maxLength & minLength + description", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              maxLength: 2,
              allOf: [
                { minLength: 1, description: "b" }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: 2 } },
                { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 }, annotations: { description: "b" } }
              ],
              annotations: { description: "a" }
            }
          },
          `Schema.String.annotate({ "description": "a" }).check(Schema.isMaxLength(2)).check(Schema.isMinLength(1, { "description": "b" }))`
        )
      })

      it("& minLength + maxLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, maxLength: 2 }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } },
                { _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: 2 } }
              ]
            }
          },
          `Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(2))`
        )
      })

      it("& minLength + maxLength + description", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, maxLength: 2, description: "b" }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                {
                  _tag: "FilterGroup",
                  checks: [
                    { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } },
                    { _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: 2 } }
                  ],
                  annotations: { description: "b" }
                }
              ]
            }
          },
          `Schema.String.check(Schema.makeFilterGroup([Schema.isMinLength(1), Schema.isMaxLength(2)], { "description": "b" }))`
        )
      })

      it("& (minLength & maxLength + description)", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, allOf: [{ maxLength: 2, description: "c" }] }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } },
                { _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: 2 }, annotations: { description: "c" } }
              ]
            }
          },
          `Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(2, { "description": "c" }))`
        )
      })

      it("& (minLength + description & maxLength + description)", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, description: "b", allOf: [{ maxLength: 2, description: "c" }] }
              ]
            }
          },
          {
            representation: {
              _tag: "String",
              checks: [
                {
                  _tag: "FilterGroup",
                  checks: [
                    { _tag: "Filter", meta: { _tag: "isMinLength", minLength: 1 } },
                    { _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: 2 }, annotations: { description: "c" } }
                  ],
                  annotations: { description: "b" }
                }
              ]
            }
          },
          `Schema.String.check(Schema.makeFilterGroup([Schema.isMinLength(1), Schema.isMaxLength(2, { "description": "c" })], { "description": "b" }))`
        )
      })

      it("& string enum", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { enum: ["a"] }
              ]
            }
          },
          {
            representation: {
              _tag: "Literal",
              literal: "a"
            }
          },
          `Schema.Literal("a")`
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              allOf: [
                { enum: ["a"], description: "b" }
              ]
            }
          },
          {
            representation: {
              _tag: "Literal",
              literal: "a",
              annotations: { description: "b" }
            }
          },
          `Schema.Literal("a").annotate({ "description": "b" })`
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { enum: ["a", "b"] }
              ]
            }
          },
          {
            representation: {
              _tag: "Union",
              types: [
                { _tag: "Literal", literal: "a" },
                { _tag: "Literal", literal: "b" }
              ],
              mode: "anyOf"
            }
          },
          `Schema.Literals(["a", "b"])`
        )
      })

      it("& mixed enum", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { enum: ["a", 1] }
              ]
            }
          },
          {
            representation: {
              _tag: "Union",
              types: [
                { _tag: "Literal", literal: "a" }
              ],
              mode: "anyOf"
            }
          },
          `Schema.Literal("a")`
        )
      })
    })

    describe("type: number", () => {
      it("number & integer", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { type: "integer" }
              ]
            }
          },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isFinite" } },
                { _tag: "Filter", meta: { _tag: "isInt" } }
              ]
            }
          },
          `Schema.Number.check(Schema.isFinite()).check(Schema.isInt())`
        )
      })

      it("number & integer & integer", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { type: "integer", minimum: 2 },
                { type: "integer", maximum: 2 }
              ]
            }
          },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isFinite" } },
                { _tag: "Filter", meta: { _tag: "isInt" } },
                { _tag: "Filter", meta: { _tag: "isGreaterThanOrEqualTo", minimum: 2 } },
                { _tag: "Filter", meta: { _tag: "isLessThanOrEqualTo", maximum: 2 } }
              ]
            }
          },
          `Schema.Number.check(Schema.isFinite()).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(2)).check(Schema.isLessThanOrEqualTo(2))`
        )
      })

      it("integer & number", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "integer",
              allOf: [
                { type: "number" }
              ]
            }
          },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isInt" } },
                { _tag: "Filter", meta: { _tag: "isFinite" } }
              ]
            }
          },
          `Schema.Number.check(Schema.isInt()).check(Schema.isFinite())`
        )
      })

      it("& (minimum + description & maximum + description)", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { minimum: 1, description: "b", allOf: [{ maximum: 2, description: "c" }] }
              ]
            }
          },
          {
            representation: {
              _tag: "Number",
              checks: [
                { _tag: "Filter", meta: { _tag: "isFinite" } },
                {
                  _tag: "FilterGroup",
                  checks: [
                    { _tag: "Filter", meta: { _tag: "isGreaterThanOrEqualTo", minimum: 1 } },
                    {
                      _tag: "Filter",
                      meta: { _tag: "isLessThanOrEqualTo", maximum: 2 },
                      annotations: { description: "c" }
                    }
                  ],
                  annotations: { description: "b" }
                }
              ]
            }
          },
          `Schema.Number.check(Schema.isFinite()).check(Schema.makeFilterGroup([Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(2, { "description": "c" })], { "description": "b" }))`
        )
      })

      it("& number enum", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { enum: [1] }
              ]
            }
          },
          {
            representation: {
              _tag: "Literal",
              literal: 1
            }
          },
          `Schema.Literal(1)`
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              description: "a",
              allOf: [
                { enum: [1], description: "b" }
              ]
            }
          },
          {
            representation: {
              _tag: "Literal",
              literal: 1,
              annotations: { description: "b" }
            }
          },
          `Schema.Literal(1).annotate({ "description": "b" })`
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { enum: [1, 2] }
              ]
            }
          },
          {
            representation: {
              _tag: "Union",
              types: [
                { _tag: "Literal", literal: 1 },
                { _tag: "Literal", literal: 2 }
              ],
              mode: "anyOf"
            }
          },
          `Schema.Literals([1, 2])`
        )
      })
    })

    describe("type: boolean", () => {
      it("& boolean enum", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "boolean",
              allOf: [
                { enum: [true] }
              ]
            }
          },
          {
            representation: {
              _tag: "Literal",
              literal: true
            }
          },
          `Schema.Literal(true)`
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "boolean",
              description: "a",
              allOf: [
                { enum: [true], description: "b" }
              ]
            }
          },
          {
            representation: {
              _tag: "Literal",
              literal: true,
              annotations: { description: "b" }
            }
          },
          `Schema.Literal(true).annotate({ "description": "b" })`
        )
      })
    })

    describe("type: array", () => {
      it("uniqueItems & uniqueItems", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "array",
              uniqueItems: true,
              allOf: [
                { uniqueItems: true }
              ]
            }
          },
          {
            representation: {
              _tag: "Arrays",
              elements: [],
              rest: [{ _tag: "Unknown" }],
              checks: [{ _tag: "Filter", meta: { _tag: "isUnique" } }]
            }
          },
          `Schema.Array(Schema.Unknown).check(Schema.isUnique())`
        )
      })
    })

    describe("type: object", () => {
      it("add properties", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              additionalProperties: false,
              allOf: [
                { properties: { a: { type: "string" } } }
              ]
            }
          },
          {
            representation: {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "a",
                  type: { _tag: "String", checks: [] },
                  isOptional: true,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            }
          },
          `Schema.Struct({ "a": Schema.optionalKey(Schema.String) })`
        )
      })

      it("add additionalProperties", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              allOf: [
                { additionalProperties: { type: "boolean" } }
              ]
            }
          },
          {
            representation: {
              _tag: "Objects",
              propertySignatures: [],
              indexSignatures: [
                { parameter: { _tag: "String", checks: [] }, type: { _tag: "Boolean" } }
              ],
              checks: []
            }
          },
          `Schema.Record(Schema.String, Schema.Boolean)`
        )
      })
    })
  })

  describe("options", () => {
    describe("onEnter", () => {
      it("additionalProperties false via onEnter", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              properties: {
                a: { type: "string" }
              },
              required: ["a"]
            },
            options: {
              onEnter: (js) => {
                if (js.type === "object" && js.additionalProperties === undefined) {
                  return { ...js, additionalProperties: false }
                }
                return js
              }
            }
          },
          {
            representation: {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "a",
                  type: { _tag: "String", checks: [] },
                  isOptional: false,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            }
          },
          `Schema.Struct({ "a": Schema.String })`
        )
      })

      it("strips annotation keys via onEnter", () => {
        assertFromJsonSchema(
          {
            schema: {
              title: "a",
              description: "b",
              examples: ["d"]
            },
            options: {
              onEnter: (js) => {
                const out = { ...js }
                delete out.examples
                return out
              }
            }
          },
          {
            representation: {
              _tag: "Unknown",
              annotations: {
                title: "a",
                description: "b"
              }
            }
          },
          `Schema.Unknown.annotate({ "title": "a", "description": "b" })`
        )
      })

      it("filters annotations by predicate via onEnter", () => {
        assertFromJsonSchema(
          {
            schema: {
              title: "a",
              description: "b",
              examples: ["d"],
              default: "c"
            },
            options: {
              onEnter: (js) => {
                const out: any = {}
                for (const [k, v] of Object.entries(js)) {
                  if (k === "title" || k === "default" || k === "type") out[k] = v
                }
                return out
              }
            }
          },
          {
            representation: {
              _tag: "Unknown",
              annotations: {
                title: "a",
                default: "c"
              }
            }
          },
          `Schema.Unknown.annotate({ "title": "a", "default": "c" })`
        )
      })

      it("default preserves all annotations", () => {
        assertFromJsonSchema(
          {
            schema: {
              title: "a",
              description: "b",
              default: "c",
              examples: ["d"]
            }
          },
          {
            representation: {
              _tag: "Unknown",
              annotations: {
                title: "a",
                description: "b",
                default: "c",
                examples: ["d"]
              }
            }
          },
          `Schema.Unknown.annotate({ "title": "a", "description": "b", "default": "c", "examples": ["d"] })`
        )
      })
    })
  })
})
