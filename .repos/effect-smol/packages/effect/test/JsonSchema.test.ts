import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import * as JsonSchema from "effect/JsonSchema"

describe("JsonSchema", () => {
  describe("sanitizeOpenApiComponentsKey", () => {
    const sanitizeOpenApiComponentsKey = JsonSchema.sanitizeOpenApiComponentsSchemasKey

    it("returns '_' for empty input", () => {
      deepStrictEqual(sanitizeOpenApiComponentsKey(""), "_")
    })

    it("returns input when already valid", () => {
      deepStrictEqual(sanitizeOpenApiComponentsKey("Simple"), "Simple")
      deepStrictEqual(sanitizeOpenApiComponentsKey("with-dash"), "with-dash")
      deepStrictEqual(sanitizeOpenApiComponentsKey("with_underscore"), "with_underscore")
      deepStrictEqual(sanitizeOpenApiComponentsKey("with.dot"), "with.dot")
      deepStrictEqual(sanitizeOpenApiComponentsKey("A1.B2-_"), "A1.B2-_")
    })

    it("replaces invalid characters with '_'", () => {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["a b", "a_b"],
        ["a/b", "a_b"],
        ["a:b", "a_b"],
        ["a@b", "a_b"],
        ["a#b", "a_b"],
        ["a?b", "a_b"],
        ["a+b", "a_b"],
        ["a*b", "a_b"],
        ["a,b", "a_b"],
        ["a;b", "a_b"],
        ["a|b", "a_b"],
        ["a=b", "a_b"]
      ]
      for (const [input, expected] of cases) {
        deepStrictEqual(sanitizeOpenApiComponentsKey(input), expected)
      }
    })

    it("preserves length when only replacements are needed", () => {
      deepStrictEqual(sanitizeOpenApiComponentsKey("a b").length, "a b".length)
      deepStrictEqual(sanitizeOpenApiComponentsKey("..").length, "..".length)
      deepStrictEqual(sanitizeOpenApiComponentsKey("a--b").length, "a--b".length)
    })

    it("replaces non-ascii characters with '_'", () => {
      deepStrictEqual(sanitizeOpenApiComponentsKey("café"), "caf_")
      deepStrictEqual(sanitizeOpenApiComponentsKey("你好"), "__")
      deepStrictEqual(sanitizeOpenApiComponentsKey("🤖"), "_")
      deepStrictEqual(sanitizeOpenApiComponentsKey("a🤖b"), "a_b")
    })

    it("is idempotent", () => {
      const inputs = [
        "",
        "Simple",
        "a b",
        "a/b",
        "a..b",
        "café",
        "🤖",
        "A1.B2-_"
      ] as const
      for (const input of inputs) {
        const once = sanitizeOpenApiComponentsKey(input)
        const twice = sanitizeOpenApiComponentsKey(once)
        deepStrictEqual(twice, once)
      }
    })
  })

  describe("fromSchemaDraft07", () => {
    it("normalizes a schema without definitions to the canonical document shape", () => {
      const input: JsonSchema.JsonSchema = {
        type: "string"
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "string"
        },
        definitions: {}
      })
    })

    it("extracts root definitions and rewrites Draft-07 refs to $defs refs", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          a: { $ref: "#/definitions/A" },
          b: { $ref: "#/definitions/B" }
        },
        definitions: {
          A: {
            type: "string",
            $ref: "#/definitions/B"
          },
          B: {
            type: "number"
          }
        }
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            a: { $ref: "#/$defs/A" },
            b: { $ref: "#/$defs/B" }
          }
        },
        definitions: {
          A: {
            type: "string",
            $ref: "#/$defs/B"
          },
          B: {
            type: "number"
          }
        }
      })
    })

    it("converts Draft-07 tuple items to prefixItems", () => {
      const input: JsonSchema.JsonSchema = {
        type: "array",
        items: [
          { type: "string" },
          { type: "number" }
        ],
        additionalItems: { type: "boolean" }
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "array",
          prefixItems: [
            { type: "string" },
            { type: "number" }
          ],
          items: { type: "boolean" }
        },
        definitions: {}
      })
    })

    it("preserves a single items schema as items", () => {
      const input: JsonSchema.JsonSchema = {
        type: "array",
        items: { type: "string" }
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "array",
          items: { type: "string" }
        },
        definitions: {}
      })
    })

    it("should preserve annotations", () => {
      const input: JsonSchema.JsonSchema = {
        type: "string",
        title: "My String",
        description: "A string value",
        default: "default",
        examples: ["example1", "example2"],
        format: "email",
        readOnly: true,
        writeOnly: true
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "string",
          title: "My String",
          description: "A string value",
          default: "default",
          examples: ["example1", "example2"],
          format: "email",
          readOnly: true,
          writeOnly: true
        },
        definitions: {}
      })
    })

    it("should handle string constraints", () => {
      const input: JsonSchema.JsonSchema = {
        type: "string",
        pattern: "^[a-z]+$",
        minLength: 1,
        maxLength: 100
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "string",
          pattern: "^[a-z]+$",
          minLength: 1,
          maxLength: 100
        },
        definitions: {}
      })
    })

    it("should handle number constraints", () => {
      const input: JsonSchema.JsonSchema = {
        type: "number",
        minimum: 0,
        maximum: 100,
        exclusiveMinimum: 0,
        exclusiveMaximum: 100,
        multipleOf: 2
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "number",
          minimum: 0,
          maximum: 100,
          exclusiveMinimum: 0,
          exclusiveMaximum: 100,
          multipleOf: 2
        },
        definitions: {}
      })
    })

    it("should handle array constraints", () => {
      const input: JsonSchema.JsonSchema = {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 10,
        uniqueItems: true
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          uniqueItems: true
        },
        definitions: {}
      })
    })

    it("should handle object constraints", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" }
        },
        required: ["name"],
        patternProperties: {
          "^S_": { type: "string" }
        },
        additionalProperties: { type: "boolean" },
        propertyNames: { pattern: "^[A-Z]" },
        minProperties: 1,
        maxProperties: 10
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" }
          },
          required: ["name"],
          patternProperties: {
            "^S_": { type: "string" }
          },
          additionalProperties: { type: "boolean" },
          propertyNames: { pattern: "^[A-Z]" },
          minProperties: 1,
          maxProperties: 10
        },
        definitions: {}
      })
    })

    it("should handle enum, const, allOf, anyOf, oneOf", () => {
      const input: JsonSchema.JsonSchema = {
        enum: ["a", "b", "c"],
        const: "constant",
        allOf: [
          { type: "array", items: { type: "string" } },
          { minItems: 1 }
        ],
        anyOf: [
          { type: "array", items: [{ type: "string" }] },
          { type: "number" }
        ],
        oneOf: [
          { type: "array", items: [{ type: "string" }], additionalItems: { type: "number" } },
          { type: "boolean" }
        ]
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          enum: ["a", "b", "c"],
          const: "constant",
          allOf: [
            { type: "array", items: { type: "string" } },
            { minItems: 1 }
          ],
          anyOf: [
            { type: "array", prefixItems: [{ type: "string" }] },
            { type: "number" }
          ],
          oneOf: [
            { type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } },
            { type: "boolean" }
          ]
        },
        definitions: {}
      })
    })

    it("preserves nested definitions and local JSON Pointer refs", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          nested: {
            definitions: {
              NestedType: {
                type: "number"
              }
            },
            $ref: "#/properties/nested/definitions/NestedType"
          }
        }
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            nested: {
              definitions: {
                NestedType: {
                  type: "number"
                }
              },
              $ref: "#/properties/nested/definitions/NestedType"
            }
          }
        },
        definitions: {}
      })
    })

    it("drops non-standard properties in Draft-07 input", () => {
      const input: JsonSchema.JsonSchema = {
        type: "string",
        "x-custom": "value"
      }
      const result = JsonSchema.fromSchemaDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "string"
        },
        definitions: {}
      })
    })
  })

  describe("fromSchemaDraft2020_12", () => {
    it("normalizes a schema without $defs to the canonical document shape", () => {
      const input: JsonSchema.JsonSchema = {
        type: "string"
      }
      const result = JsonSchema.fromSchemaDraft2020_12(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "string"
        },
        definitions: {}
      })
    })

    it("extracts root $defs without rewriting Draft-2020-12 refs", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          a: { $ref: "#/$defs/A" },
          b: { $ref: "#/$defs/B" }
        },
        $defs: {
          A: {
            type: "string",
            $ref: "#/$defs/B"
          },
          B: {
            type: "number"
          }
        }
      }
      const result = JsonSchema.fromSchemaDraft2020_12(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            a: { $ref: "#/$defs/A" },
            b: { $ref: "#/$defs/B" }
          }
        },
        definitions: {
          A: {
            type: "string",
            $ref: "#/$defs/B"
          },
          B: {
            type: "number"
          }
        }
      })
    })

    it("preserves nested definitions and local JSON Pointer refs", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          nested: {
            definitions: {
              NestedType: {
                type: "number"
              }
            },
            $ref: "#/properties/nested/definitions/NestedType"
          }
        }
      }
      const result = JsonSchema.fromSchemaDraft2020_12(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            nested: {
              definitions: {
                NestedType: {
                  type: "number"
                }
              },
              $ref: "#/properties/nested/definitions/NestedType"
            }
          }
        },
        definitions: {}
      })
    })

    it("keeps non-standard properties for Draft-2020-12 input", () => {
      const input: JsonSchema.JsonSchema = {
        type: "string",
        "x-custom": "value"
      }
      const result = JsonSchema.fromSchemaDraft2020_12(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "string",
          "x-custom": "value"
        },
        definitions: {}
      })
    })
  })

  describe("fromSchemaOpenApi3_1", () => {
    it("rewrites OpenAPI component schema refs to $defs refs", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          a: { $ref: "#/components/schemas/A" },
          b: { $ref: "#/components/schemas/B" }
        }
      }
      const result = JsonSchema.fromSchemaOpenApi3_1(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            a: { $ref: "#/$defs/A" },
            b: { $ref: "#/$defs/B" }
          }
        },
        definitions: {}
      })
    })

    it("extracts root $defs after rewriting OpenAPI component refs", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          a: {
            $ref: "#/components/schemas/A"
          }
        },
        $defs: {
          MyType: {
            type: "string"
          }
        }
      }
      const result = JsonSchema.fromSchemaOpenApi3_1(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            a: {
              $ref: "#/$defs/A"
            }
          }
        },
        definitions: {
          MyType: {
            type: "string"
          }
        }
      })
    })

    it("preserves nested definitions and local JSON Pointer refs", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          nested: {
            definitions: {
              NestedType: {
                type: "number"
              }
            },
            $ref: "#/properties/nested/definitions/NestedType"
          }
        }
      }
      const result = JsonSchema.fromSchemaOpenApi3_1(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            nested: {
              definitions: {
                NestedType: {
                  type: "number"
                }
              },
              $ref: "#/properties/nested/definitions/NestedType"
            }
          }
        },
        definitions: {}
      })
    })

    it("keeps non-standard properties for OpenAPI 3.1 input", () => {
      const input: JsonSchema.JsonSchema = {
        type: "string",
        "x-custom": "value"
      }
      const result = JsonSchema.fromSchemaOpenApi3_1(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "string",
          "x-custom": "value"
        },
        definitions: {}
      })
    })
  })

  describe("fromSchemaOpenApi3_0", () => {
    function assertFromSchemaOpenApi3_0(input: JsonSchema.JsonSchema, expected: {
      readonly schema: JsonSchema.JsonSchema
      readonly definitions?: JsonSchema.Definitions
    }) {
      const result = JsonSchema.fromSchemaOpenApi3_0(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: expected.schema,
        definitions: expected.definitions ?? {}
      })
    }

    it("rewrites OpenAPI 3.0 component schema refs to $defs refs", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          a: { $ref: "#/components/schemas/A" },
          b: { $ref: "#/components/schemas/B" }
        }
      }
      const result = JsonSchema.fromSchemaOpenApi3_0(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            a: { $ref: "#/$defs/A" },
            b: { $ref: "#/$defs/B" }
          }
        },
        definitions: {}
      })
    })

    it("extracts root definitions after rewriting OpenAPI component refs", () => {
      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          a: {
            $ref: "#/components/schemas/A"
          }
        },
        definitions: {
          MyType: {
            type: "string"
          }
        }
      }
      const result = JsonSchema.fromSchemaOpenApi3_0(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            a: {
              $ref: "#/$defs/A"
            }
          }
        },
        definitions: {
          MyType: {
            type: "string"
          }
        }
      })
    })

    it("normalizes singular OpenAPI 3.0 example to a draft examples array", () => {
      const input: JsonSchema.JsonSchema = {
        type: "string",
        example: "a"
      }
      const result = JsonSchema.fromSchemaOpenApi3_0(input)
      deepStrictEqual(result, {
        dialect: "draft-2020-12",
        schema: {
          type: "string",
          examples: ["a"]
        },
        definitions: {}
      })
    })

    describe("nullable", () => {
      it("expands nullable schema without other keywords to anyOf", () => {
        assertFromSchemaOpenApi3_0(
          { nullable: true },
          {
            schema: {
              anyOf: [
                {},
                { type: "null" }
              ]
            }
          }
        )
      })

      it("adds null to a string type", () => {
        const input: JsonSchema.JsonSchema = {
          type: "string",
          nullable: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: ["string", "null"]
          },
          definitions: {}
        })
      })

      it("adds null to a type array", () => {
        const input: JsonSchema.JsonSchema = {
          type: ["string", "number"],
          nullable: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: ["string", "number", "null"]
          },
          definitions: {}
        })
      })

      it("keeps a non-null const while adding null to the type", () => {
        const input: JsonSchema.JsonSchema = {
          type: "string",
          const: "a",
          nullable: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: ["string", "null"],
            const: "a"
          },
          definitions: {}
        })
      })

      it("wraps a non-null const in anyOf when type is absent", () => {
        const input: JsonSchema.JsonSchema = {
          const: "a",
          nullable: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            anyOf: [
              { const: "a" },
              { type: "null" }
            ]
          },
          definitions: {}
        })
      })

      it("keeps a null const without adding anyOf", () => {
        const input: JsonSchema.JsonSchema = {
          const: null,
          nullable: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            const: null
          },
          definitions: {}
        })
      })

      it("adds null to enum values and type", () => {
        const input: JsonSchema.JsonSchema = {
          type: "string",
          enum: ["a", "b"],
          nullable: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: ["string", "null"],
            enum: ["a", "b", null]
          },
          definitions: {}
        })
      })

      it("does not duplicate null in enum values", () => {
        const input: JsonSchema.JsonSchema = {
          type: "string",
          enum: ["a", "b", null],
          nullable: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: ["string", "null"],
            enum: ["a", "b", null]
          },
          definitions: {}
        })
      })

      it("preserves enum when null is the only enum value", () => {
        const input: JsonSchema.JsonSchema = {
          type: "string",
          enum: [null],
          nullable: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: ["string", "null"],
            enum: [null]
          },
          definitions: {}
        })
      })

      it("uses anyOf for nullable schemas without type", () => {
        const input: JsonSchema.JsonSchema = {
          nullable: true,
          minimum: 0
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            anyOf: [
              {
                minimum: 0
              },
              {
                type: "null"
              }
            ]
          },
          definitions: {}
        })
      })

      it("drops nullable: false", () => {
        const input: JsonSchema.JsonSchema = {
          type: "string",
          nullable: false
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: "string"
          },
          definitions: {}
        })
      })

      it("normalizes nullable inside allOf independently from the parent", () => {
        assertFromSchemaOpenApi3_0(
          {
            type: "string",
            allOf: [{ nullable: true }]
          },
          {
            schema: {
              type: "string",
              allOf: [{
                anyOf: [
                  {},
                  { type: "null" }
                ]
              }]
            }
          }
        )
        assertFromSchemaOpenApi3_0(
          {
            type: "string",
            nullable: true,
            allOf: [{ nullable: true }]
          },
          {
            schema: {
              type: ["string", "null"],
              allOf: [{
                anyOf: [
                  {},
                  { type: "null" }
                ]
              }]
            }
          }
        )
      })
    })

    describe("exclusivity", () => {
      it("turns exclusiveMinimum: true into exclusiveMinimum: minimum", () => {
        const input: JsonSchema.JsonSchema = {
          type: "number",
          minimum: 10,
          exclusiveMinimum: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: "number",
            exclusiveMinimum: 10
          },
          definitions: {}
        })
      })

      it("turns exclusiveMaximum: true into exclusiveMaximum: maximum", () => {
        const input: JsonSchema.JsonSchema = {
          type: "number",
          maximum: 100,
          exclusiveMaximum: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: "number",
            exclusiveMaximum: 100
          },
          definitions: {}
        })
      })

      it("drops exclusiveMinimum: false", () => {
        const input: JsonSchema.JsonSchema = {
          type: "number",
          minimum: 10,
          exclusiveMinimum: false
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: "number",
            minimum: 10
          },
          definitions: {}
        })
      })

      it("drops exclusiveMaximum: false", () => {
        const input: JsonSchema.JsonSchema = {
          type: "number",
          maximum: 100,
          exclusiveMaximum: false
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: "number",
            maximum: 100
          },
          definitions: {}
        })
      })

      it("drops exclusiveMinimum: true when minimum is absent", () => {
        const input: JsonSchema.JsonSchema = {
          type: "number",
          exclusiveMinimum: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: "number"
          },
          definitions: {}
        })
      })

      it("drops exclusiveMaximum: true when maximum is absent", () => {
        const input: JsonSchema.JsonSchema = {
          type: "number",
          exclusiveMaximum: true
        }
        const result = JsonSchema.fromSchemaOpenApi3_0(input)
        deepStrictEqual(result, {
          dialect: "draft-2020-12",
          schema: {
            type: "number"
          },
          definitions: {}
        })
      })
    })
  })

  describe("toDocumentDraft07", () => {
    it("rewrites $defs refs to Draft-07 definitions refs", () => {
      const input: JsonSchema.Document<"draft-2020-12"> = {
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            a: { $ref: "#/$defs/A" },
            b: { $ref: "#/$defs/B" }
          }
        },
        definitions: {
          A: {
            type: "string",
            $ref: "#/$defs/B"
          },
          B: {
            type: "number"
          }
        }
      }
      const result = JsonSchema.toDocumentDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-07",
        schema: {
          type: "object",
          properties: {
            a: { $ref: "#/definitions/A" },
            b: { $ref: "#/definitions/B" }
          }
        },
        definitions: {
          A: {
            type: "string",
            $ref: "#/definitions/B"
          },
          B: {
            type: "number"
          }
        }
      })
    })

    it("converts prefixItems to a Draft-07 items tuple", () => {
      const input: JsonSchema.Document<"draft-2020-12"> = {
        dialect: "draft-2020-12",
        schema: {
          type: "array",
          prefixItems: [
            { type: "string" },
            { type: "number" }
          ],
          items: { type: "boolean" }
        },
        definitions: {}
      }
      const result = JsonSchema.toDocumentDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-07",
        schema: {
          type: "array",
          items: [
            { type: "string" },
            { type: "number" }
          ],
          additionalItems: { type: "boolean" }
        },
        definitions: {}
      })
    })

    it("preserves a single items schema as items", () => {
      const input: JsonSchema.Document<"draft-2020-12"> = {
        dialect: "draft-2020-12",
        schema: {
          type: "array",
          items: { type: "string" }
        },
        definitions: {}
      }
      const result = JsonSchema.toDocumentDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-07",
        schema: {
          type: "array",
          items: { type: "string" }
        },
        definitions: {}
      })
    })

    it("drops non-standard properties in Draft-07 output", () => {
      const input: JsonSchema.Document<"draft-2020-12"> = {
        dialect: "draft-2020-12",
        schema: {
          type: "string",
          "x-custom": "value"
        },
        definitions: {}
      }
      const result = JsonSchema.toDocumentDraft07(input)
      deepStrictEqual(result, {
        dialect: "draft-07",
        schema: {
          type: "string"
        },
        definitions: {}
      })
    })
  })

  describe("toDocumentOpenApi3_1", () => {
    it("should rewrite `$defs` references to `components/schemas`", () => {
      const input: JsonSchema.MultiDocument<"draft-2020-12"> = {
        dialect: "draft-2020-12",
        schemas: [
          {
            type: "object",
            properties: {
              a: { $ref: "#/$defs/A" },
              b: { $ref: "#/$defs/B" }
            }
          }
        ],
        definitions: {
          A: {
            type: "string",
            $ref: "#/$defs/B"
          },
          B: {
            type: "number"
          }
        }
      }
      const result = JsonSchema.toMultiDocumentOpenApi3_1(input)
      deepStrictEqual(result, {
        dialect: "openapi-3.1",
        schemas: [
          {
            type: "object",
            properties: {
              a: { $ref: "#/components/schemas/A" },
              b: { $ref: "#/components/schemas/B" }
            }
          }
        ],
        definitions: {
          A: {
            type: "string",
            $ref: "#/components/schemas/B"
          },
          B: {
            type: "number"
          }
        }
      })
    })

    it("sanitizes component schema keys and rewritten refs together", () => {
      const input: JsonSchema.MultiDocument<"draft-2020-12"> = {
        dialect: "draft-2020-12",
        schemas: [
          {
            type: "object",
            properties: {
              "A.B": { "$ref": "#/$defs/A$B" }
            }
          }
        ],
        definitions: {
          "A$B": { "$ref": "#/$defs/B$C" },
          "B$C": { type: "string" }
        }
      }
      const result = JsonSchema.toMultiDocumentOpenApi3_1(input)
      deepStrictEqual(result, {
        dialect: "openapi-3.1",
        schemas: [
          {
            type: "object",
            properties: {
              "A.B": { "$ref": "#/components/schemas/A_B" }
            }
          }
        ],
        definitions: {
          "A_B": { "$ref": "#/components/schemas/B_C" },
          "B_C": { type: "string" }
        }
      })
    })
  })

  describe("roundtrip conversions", () => {
    it("preserves a Draft-07 schema and definitions through canonical form", () => {
      const original: JsonSchema.JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          items: {
            type: "array",
            items: [
              { type: "string" },
              { type: "number" }
            ],
            additionalItems: { type: "boolean" }
          },
          ref: {
            $ref: "#/definitions/MyType"
          }
        },
        definitions: {
          MyType: {
            type: "string"
          }
        }
      }

      const to2020_12 = JsonSchema.fromSchemaDraft07(original)
      const backTo07 = JsonSchema.toDocumentDraft07(to2020_12)

      deepStrictEqual(backTo07.schema, {
        type: "object",
        properties: {
          name: { type: "string" },
          items: {
            type: "array",
            items: [
              { type: "string" },
              { type: "number" }
            ],
            additionalItems: { type: "boolean" }
          },
          ref: {
            $ref: "#/definitions/MyType"
          }
        }
      })
      deepStrictEqual(backTo07.definitions, {
        MyType: {
          type: "string"
        }
      })
    })
  })
})
