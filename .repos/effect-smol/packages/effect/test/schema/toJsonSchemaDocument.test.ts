import type { Options as AjvOptions } from "ajv"
import { Effect, JsonSchema, Option, Predicate, Schema, SchemaGetter } from "effect"
// import { FastCheck } from "effect/testing"
import { describe, it } from "vitest"
import { assertTrue, deepStrictEqual, throws } from "../utils/assert.ts"

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const Ajv2020 = require("ajv/dist/2020")

const baseAjvOptions: AjvOptions = {
  allErrors: true,
  strict: false, // warns/throws on unknown keywords depending on Ajv version
  validateSchema: true,
  code: { esm: true } // optional
}

const ajvDraft2020_12 = new Ajv2020.default(baseAjvOptions)

function assertUnsupportedSchema(
  schema: Schema.Top,
  message: string,
  options?: Schema.ToJsonSchemaOptions
) {
  throws(() => Schema.toJsonSchemaDocument(schema, options), message)
}

function assertJsonSchemaDocument<T, E, RD>(
  schema: Schema.Codec<T, E, RD, never>,
  expected: { schema: JsonSchema.JsonSchema; definitions?: JsonSchema.Definitions },
  options?: Schema.ToJsonSchemaOptions
) {
  const document = Schema.toJsonSchemaDocument(schema, options)
  deepStrictEqual(document, {
    dialect: "draft-2020-12",
    schema: expected.schema,
    definitions: expected.definitions ?? {}
  })
  const jsonSchema = {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...document.schema,
    $defs: document.definitions
  }
  const valid = ajvDraft2020_12.validateSchema(jsonSchema)
  assertTrue(valid)
  // const validate = ajvDraft2020_12.compile(jsonSchema)
  // const arb = Schema.toArbitrary(schema)
  // const codec = Schema.toCodecJson(schema)
  // const encode = Schema.encodeSync(codec)
  // FastCheck.assert(FastCheck.property(arb, (t) => {
  //   const e = encode(t)
  //   return validate(e)
  // }))
}

describe("toJsonSchemaDocument", () => {
  describe("Unsupported schemas", () => {
    it("Tuple: unsupported post-rest elements", () => {
      assertUnsupportedSchema(
        Schema.TupleWithRest(Schema.Tuple([]), [Schema.Finite, Schema.String]),
        "Generating a JSON Schema for post-rest elements is not supported"
      )
    })

    it("Struct: unsupported property signature name", () => {
      const a = Symbol.for("effect/Schema/test/a")
      assertUnsupportedSchema(
        Schema.Struct({ [a]: Schema.String }),
        `Unsupported property signature name: Symbol(effect/Schema/test/a)`
      )
    })

    it("Record: unsupported index signature parameter", () => {
      assertUnsupportedSchema(
        Schema.Record(Schema.Symbol, Schema.Finite),
        `Unsupported index signature parameter: Symbol`
      )
    })
  })

  describe("options", () => {
    it("generateDescriptions: true", () => {
      assertJsonSchemaDocument(
        Schema.String.annotate({ expected: "b" }),
        {
          schema: {
            "type": "string",
            "description": "b"
          }
        },
        { generateDescriptions: true }
      )
      assertJsonSchemaDocument(
        Schema.String.annotate({ description: "a", expected: "b" }),
        {
          schema: {
            "type": "string",
            "description": "a"
          }
        },
        { generateDescriptions: true }
      )
    })

    describe("additionalProperties", () => {
      it(`false (default)`, () => {
        const schema = Schema.Struct({ a: Schema.String })

        assertJsonSchemaDocument(schema, {
          schema: {
            "type": "object",
            "properties": {
              "a": {
                "type": "string"
              }
            },
            "required": ["a"],
            "additionalProperties": false
          }
        }, {
          additionalProperties: false
        })
      })

      it(`true`, () => {
        const schema = Schema.Struct({ a: Schema.String })

        assertJsonSchemaDocument(schema, {
          schema: {
            "type": "object",
            "properties": {
              "a": {
                "type": "string"
              }
            },
            "required": ["a"],
            "additionalProperties": true
          }
        }, {
          additionalProperties: true
        })
      })

      it(`schema`, () => {
        const schema = Schema.Struct({ a: Schema.String })

        assertJsonSchemaDocument(schema, {
          schema: {
            "type": "object",
            "properties": {
              "a": {
                "type": "string"
              }
            },
            "required": ["a"],
            "additionalProperties": {
              "type": "string"
            }
          }
        }, {
          additionalProperties: { "type": "string" }
        })
      })
    })

    describe("includeAnnotationKey", () => {
      it("passthroughs matching annotation keys at schema level", () => {
        assertJsonSchemaDocument(
          Schema.String.annotate({
            title: "Name",
            description: "A name",
            "markdownDescription": "The **name** field"
          }),
          {
            schema: {
              "type": "string",
              "title": "Name",
              "description": "A name",
              "markdownDescription": "The **name** field"
            }
          },
          { includeAnnotationKey: (key) => key === "markdownDescription" }
        )
      })

      it("does not include keys not matching the predicate", () => {
        assertJsonSchemaDocument(
          Schema.String.annotate({
            title: "Name",
            description: "A name",
            "markdownDescription": "The **name** field",
            "customKey": "value"
          }),
          {
            schema: {
              "type": "string",
              "title": "Name",
              "description": "A name",
              "markdownDescription": "The **name** field"
            }
          },
          { includeAnnotationKey: (key) => key === "markdownDescription" }
        )
      })

      it("does not include matching keys with undefined values", () => {
        assertJsonSchemaDocument(
          Schema.String.annotate({
            "x-missing": undefined,
            "x-value": "value"
          }),
          {
            schema: {
              "type": "string",
              "x-value": "value"
            }
          },
          { includeAnnotationKey: (key) => key.startsWith("x-") }
        )
      })

      it("standard keys are always included regardless of predicate", () => {
        assertJsonSchemaDocument(
          Schema.String.annotate({
            title: "Name",
            description: "A name",
            default: "hello"
          }),
          {
            schema: {
              "type": "string",
              "title": "Name",
              "description": "A name",
              "default": "hello"
            }
          },
          { includeAnnotationKey: (_key) => false }
        )
      })

      it("does not overwrite generated contentSchema with the raw annotation", () => {
        assertJsonSchemaDocument(
          Schema.fromJsonString(Schema.Struct({
            a: Schema.String
          })),
          {
            schema: {
              "type": "string",
              "contentMediaType": "application/json",
              "contentSchema": {
                "type": "object",
                "properties": {
                  "a": {
                    "type": "string"
                  }
                },
                "required": ["a"],
                "additionalProperties": false
              }
            }
          },
          { includeAnnotationKey: (key) => key === "contentSchema" }
        )
      })

      it("passthroughs at property level in structs", () => {
        const schema = Schema.Struct({
          name: Schema.String.annotate({
            description: "A name",
            "markdownDescription": "The **name** field"
          }),
          tag: Schema.String.annotate({
            description: "A tag",
            "defaultSnippets": [{ label: "v1", body: "v1" }]
          })
        })
        assertJsonSchemaDocument(
          schema,
          {
            schema: {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "A name",
                  "markdownDescription": "The **name** field"
                },
                "tag": {
                  "type": "string",
                  "description": "A tag",
                  "defaultSnippets": [{ label: "v1", body: "v1" }]
                }
              },
              "required": ["name", "tag"],
              "additionalProperties": false
            }
          },
          { includeAnnotationKey: (key) => key === "markdownDescription" || key === "defaultSnippets" }
        )
      })

      it("passthroughs at check level", () => {
        const schema = Schema.String
          .annotate({ description: "A string" })
          .pipe(
            Schema.check(
              Schema.isMinLength(1, {
                "x-check-annotation": true
              })
            )
          )
        assertJsonSchemaDocument(
          schema,
          {
            schema: {
              "type": "string",
              "description": "A string",
              "allOf": [{
                "minLength": 1,
                "x-check-annotation": true
              }]
            }
          },
          { includeAnnotationKey: (key) => key.startsWith("x-") }
        )
      })

      it("passthroughs x- prefixed vendor extensions", () => {
        assertJsonSchemaDocument(
          Schema.String.annotate({
            description: "A value",
            "x-custom": true,
            "x-extension": { foo: "bar" }
          }),
          {
            schema: {
              "type": "string",
              "description": "A value",
              "x-custom": true,
              "x-extension": { foo: "bar" }
            }
          },
          { includeAnnotationKey: (key) => key.startsWith("x-") }
        )
      })
    })
  })

  it("should support JSON Schema annotations", () => {
    const schema = Schema.String.annotate({
      title: "a",
      description: "b",
      default: "c",
      examples: ["d"],
      readOnly: true,
      writeOnly: true
    })
    assertJsonSchemaDocument(schema, {
      schema: {
        "type": "string",
        "title": "a",
        "description": "b",
        "default": "c",
        "examples": ["d"],
        "readOnly": true,
        "writeOnly": true
      }
    })
  })

  describe("identifier handling", () => {
    it(`refs should escape "~" and "/"`, () => {
      const S = Schema.String.annotate({ identifier: "id~a/b" })
      assertJsonSchemaDocument(
        S,
        {
          schema: { "$ref": "#/$defs/id~0a~1b" },
          definitions: {
            "id~a/b": { "type": "string" }
          }
        }
      )
    })

    it("using the same identifier annotated schema twice", () => {
      const S = Schema.String.annotate({ identifier: "id" })
      assertJsonSchemaDocument(
        Schema.Union([S, S]),
        {
          schema: {
            "anyOf": [
              { "$ref": "#/$defs/id" },
              { "$ref": "#/$defs/id" }
            ]
          },
          definitions: {
            id: { "type": "string" }
          }
        }
      )
    })

    it("should handle duplicate identifiers on different schemas with different representations", () => {
      const S = Schema.Union([
        Schema.String.annotate({ identifier: "id", description: "a" }),
        Schema.String.annotate({ identifier: "id", description: "b" })
      ])
      assertJsonSchemaDocument(S, {
        schema: {
          "anyOf": [
            { "$ref": "#/$defs/id" },
            { "$ref": "#/$defs/id1" }
          ]
        },
        definitions: {
          id: { "type": "string", "description": "a" },
          id1: { "type": "string", "description": "b" }
        }
      })
    })

    it("should handle duplicate identifiers on different schemas with the same representation", () => {
      const X = Schema.String.annotate({ title: "X", identifier: "X" })
      const S = Schema.Struct({
        a: X,
        b: Schema.NullOr(X),
        c: Schema.optionalKey(X),
        d: Schema.optionalKey(Schema.NullOr(X)),
        e: Schema.NullOr(X).pipe(
          Schema.encodeTo(Schema.optionalKey(X), {
            decode: SchemaGetter.transformOptional(Option.orElseSome(() => null)),
            encode: SchemaGetter.transformOptional(Option.filter(Predicate.isNotNull))
          })
        )
      })
      assertJsonSchemaDocument(S, {
        schema: {
          "type": "object",
          "properties": {
            "a": {
              "$ref": "#/$defs/X"
            },
            "b": {
              "anyOf": [
                {
                  "$ref": "#/$defs/X"
                },
                {
                  "type": "null"
                }
              ]
            },
            "c": {
              "$ref": "#/$defs/X"
            },
            "d": {
              "anyOf": [
                {
                  "$ref": "#/$defs/X"
                },
                {
                  "type": "null"
                }
              ]
            },
            "e": {
              "$ref": "#/$defs/X"
            }
          },
          "required": [
            "a",
            "b"
          ],
          "additionalProperties": false
        },
        definitions: {
          "X": {
            "type": "string",
            "title": "X"
          }
        }
      })
    })
  })

  describe("Declaration", () => {
    it("Date", () => {
      const schema = Schema.Date
      assertJsonSchemaDocument(schema, {
        schema: {
          "type": "string"
        }
      })
    })

    it("DateValid", () => {
      const schema = Schema.DateValid
      assertJsonSchemaDocument(schema, {
        schema: {
          "type": "string",
          "allOf": [
            { "format": "date-time" }
          ]
        }
      })
    })

    it("URL", () => {
      const schema = Schema.URL
      assertJsonSchemaDocument(schema, {
        schema: {
          "type": "string"
        }
      })
    })

    it("Error", () => {
      const schema = Schema.Error
      assertJsonSchemaDocument(schema, {
        schema: {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "message": { "type": "string" },
            "stack": { "type": "string" }
          },
          "required": ["message"],
          "additionalProperties": false
        }
      })
    })

    it("RegExp", () => {
      const schema = Schema.RegExp
      assertJsonSchemaDocument(schema, {
        schema: {
          "type": "object",
          "properties": {
            "source": { "type": "string" },
            "flags": { "type": "string" }
          },
          "required": ["source", "flags"],
          "additionalProperties": false
        }
      })
    })

    it("Uint8Array", () => {
      const schema = Schema.Uint8Array
      assertJsonSchemaDocument(schema, {
        schema: {
          "type": "string",
          "format": "byte",
          "contentEncoding": "base64"
        }
      })
    })

    it("Duration", () => {
      const schema = Schema.Duration
      assertJsonSchemaDocument(schema, {
        schema: {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "_tag": {
                  "type": "string",
                  "enum": ["Infinity"]
                }
              },
              "required": ["_tag"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "_tag": {
                  "type": "string",
                  "enum": ["NegativeInfinity"]
                }
              },
              "required": ["_tag"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "_tag": {
                  "type": "string",
                  "enum": ["Nanos"]
                },
                "value": {
                  "type": "string",
                  "allOf": [
                    { "pattern": "^-?\\d+$" }
                  ]
                }
              },
              "required": ["_tag", "value"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "_tag": {
                  "type": "string",
                  "enum": ["Millis"]
                },
                "value": {
                  "type": "integer"
                }
              },
              "required": ["_tag", "value"],
              "additionalProperties": false
            }
          ]
        }
      })
    })

    it("Option(String)", () => {
      const schema = Schema.Option(Schema.String)
      assertJsonSchemaDocument(schema, {
        schema: {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "_tag": {
                  "type": "string",
                  "enum": ["Some"]
                },
                "value": {
                  "type": "string"
                }
              },
              "required": ["_tag", "value"],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "_tag": {
                  "type": "string",
                  "enum": ["None"]
                }
              },
              "required": ["_tag"],
              "additionalProperties": false
            }
          ]
        }
      })
    })
  })

  it("Any", () => {
    const schema = Schema.Any
    assertJsonSchemaDocument(
      schema,
      {
        schema: {}
      }
    )
    assertJsonSchemaDocument(
      schema.annotate({ description: "a" }),
      {
        schema: {
          "description": "a"
        }
      }
    )
  })

  it("Json", () => {
    const schema = Schema.Json
    assertJsonSchemaDocument(
      schema,
      {
        schema: {}
      }
    )
  })

  it("MutableJson", () => {
    const schema = Schema.MutableJson
    assertJsonSchemaDocument(
      schema,
      {
        schema: {}
      }
    )
  })

  it("Unknown", () => {
    const schema = Schema.Unknown
    assertJsonSchemaDocument(
      schema,
      {
        schema: {}
      }
    )
    assertJsonSchemaDocument(
      schema.annotate({ description: "a" }),
      {
        schema: {
          "description": "a"
        }
      }
    )
  })

  it("Void", () => {
    const schema = Schema.Void
    assertJsonSchemaDocument(
      schema,
      {
        schema: {
          "type": "null"
        }
      }
    )
    assertJsonSchemaDocument(
      schema.annotate({ description: "a" }),
      {
        schema: {
          "type": "null",
          "description": "a"
        }
      }
    )
  })

  it("Undefined", () => {
    const schema = Schema.Undefined
    assertJsonSchemaDocument(
      schema,
      {
        schema: {
          "type": "null"
        }
      }
    )
    assertJsonSchemaDocument(
      schema.annotate({ description: "a" }),
      {
        schema: {
          "type": "null",
          "description": "a"
        }
      }
    )
  })

  it("BigInt", () => {
    const schema = Schema.BigInt
    assertJsonSchemaDocument(
      schema,
      {
        schema: {
          "type": "string",
          "allOf": [
            { "pattern": "^-?\\d+$" }
          ]
        }
      }
    )
  })

  it("Symbol", () => {
    const schema = Schema.Symbol
    assertJsonSchemaDocument(
      schema,
      {
        schema: {
          "type": "string",
          "allOf": [
            { "pattern": "^Symbol\\((.*)\\)$" }
          ]
        }
      }
    )
  })

  it("UniqueSymbol", () => {
    const schema = Schema.UniqueSymbol(Symbol.for("a"))
    assertJsonSchemaDocument(
      schema,
      {
        schema: {
          "type": "string",
          "allOf": [
            { "pattern": "^Symbol\\((.*)\\)$" }
          ]
        }
      }
    )
  })

  it("Never", () => {
    const schema = Schema.Never
    assertJsonSchemaDocument(
      schema,
      {
        schema: {
          "not": {}
        }
      }
    )
    assertJsonSchemaDocument(
      schema.annotate({ description: "a" }),
      {
        schema: {
          "description": "a",
          "not": {}
        }
      }
    )
  })

  it("Null", () => {
    const schema = Schema.Null
    assertJsonSchemaDocument(
      schema,
      {
        schema: {
          "type": "null"
        }
      }
    )
    assertJsonSchemaDocument(
      schema.annotate({ description: "a" }),
      {
        schema: {
          "type": "null",
          "description": "a"
        }
      }
    )
  })

  describe("String", () => {
    it("String", () => {
      assertJsonSchemaDocument(
        Schema.String,
        {
          schema: {
            "type": "string"
          }
        }
      )
    })

    it("String & annotate", () => {
      assertJsonSchemaDocument(
        Schema.String.annotate({ description: "a" }),
        {
          schema: {
            "type": "string",
            "description": "a"
          }
        }
      )
    })

    it("should ignore annotateKey annotations if the schema is not contextual", () => {
      assertJsonSchemaDocument(
        Schema.String.annotateKey({
          description: "a"
        }),
        {
          schema: {
            "type": "string"
          }
        }
      )
    })

    it("String & check", () => {
      assertJsonSchemaDocument(
        Schema.String.check(Schema.isMinLength(2)),
        {
          schema: {
            "type": "string",
            "allOf": [
              { "minLength": 2 }
            ]
          }
        }
      )
    })

    it("String & custom check without annotation", () => {
      assertJsonSchemaDocument(
        Schema.String.check(Schema.makeFilter(() => true)),
        {
          schema: {
            "type": "string"
          }
        }
      )
    })

    it("String & annotate & check", () => {
      assertJsonSchemaDocument(
        Schema.String.annotate({ description: "a" }).check(Schema.isMinLength(2)),
        {
          schema: {
            "type": "string",
            "description": "a",
            "allOf": [
              { "minLength": 2 }
            ]
          }
        }
      )
    })

    it("String & check & annotate", () => {
      assertJsonSchemaDocument(
        Schema.String.check(Schema.isMinLength(2)).annotate({
          description: "a"
        }),
        {
          schema: {
            "type": "string",
            "allOf": [
              { "minLength": 2, "description": "a" }
            ]
          }
        }
      )
    })

    it("String & check & check", () => {
      assertJsonSchemaDocument(
        Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(3)),
        {
          schema: {
            "type": "string",
            "allOf": [
              { "minLength": 2 },
              { "maxLength": 3 }
            ]
          }
        }
      )
    })

    it("String & annotate & check & check", () => {
      assertJsonSchemaDocument(
        Schema.String.annotate({ description: "a" }).check(Schema.isMinLength(2), Schema.isMaxLength(3)),
        {
          schema: {
            "type": "string",
            "description": "a",
            "allOf": [
              { "minLength": 2 },
              { "maxLength": 3 }
            ]
          }
        }
      )
    })

    it("String & check & check & annotate", () => {
      assertJsonSchemaDocument(
        Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(3)).annotate({
          description: "a"
        }),
        {
          schema: {
            "type": "string",
            "allOf": [
              {
                "minLength": 2
              },
              {
                "maxLength": 3,
                "description": "a"
              }
            ]
          }
        }
      )
    })

    it("String & annotate & check & check & annotate", () => {
      assertJsonSchemaDocument(
        Schema.String.annotate({ description: "a" }).check(
          Schema.isMinLength(2),
          Schema.isMaxLength(3, { description: "c" })
        ),
        {
          schema: {
            "type": "string",
            "description": "a",
            "allOf": [
              {
                "minLength": 2
              },
              {
                "maxLength": 3,
                "description": "c"
              }
            ]
          }
        }
      )
    })

    it("String & check & annotations & check & annotations", () => {
      assertJsonSchemaDocument(
        Schema.String.check(
          Schema.isMinLength(2, { description: "b" }),
          Schema.isMaxLength(3, { description: "c" })
        ),
        {
          schema: {
            "type": "string",
            "allOf": [
              {
                "minLength": 2,
                "description": "b"
              },
              {
                "maxLength": 3,
                "description": "c"
              }
            ]
          }
        }
      )
    })

    it("String & annotations & check & annotations & check & annotations", () => {
      assertJsonSchemaDocument(
        Schema.String.annotate({ description: "a" }).check(
          Schema.isMinLength(2, { description: "b" }),
          Schema.isMaxLength(3, { description: "c" })
        ),
        {
          schema: {
            "type": "string",
            "description": "a",
            "allOf": [
              {
                "minLength": 2,
                "description": "b"
              },
              {
                "maxLength": 3,
                "description": "c"
              }
            ]
          }
        }
      )
    })

    describe("checks", () => {
      it("isPattern", () => {
        assertJsonSchemaDocument(Schema.String.check(Schema.isPattern(/^abb+$/)), {
          schema: {
            "type": "string",
            "allOf": [
              { "pattern": "^abb+$" }
            ]
          }
        })
      })

      it("isTrimmed", () => {
        const schema = Schema.Trimmed
        assertJsonSchemaDocument(schema, {
          schema: {
            "type": "string",
            "allOf": [
              { "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$" }
            ]
          }
        })
      })

      it("isLowercased", () => {
        const schema = Schema.String.check(Schema.isLowercased())
        assertJsonSchemaDocument(schema, {
          schema: {
            "type": "string",
            "allOf": [
              { "pattern": "^[^A-Z]*$" }
            ]
          }
        })
      })

      it("isUppercased", () => {
        const schema = Schema.String.check(Schema.isUppercased())
        assertJsonSchemaDocument(schema, {
          schema: {
            "type": "string",
            "allOf": [
              { "pattern": "^[^a-z]*$" }
            ]
          }
        })
      })

      it("isCapitalized", () => {
        const schema = Schema.String.check(Schema.isCapitalized())
        assertJsonSchemaDocument(schema, {
          schema: {
            "type": "string",
            "allOf": [
              { "pattern": "^[^a-z]?.*$" }
            ]
          }
        })
      })

      it("isUncapitalized", () => {
        const schema = Schema.String.check(Schema.isUncapitalized())
        assertJsonSchemaDocument(schema, {
          schema: {
            "type": "string",
            "allOf": [
              { "pattern": "^[^A-Z]?.*$" }
            ]
          }
        })
      })

      describe("isLengthBetween", () => {
        it("String", () => {
          assertJsonSchemaDocument(
            Schema.String.check(Schema.isLengthBetween(2, 2)),
            {
              schema: {
                "type": "string",
                "allOf": [
                  { "minLength": 2 },
                  { "maxLength": 2 }
                ]
              }
            }
          )
        })

        it("Array", () => {
          assertJsonSchemaDocument(
            Schema.Array(Schema.String).check(Schema.isLengthBetween(2, 2)),
            {
              schema: {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "allOf": [
                  { "minItems": 2 },
                  { "maxItems": 2 }
                ]
              }
            }
          )
        })

        it("NonEmptyArray", () => {
          assertJsonSchemaDocument(
            Schema.NonEmptyArray(Schema.String).check(Schema.isLengthBetween(2, 2)),
            {
              schema: {
                "type": "array",
                "prefixItems": [{
                  "type": "string"
                }],
                "items": {
                  "type": "string"
                },
                "minItems": 1,
                "allOf": [
                  { "minItems": 2 },
                  { "maxItems": 2 }
                ]
              }
            }
          )
        })
      })

      describe("isMinLength", () => {
        it("String", () => {
          assertJsonSchemaDocument(
            Schema.String.check(Schema.isMinLength(2)),
            {
              schema: {
                "type": "string",
                "allOf": [
                  { "minLength": 2 }
                ]
              }
            }
          )
        })

        it("Array", () => {
          assertJsonSchemaDocument(
            Schema.Array(Schema.String).check(Schema.isMinLength(2)),
            {
              schema: {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "allOf": [
                  { "minItems": 2 }
                ]
              }
            }
          )
        })

        it("NonEmptyArray", () => {
          assertJsonSchemaDocument(
            Schema.NonEmptyArray(Schema.String).check(Schema.isMinLength(2)),
            {
              schema: {
                "type": "array",
                "prefixItems": [{
                  "type": "string"
                }],
                "items": {
                  "type": "string"
                },
                "minItems": 1,
                "allOf": [
                  { "minItems": 2 }
                ]
              }
            }
          )
        })
      })

      describe("isMaxLength", () => {
        it("String", () => {
          assertJsonSchemaDocument(
            Schema.String.check(Schema.isMaxLength(2)),
            {
              schema: {
                "type": "string",
                "allOf": [
                  { "maxLength": 2 }
                ]
              }
            }
          )
        })

        it("Array", () => {
          assertJsonSchemaDocument(
            Schema.Array(Schema.String).check(Schema.isMaxLength(2)),
            {
              schema: {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "allOf": [
                  { "maxItems": 2 }
                ]
              }
            }
          )
        })

        it("NonEmptyArray", () => {
          assertJsonSchemaDocument(
            Schema.NonEmptyArray(Schema.String).check(Schema.isMaxLength(2)),
            {
              schema: {
                "type": "array",
                "minItems": 1,
                "prefixItems": [{
                  "type": "string"
                }],
                "items": {
                  "type": "string"
                },
                "allOf": [
                  { "maxItems": 2 }
                ]
              }
            }
          )
        })
      })

      it("isUUID", () => {
        assertJsonSchemaDocument(
          Schema.String.annotate({ description: "description" }).check(Schema.isUUID()),
          {
            schema: {
              "type": "string",
              "description": "description",
              "allOf": [
                {
                  "format": "uuid",
                  "pattern":
                    "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$"
                }
              ]
            }
          }
        )
      })

      it("isBase64", () => {
        assertJsonSchemaDocument(
          Schema.String.annotate({ description: "description" }).check(Schema.isBase64()),
          {
            schema: {
              "type": "string",
              "description": "description",
              "allOf": [
                { "pattern": "^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$" }
              ]
            }
          }
        )
      })

      it("isBase64Url", () => {
        assertJsonSchemaDocument(
          Schema.String.annotate({ description: "description" }).check(Schema.isBase64Url()),
          {
            schema: {
              "type": "string",
              "description": "description",
              "allOf": [
                { "pattern": "^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$" }
              ]
            }
          }
        )
      })
    })
  })

  describe("Number", () => {
    it("Number", () => {
      const schema = Schema.Number
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "anyOf": [
              { "type": "number" },
              { "type": "string", "enum": ["NaN"] },
              { "type": "string", "enum": ["Infinity"] },
              { "type": "string", "enum": ["-Infinity"] }
            ]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "anyOf": [
              { "type": "number" },
              { "type": "string", "enum": ["NaN"] },
              { "type": "string", "enum": ["Infinity"] },
              { "type": "string", "enum": ["-Infinity"] }
            ],
            "description": "a"
          }
        }
      )
    })
  })

  describe("Finite", () => {
    it("Finite", () => {
      assertJsonSchemaDocument(
        Schema.Finite,
        {
          schema: {
            "type": "number"
          }
        }
      )
      assertJsonSchemaDocument(
        Schema.Finite.annotate({ description: "a" }),
        {
          schema: {
            "type": "number",
            "allOf": [{
              "description": "a"
            }]
          }
        }
      )
    })

    describe("checks", () => {
      it("isInt", () => {
        assertJsonSchemaDocument(
          Schema.Finite.check(Schema.isInt()),
          {
            schema: {
              "type": "integer"
            }
          }
        )
      })

      it("isInt32", () => {
        assertJsonSchemaDocument(
          Schema.Finite.check(Schema.isInt32()),
          {
            schema: {
              "type": "integer",
              "allOf": [
                { "maximum": 2147483647, "minimum": -2147483648 }
              ]
            }
          }
        )
      })

      it("isUint32", () => {
        assertJsonSchemaDocument(
          Schema.Finite.check(Schema.isUint32()),
          {
            schema: {
              "type": "integer",
              "allOf": [
                { "maximum": 4294967295, "minimum": 0 }
              ]
            }
          }
        )
        assertJsonSchemaDocument(
          Schema.Finite.check(Schema.isUint32({ description: "a" })),
          {
            schema: {
              "type": "integer",
              "allOf": [
                {
                  "description": "a",
                  "allOf": [
                    { "maximum": 4294967295, "minimum": 0 }
                  ]
                }
              ]
            }
          }
        )
        assertJsonSchemaDocument(
          Schema.Finite.check(
            Schema.isUint32({ description: "a" })
          ),
          {
            schema: {
              "type": "integer",
              "allOf": [
                {
                  "description": "a",
                  "allOf": [
                    { "maximum": 4294967295, "minimum": 0 }
                  ]
                }
              ]
            }
          }
        )
      })

      it("isGreaterThan", () => {
        assertJsonSchemaDocument(
          Schema.Finite.check(Schema.isGreaterThan(1)),
          {
            schema: {
              "type": "number",
              "allOf": [
                { "exclusiveMinimum": 1 }
              ]
            }
          }
        )
      })

      it("isGreaterThanOrEqualTo", () => {
        assertJsonSchemaDocument(
          Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)),
          {
            schema: {
              "type": "number",
              "allOf": [
                { "minimum": 1 }
              ]
            }
          }
        )
      })

      it("isLessThan", () => {
        assertJsonSchemaDocument(Schema.Finite.check(Schema.isLessThan(1)), {
          schema: {
            "type": "number",
            "allOf": [
              { "exclusiveMaximum": 1 }
            ]
          }
        })
      })

      it("isLessThanOrEqualTo", () => {
        assertJsonSchemaDocument(Schema.Finite.check(Schema.isLessThanOrEqualTo(1)), {
          schema: {
            "type": "number",
            "allOf": [
              { "maximum": 1 }
            ]
          }
        })
      })

      it("isBetween", () => {
        assertJsonSchemaDocument(
          Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
          {
            schema: {
              "type": "number",
              "allOf": [
                { "minimum": 1, "maximum": 10 }
              ]
            }
          }
        )
        assertJsonSchemaDocument(
          Schema.Finite.check(
            Schema.isBetween({ minimum: 1, maximum: 10, exclusiveMinimum: true })
          ),
          {
            schema: {
              "type": "number",
              "allOf": [
                { "exclusiveMinimum": 1, "maximum": 10 }
              ]
            }
          }
        )
        assertJsonSchemaDocument(
          Schema.Finite.check(
            Schema.isBetween({ minimum: 1, maximum: 10, exclusiveMaximum: true })
          ),
          {
            schema: {
              "type": "number",
              "allOf": [
                { "minimum": 1, "exclusiveMaximum": 10 }
              ]
            }
          }
        )
        assertJsonSchemaDocument(
          Schema.Finite.check(
            Schema.isBetween({ minimum: 1, maximum: 10, exclusiveMinimum: true, exclusiveMaximum: true })
          ),
          {
            schema: {
              "type": "number",
              "allOf": [
                { "exclusiveMinimum": 1, "exclusiveMaximum": 10 }
              ]
            }
          }
        )
      })

      it("isMultipleOf", () => {
        assertJsonSchemaDocument(
          Schema.Int.check(Schema.isMultipleOf(2)),
          {
            schema: {
              "type": "integer",
              "allOf": [
                { "multipleOf": 2 }
              ]
            }
          }
        )
      })
    })
  })

  it("Boolean", () => {
    const schema = Schema.Boolean
    assertJsonSchemaDocument(
      schema,
      {
        schema: {
          "type": "boolean"
        }
      }
    )
    assertJsonSchemaDocument(
      schema.annotate({ description: "a" }),
      {
        schema: {
          "type": "boolean",
          "description": "a"
        }
      }
    )
  })

  it("ObjectKeyword", () => {
    const schema = Schema.ObjectKeyword
    assertJsonSchemaDocument(
      schema,
      {
        schema: {}
      }
    )
    assertJsonSchemaDocument(
      schema.annotate({ description: "a" }),
      {
        schema: {
          "description": "a"
        }
      }
    )
  })

  describe("Literal", () => {
    it("string", () => {
      const schema = Schema.Literal("a")
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "string",
            "enum": ["a"]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "type": "string",
            "enum": ["a"],
            "description": "a"
          }
        }
      )
    })

    it("number", () => {
      const schema = Schema.Literal(1)
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "number",
            "enum": [1]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "type": "number",
            "enum": [1],
            "description": "a"
          }
        }
      )
    })

    it("boolean", () => {
      const schema = Schema.Literal(true)
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "boolean",
            "enum": [true]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "type": "boolean",
            "enum": [true],
            "description": "a"
          }
        }
      )
    })

    it("bigint", () => {
      const schema = Schema.Literal(1n)
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "string",
            "enum": ["1"]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "type": "string",
            "enum": ["1"],
            "description": "a"
          }
        }
      )
    })
  })

  describe("Literals", () => {
    it("empty literals", () => {
      const schema = Schema.Literals([])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "not": {}
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "not": {},
            "description": "a"
          }
        }
      )
    })

    it("strings", () => {
      const schema = Schema.Literals(["a", "b"])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "string",
            "enum": ["a", "b"]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "type": "string",
            "enum": ["a", "b"],
            "description": "a"
          }
        }
      )
    })

    it("numbers", () => {
      const schema = Schema.Literals([1, 2])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "number",
            "enum": [1, 2]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "type": "number",
            "enum": [1, 2],
            "description": "a"
          }
        }
      )
    })

    it("booleans", () => {
      const schema = Schema.Literals([true, false])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "boolean",
            "enum": [true, false]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "type": "boolean",
            "enum": [true, false],
            "description": "a"
          }
        }
      )
    })

    it("strings & numbers", () => {
      const schema = Schema.Literals(["a", 1])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "anyOf": [
              {
                "type": "string",
                "enum": ["a"]
              },
              {
                "type": "number",
                "enum": [1]
              }
            ]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "anyOf": [
              {
                "type": "string",
                "enum": ["a"]
              },
              {
                "type": "number",
                "enum": [1]
              }
            ],
            "description": "a"
          }
        }
      )
    })
  })

  describe("Union of literals", () => {
    it("strings", () => {
      const schema = Schema.Union([
        Schema.Literal("a"),
        Schema.Literal("b")
      ])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "string",
            "enum": ["a", "b"]
          }
        }
      )
      const jsonAnnotations = {
        "title": "title",
        "description": "description",
        "default": "a" as const,
        "examples": ["a", "b"] as const
      }
      assertJsonSchemaDocument(
        schema.annotate({ ...jsonAnnotations }),
        {
          schema: {
            "type": "string",
            "enum": ["a", "b"],
            ...jsonAnnotations
          }
        }
      )
    })

    it("nested literals", () => {
      const schema = Schema.Union([
        Schema.Literal("a"),
        Schema.Literals(["b", "c"])
      ])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "string",
            "enum": ["a", "b", "c"]
          }
        }
      )
    })

    it("strings & inner annotate", () => {
      const schema = Schema.Union([
        Schema.Literal("a"),
        Schema.Literal("b").annotate({ description: "b-description" })
      ])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "anyOf": [
              {
                "type": "string",
                "enum": ["a"]
              },
              {
                "type": "string",
                "enum": ["b"],
                "description": "b-description"
              }
            ]
          }
        }
      )
      const jsonAnnotations = {
        "title": "title",
        "description": "description",
        "default": "a" as const,
        "examples": ["a", "b"] as const
      }
      assertJsonSchemaDocument(
        schema.annotate({ ...jsonAnnotations }),
        {
          schema: {
            "anyOf": [
              {
                "type": "string",
                "enum": ["a"]
              },
              {
                "type": "string",
                "enum": ["b"],
                "description": "b-description"
              }
            ],
            ...jsonAnnotations
          }
        }
      )
    })

    it("numbers", () => {
      const schema = Schema.Union([
        Schema.Literal(1),
        Schema.Literal(2)
      ])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "number",
            "enum": [1, 2]
          }
        }
      )
      const jsonAnnotations = {
        "title": "title",
        "description": "description",
        "default": 1 as const,
        "examples": [1, 2] as const
      }
      assertJsonSchemaDocument(
        schema.annotate({ ...jsonAnnotations }),
        {
          schema: {
            "type": "number",
            "enum": [1, 2],
            ...jsonAnnotations
          }
        }
      )
    })

    it("booleans", () => {
      const schema = Schema.Union([
        Schema.Literal(true),
        Schema.Literal(false)
      ])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "boolean",
            "enum": [true, false]
          }
        }
      )
      const jsonAnnotations = {
        "title": "title",
        "description": "description",
        "default": true as const,
        "examples": [true, false] as const
      }
      assertJsonSchemaDocument(
        schema.annotate({ ...jsonAnnotations }),
        {
          schema: {
            "type": "boolean",
            "enum": [true, false],
            ...jsonAnnotations
          }
        }
      )
    })

    it("strings & numbers", () => {
      const schema = Schema.Union([
        Schema.Literal("a"),
        Schema.Literal(1)
      ])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "anyOf": [
              {
                "type": "string",
                "enum": ["a"]
              },
              {
                "type": "number",
                "enum": [1]
              }
            ]
          }
        }
      )
      const jsonAnnotations = {
        "title": "title",
        "description": "description",
        "default": "a" as const,
        "examples": ["a", 1] as const
      }
      assertJsonSchemaDocument(
        schema.annotate({ ...jsonAnnotations }),
        {
          schema: {
            "anyOf": [
              {
                "type": "string",
                "enum": ["a"]
              },
              {
                "type": "number",
                "enum": [1]
              }
            ],
            ...jsonAnnotations
          }
        }
      )
    })
  })

  describe("Enum", () => {
    it("empty enum", () => {
      enum Empty {}
      const schema = Schema.Enum(Empty)
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "not": {}
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "not": {},
            "description": "a"
          }
        }
      )
    })

    it("single enum", () => {
      enum Fruits {
        Apple
      }
      const schema = Schema.Enum(Fruits)
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "anyOf": [
              {
                "type": "number",
                "enum": [0],
                "title": "Apple"
              }
            ]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "description": "a",
            "anyOf": [
              {
                "type": "number",
                "enum": [0],
                "title": "Apple"
              }
            ]
          }
        }
      )
    })

    it("mixed enums (number & string)", () => {
      enum Fruits {
        Apple,
        Banana,
        Orange = "orange"
      }
      const schema = Schema.Enum(Fruits)
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "anyOf": [
              {
                "type": "number",
                "enum": [0],
                "title": "Apple"
              },
              {
                "type": "number",
                "enum": [1],
                "title": "Banana"
              },
              {
                "type": "string",
                "enum": ["orange"],
                "title": "Orange"
              }
            ]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "anyOf": [
              {
                "type": "number",
                "enum": [0],
                "title": "Apple"
              },
              {
                "type": "number",
                "enum": [1],
                "title": "Banana"
              },
              {
                "type": "string",
                "enum": ["orange"],
                "title": "Orange"
              }
            ],
            "description": "a"
          }
        }
      )
    })

    it("const enum", () => {
      const Fruits = {
        Apple: "apple",
        Banana: "banana",
        Cantaloupe: 3
      } as const
      const schema = Schema.Enum(Fruits)
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "anyOf": [
              {
                "type": "string",
                "title": "Apple",
                "enum": ["apple"]
              },
              {
                "type": "string",
                "title": "Banana",
                "enum": ["banana"]
              },
              {
                "type": "number",
                "title": "Cantaloupe",
                "enum": [3]
              }
            ]
          }
        }
      )
    })
  })

  it("TemplateLiteral", () => {
    const schema = Schema.TemplateLiteral(["a", Schema.String])
    assertJsonSchemaDocument(schema, {
      schema: {
        "type": "string",
        "pattern": "^a[\\s\\S]*?$"
      }
    })
    assertJsonSchemaDocument(schema.annotate({ description: "a" }), {
      schema: {
        "type": "string",
        "pattern": "^a[\\s\\S]*?$",
        "description": "a"
      }
    })
  })

  describe("Struct", () => {
    it("empty struct", () => {
      const schema = Schema.Struct({})
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "anyOf": [
              { "type": "object" },
              { "type": "array" }
            ]
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "anyOf": [
              {
                "type": "object"
              },
              {
                "type": "array"
              }
            ],
            "description": "a"
          }
        }
      )
    })

    describe("required property", () => {
      it("String", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.String
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string"
                }
              },
              "required": ["a"],
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotate", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.String.annotate({ description: "a" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string",
                  "description": "a"
                }
              },
              "required": ["a"],
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.String.annotateKey({ description: "a-key" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string",
                  "allOf": [{
                    "description": "a-key"
                  }]
                }
              },
              "required": ["a"],
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotate & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.String.annotate({ description: "a" }).annotateKey({ description: "a-key" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string",
                  "description": "a",
                  "allOf": [{
                    "description": "a-key"
                  }]
                }
              },
              "required": ["a"],
              "additionalProperties": false
            }
          }
        )
      })
    })

    describe("optionalKey", () => {
      it("String", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.optionalKey(Schema.String)
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": { "type": "string" }
              },
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotate", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.optionalKey(Schema.String.annotate({ description: "a" })),
            b: Schema.optionalKey(Schema.String).annotate({ description: "b" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string",
                  "description": "a"
                },
                "b": {
                  "type": "string",
                  "description": "b"
                }
              },
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.optionalKey(Schema.String.annotateKey({ description: "a-key" })),
            b: Schema.optionalKey(Schema.String).annotateKey({ description: "b-key" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string",
                  "allOf": [{
                    "description": "a-key"
                  }]
                },
                "b": {
                  "type": "string",
                  "allOf": [{
                    "description": "b-key"
                  }]
                }
              },
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotate & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.optionalKey(Schema.String.annotate({ description: "a" }).annotateKey({ description: "a-key" })),
            b: Schema.optionalKey(Schema.String).annotate({ description: "b" }).annotateKey({ description: "b-key" }),
            c: Schema.optionalKey(Schema.String.annotate({ description: "a" }).annotateKey({ description: "a-key" }))
              .annotate({ description: "c-outer" }).annotateKey({ description: "c-outer-key" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string",
                  "description": "a",
                  "allOf": [{
                    "description": "a-key"
                  }]
                },
                "b": {
                  "type": "string",
                  "description": "b",
                  "allOf": [{
                    "description": "b-key"
                  }]
                },
                "c": {
                  "type": "string",
                  "description": "c-outer",
                  "allOf": [{
                    "description": "c-outer-key"
                  }]
                }
              },
              "additionalProperties": false
            }
          }
        )
      })

      it("optionalKey(String) to String", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.optionalKey(Schema.String).pipe(Schema.encodeTo(Schema.String, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.withDefault(Effect.succeed(""))
            }))
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string"
                }
              },
              "required": ["a"],
              "additionalProperties": false
            }
          }
        )
      })
    })

    describe("optional", () => {
      it("String", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.optional(Schema.String)
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "anyOf": [
                    { "type": "string" },
                    { "type": "null" }
                  ]
                }
              },
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotate", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.optional(Schema.String.annotate({ description: "a" })),
            b: Schema.optional(Schema.String).annotate({ description: "b" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "anyOf": [
                    { "type": "string", "description": "a" },
                    { "type": "null" }
                  ]
                },
                "b": {
                  "anyOf": [
                    { "type": "string" },
                    { "type": "null" }
                  ],
                  "description": "b"
                }
              },
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.optional(Schema.String).annotateKey({ description: "a-key" }),
            b: Schema.optional(Schema.String.annotate({ description: "b" })).annotateKey({ description: "b-key" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "anyOf": [
                    { "type": "string" },
                    { "type": "null" }
                  ],
                  "allOf": [{
                    "description": "a-key"
                  }]
                },
                "b": {
                  "anyOf": [
                    { "type": "string", "description": "b" },
                    { "type": "null" }
                  ],
                  "allOf": [{
                    "description": "b-key"
                  }]
                }
              },
              "additionalProperties": false
            }
          }
        )
      })

      it("optional(String) to String", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.optional(Schema.String).pipe(Schema.encodeTo(Schema.String, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.withDefault(Effect.succeed(""))
            }))
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string"
                }
              },
              "required": ["a"],
              "additionalProperties": false
            }
          }
        )
      })
    })

    describe("UndefinedOr", () => {
      it("String", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.UndefinedOr(Schema.String)
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "anyOf": [
                    { "type": "string" },
                    { "type": "null" }
                  ]
                }
              },
              "required": ["a"],
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotate", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.UndefinedOr(Schema.String.annotate({ description: "a" })),
            b: Schema.UndefinedOr(Schema.String).annotate({ description: "b" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "anyOf": [
                    { "type": "string", "description": "a" },
                    { "type": "null" }
                  ]
                },
                "b": {
                  "anyOf": [
                    { "type": "string" },
                    { "type": "null" }
                  ],
                  "description": "b"
                }
              },
              "required": ["a", "b"],
              "additionalProperties": false
            }
          }
        )
      })

      it("String & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.UndefinedOr(Schema.String).annotateKey({ description: "a-key" }),
            b: Schema.UndefinedOr(Schema.String.annotate({ description: "b" })).annotateKey({ description: "b-key" })
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "anyOf": [
                    { "type": "string" },
                    { "type": "null" }
                  ],
                  "allOf": [{
                    "description": "a-key"
                  }]
                },
                "b": {
                  "anyOf": [
                    { "type": "string", "description": "b" },
                    { "type": "null" }
                  ],
                  "allOf": [{
                    "description": "b-key"
                  }]
                }
              },
              "required": ["a", "b"],
              "additionalProperties": false
            }
          }
        )
      })

      it("UndefinedOr(String) to String", () => {
        assertJsonSchemaDocument(
          Schema.Struct({
            a: Schema.UndefinedOr(Schema.String).pipe(Schema.encodeTo(Schema.String, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transform((s) => s ?? "")
            }))
          }),
          {
            schema: {
              "type": "object",
              "properties": {
                "a": {
                  "type": "string"
                }
              },
              "required": ["a"],
              "additionalProperties": false
            }
          }
        )
      })
    })
  })

  describe("Record", () => {
    it("Record(String, Never)", () => {
      assertJsonSchemaDocument(
        Schema.Record(Schema.String, Schema.Never),
        {
          schema: {
            "type": "object",
            "additionalProperties": false
          }
        }
      )
      assertJsonSchemaDocument(
        Schema.Record(Schema.String, Schema.Never.annotate({ description: "a" })),
        {
          schema: {
            "type": "object",
            "additionalProperties": {
              "description": "a",
              "not": {}
            }
          }
        }
      )
    })

    it("Record(String, Finite)", () => {
      assertJsonSchemaDocument(
        Schema.Record(Schema.String, Schema.Finite),
        {
          schema: {
            "type": "object",
            "additionalProperties": {
              "type": "number"
            }
          }
        }
      )
      assertJsonSchemaDocument(
        Schema.Record(
          Schema.String.annotate({ description: "k" }), // TODO: where can we attach the description?
          Schema.Finite.annotate({ description: "v" })
        ).annotate({ description: "r" }),
        {
          schema: {
            "type": "object",
            "additionalProperties": {
              "type": "number",
              "allOf": [{
                "description": "v"
              }]
            },
            "description": "r"
          }
        }
      )
    })

    it("Record(String, Json)", () => {
      const schema = Schema.Record(Schema.String, Schema.Json)
      assertJsonSchemaDocument(
        schema,
        {
          schema: { "type": "object" }
        }
      )
    })

    it("Record(`a${string}`, Number) & annotate", () => {
      assertJsonSchemaDocument(
        Schema.Record(Schema.TemplateLiteral(["a", Schema.String]), Schema.Finite),
        {
          schema: {
            "type": "object",
            "patternProperties": {
              "^a[\\s\\S]*?$": {
                "type": "number"
              }
            }
          }
        }
      )
    })

    it("Record(Literals(['a', 'b']), Finite)", () => {
      assertJsonSchemaDocument(
        Schema.Record(Schema.Literals(["a", "b"]), Schema.Finite),
        {
          schema: {
            "type": "object",
            "properties": {
              "a": { "type": "number" },
              "b": { "type": "number" }
            },
            "required": ["a", "b"],
            "additionalProperties": false
          }
        }
      )
    })

    it("Record(isUppercased, Number)", () => {
      assertJsonSchemaDocument(
        Schema.Record(Schema.String.check(Schema.isUppercased()), Schema.Finite),
        {
          schema: {
            "type": "object",
            "patternProperties": {
              "^[^a-z]*$": {
                "type": "number"
              }
            }
          }
        }
      )
    })

    describe("checks", () => {
      it("isMinProperties", () => {
        assertJsonSchemaDocument(
          Schema.Record(Schema.String, Schema.Finite).check(Schema.isMinProperties(2)),
          {
            schema: {
              "type": "object",
              "additionalProperties": {
                "type": "number"
              },
              "allOf": [
                { "minProperties": 2 }
              ]
            }
          }
        )
      })

      it("isMaxProperties", () => {
        assertJsonSchemaDocument(
          Schema.Record(Schema.String, Schema.Finite).check(Schema.isMaxProperties(2)),
          {
            schema: {
              "type": "object",
              "additionalProperties": { "type": "number" },
              "allOf": [{ "maxProperties": 2 }]
            }
          }
        )
      })

      it("isPropertiesLengthBetween", () => {
        assertJsonSchemaDocument(
          Schema.Record(Schema.String, Schema.Finite).check(Schema.isPropertiesLengthBetween(2, 2)),
          {
            schema: {
              "type": "object",
              "additionalProperties": { "type": "number" },
              "allOf": [{ "minProperties": 2, "maxProperties": 2 }]
            }
          }
        )
      })
    })
  })

  it("StructWithRest", () => {
    assertJsonSchemaDocument(
      Schema.StructWithRest(Schema.Struct({ a: Schema.String }), [
        Schema.Record(Schema.String, Schema.Union([Schema.Finite, Schema.String]))
      ]),
      {
        schema: {
          "type": "object",
          "properties": {
            "a": { "type": "string" }
          },
          "additionalProperties": {
            "anyOf": [
              { "type": "number" },
              { "type": "string" }
            ]
          },
          "required": ["a"]
        }
      }
    )
  })

  describe("Tuple", () => {
    it("empty tuple", () => {
      const schema = Schema.Tuple([])
      assertJsonSchemaDocument(
        schema,
        {
          schema: {
            "type": "array",
            "items": false
          }
        }
      )
      assertJsonSchemaDocument(
        schema.annotate({ description: "a" }),
        {
          schema: {
            "type": "array",
            "items": false,
            "description": "a"
          }
        }
      )
    })

    describe("required element", () => {
      it("String", () => {
        assertJsonSchemaDocument(
          Schema.Tuple([
            Schema.String
          ]),
          {
            schema: {
              "type": "array",
              "prefixItems": [{ "type": "string" }],
              "minItems": 1,
              "maxItems": 1
            }
          }
        )
      })

      it("String & annotate", () => {
        assertJsonSchemaDocument(
          Schema.Tuple([
            Schema.String.annotate({ description: "a" })
          ]),
          {
            schema: {
              "type": "array",
              "prefixItems": [{ "type": "string", "description": "a" }],
              "minItems": 1,
              "maxItems": 1
            }
          }
        )
      })

      it("String & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Tuple([
            Schema.String.annotateKey({ description: "a-key" })
          ]),
          {
            schema: {
              "type": "array",
              "prefixItems": [{ "type": "string", "allOf": [{ "description": "a-key" }] }],
              "minItems": 1,
              "maxItems": 1
            }
          }
        )
      })

      it("String & annotate & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Tuple([
            Schema.String.annotate({ description: "a" }).annotateKey({ description: "a-key" })
          ]),
          {
            schema: {
              "type": "array",
              "prefixItems": [{ "type": "string", "description": "a", "allOf": [{ "description": "a-key" }] }],
              "minItems": 1,
              "maxItems": 1
            }
          }
        )
      })
    })

    describe("optionalKey", () => {
      it("String", () => {
        assertJsonSchemaDocument(
          Schema.Tuple([
            Schema.optionalKey(Schema.String)
          ]),
          {
            schema: {
              "type": "array",
              "prefixItems": [
                { "type": "string" }
              ],
              "maxItems": 1
            }
          }
        )
      })

      it("String & annotate", () => {
        assertJsonSchemaDocument(
          Schema.Tuple([
            Schema.optionalKey(Schema.String.annotate({ description: "a" })),
            Schema.optionalKey(Schema.String).annotate({ description: "b" })
          ]),
          {
            schema: {
              "type": "array",
              "prefixItems": [
                { "type": "string", "description": "a" },
                { "type": "string", "description": "b" }
              ],
              "maxItems": 2
            }
          }
        )
      })

      it("String & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Tuple([
            Schema.optionalKey(Schema.String.annotateKey({ description: "a-key" })),
            Schema.optionalKey(Schema.String).annotateKey({ description: "b-key" })
          ]),
          {
            schema: {
              "type": "array",
              "prefixItems": [
                { "type": "string", "allOf": [{ "description": "a-key" }] },
                {
                  "type": "string",
                  "allOf": [{ "description": "b-key" }]
                }
              ],
              "maxItems": 2
            }
          }
        )
      })

      it("String & annotate & annotateKey", () => {
        assertJsonSchemaDocument(
          Schema.Tuple([
            Schema.optionalKey(Schema.String.annotate({ description: "a" }).annotateKey({ description: "a-key" })),
            Schema.optionalKey(Schema.String).annotate({ description: "b" }).annotateKey({ description: "b-key" }),
            Schema.optionalKey(Schema.String.annotate({ description: "a" }).annotateKey({ description: "a-key" }))
              .annotate({ description: "c-outer" }).annotateKey({ description: "c-outer-key" })
          ]),
          {
            schema: {
              "type": "array",
              "prefixItems": [
                { "type": "string", "description": "a", "allOf": [{ "description": "a-key" }] },
                {
                  "type": "string",
                  "description": "b",
                  "allOf": [{ "description": "b-key" }]
                },
                { "type": "string", "description": "c-outer", "allOf": [{ "description": "c-outer-key" }] }
              ],
              "maxItems": 3
            }
          }
        )
      })

      it("optionalKey(String) to String", () => {
        assertJsonSchemaDocument(
          Schema.Tuple([
            Schema.optionalKey(Schema.String).pipe(Schema.encodeTo(Schema.String, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.withDefault(Effect.succeed(""))
            }))
          ]),
          {
            schema: {
              "type": "array",
              "prefixItems": [{ "type": "string" }],
              "minItems": 1,
              "maxItems": 1
            }
          }
        )
      })
    })

    it("optionalKey to required key", () => {
      assertJsonSchemaDocument(
        Schema.Tuple([
          Schema.optionalKey(Schema.String).pipe(Schema.encodeTo(Schema.String, {
            decode: SchemaGetter.passthrough(),
            encode: SchemaGetter.withDefault(Effect.succeed(""))
          }))
        ]),
        {
          schema: {
            "type": "array",
            "prefixItems": [
              { "type": "string" }
            ],
            "minItems": 1,
            "maxItems": 1
          }
        }
      )
    })
  })

  describe("Array", () => {
    it("Array(String)", () => {
      assertJsonSchemaDocument(
        Schema.Array(Schema.String),
        {
          schema: {
            "type": "array",
            "items": { "type": "string" }
          }
        }
      )
      assertJsonSchemaDocument(
        Schema.Array(Schema.String).annotate({ description: "a" }),
        {
          schema: {
            "type": "array",
            "items": { "type": "string" },
            "description": "a"
          }
        }
      )
    })

    describe("checks", () => {
      it("isMinLength", () => {
        assertJsonSchemaDocument(
          Schema.Array(Schema.String).check(Schema.isMinLength(2)),
          {
            schema: {
              "type": "array",
              "items": { "type": "string" },
              "allOf": [
                { "minItems": 2 }
              ]
            }
          }
        )
      })

      it("isMaxLength", () => {
        assertJsonSchemaDocument(
          Schema.Array(Schema.String).check(Schema.isMaxLength(2)),
          {
            schema: {
              "type": "array",
              "items": { "type": "string" },
              "allOf": [
                { "maxItems": 2 }
              ]
            }
          }
        )
      })

      it("isLengthBetween", () => {
        assertJsonSchemaDocument(
          Schema.Array(Schema.String).check(Schema.isLengthBetween(2, 2)),
          {
            schema: {
              "type": "array",
              "items": { "type": "string" },
              "allOf": [
                { "minItems": 2 },
                { "maxItems": 2 }
              ]
            }
          }
        )
      })

      it("UniqueArray", () => {
        assertJsonSchemaDocument(
          Schema.UniqueArray(Schema.String),
          {
            schema: {
              "type": "array",
              "items": { "type": "string" },
              "allOf": [
                { "uniqueItems": true }
              ]
            }
          }
        )
      })
    })
  })

  it("TupleWithRest", () => {
    assertJsonSchemaDocument(
      Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Finite]),
      {
        schema: {
          "type": "array",
          "prefixItems": [
            { "type": "string" }
          ],
          "items": { "type": "number" },
          "minItems": 1
        }
      }
    )
  })

  describe("Union", () => {
    it("empty union", () => {
      const schema = Schema.Union([])
      assertJsonSchemaDocument(schema, {
        schema: {
          "not": {}
        }
      })
      assertJsonSchemaDocument(Schema.Union([]).annotate({ description: "a" }), {
        schema: {
          "not": {},
          "description": "a"
        }
      })
    })

    it("single member", () => {
      const schema = Schema.Union([Schema.String])
      assertJsonSchemaDocument(schema, {
        schema: {
          "anyOf": [
            {
              "type": "string"
            }
          ]
        }
      })
      assertJsonSchemaDocument(Schema.Union([Schema.String]).annotate({ description: "a" }), {
        schema: {
          "anyOf": [
            {
              "type": "string"
            }
          ],
          "description": "a"
        }
      })
      assertJsonSchemaDocument(
        Schema.Union([Schema.String.annotate({ description: "inner" })]).annotate({ description: "outer" }),
        {
          schema: {
            "anyOf": [
              {
                "type": "string",
                "description": "inner"
              }
            ],
            "description": "outer"
          }
        }
      )
    })

    it("String | Number", () => {
      assertJsonSchemaDocument(
        Schema.Union([
          Schema.String,
          Schema.Finite
        ]),
        {
          schema: {
            "anyOf": [
              { "type": "string" },
              { "type": "number" }
            ]
          }
        }
      )
      assertJsonSchemaDocument(
        Schema.Union([
          Schema.String,
          Schema.Finite
        ]).annotate({ description: "description" }),
        {
          schema: {
            "anyOf": [
              { "type": "string" },
              { "type": "number" }
            ],
            "description": "description"
          }
        }
      )
    })

    it("String | BigInt", () => {
      assertJsonSchemaDocument(
        Schema.Union([
          Schema.String,
          Schema.BigInt
        ]),
        {
          schema: {
            "anyOf": [
              {
                "type": "string",
                "allOf": [
                  { "pattern": "^-?\\d+$" }
                ]
              },
              { "type": "string" }
            ]
          }
        }
      )
      assertJsonSchemaDocument(
        Schema.Union([
          Schema.String,
          Schema.Finite
        ]).annotate({ description: "description" }),
        {
          schema: {
            "anyOf": [
              { "type": "string" },
              { "type": "number" }
            ],
            "description": "description"
          }
        }
      )
    })
  })

  it("mutually recursive schemas", () => {
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
    }).annotate({ identifier: "Expression" })

    const Operation = Schema.Struct({
      type: Schema.Literal("operation"),
      operator: Schema.Literals(["+", "-"]),
      left: Expression,
      right: Expression
    }).annotate({ identifier: "Operation" })

    assertJsonSchemaDocument(
      Operation,
      {
        schema: {
          "$ref": "#/$defs/Operation"
        },
        definitions: {
          Operation: {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "operation"
                ]
              },
              "operator": {
                "type": "string",
                "enum": [
                  "+",
                  "-"
                ]
              },
              "left": {
                "$ref": "#/$defs/Expression"
              },
              "right": {
                "$ref": "#/$defs/Expression"
              }
            },
            "required": [
              "type",
              "operator",
              "left",
              "right"
            ],
            "additionalProperties": false
          },
          Expression: {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "expression"
                ]
              },
              "value": {
                "anyOf": [
                  {
                    "type": "number"
                  },
                  {
                    "$ref": "#/$defs/Operation"
                  }
                ]
              }
            },
            "required": [
              "type",
              "value"
            ],
            "additionalProperties": false
          }
        }
      }
    )
    assertJsonSchemaDocument(
      Expression,
      {
        schema: {
          "$ref": "#/$defs/Expression"
        },
        definitions: {
          Operation: {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "operation"
                ]
              },
              "operator": {
                "type": "string",
                "enum": [
                  "+",
                  "-"
                ]
              },
              "left": {
                "$ref": "#/$defs/Expression"
              },
              "right": {
                "$ref": "#/$defs/Expression"
              }
            },
            "required": [
              "type",
              "operator",
              "left",
              "right"
            ],
            "additionalProperties": false
          },
          Expression: {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "expression"
                ]
              },
              "value": {
                "anyOf": [
                  {
                    "type": "number"
                  },
                  {
                    "$ref": "#/$defs/Operation"
                  }
                ]
              }
            },
            "required": [
              "type",
              "value"
            ],
            "additionalProperties": false
          }
        }
      }
    )
  })

  describe("fromJsonString", () => {
    it("top level fromJsonString", () => {
      assertJsonSchemaDocument(
        Schema.fromJsonString(Schema.FiniteFromString),
        {
          schema: {
            "type": "string",
            "contentMediaType": "application/json",
            "contentSchema": {
              "type": "string"
            }
          }
        }
      )
    })

    it("nested fromJsonString", () => {
      assertJsonSchemaDocument(
        Schema.fromJsonString(Schema.Struct({
          a: Schema.fromJsonString(Schema.FiniteFromString)
        })),
        {
          schema: {
            "type": "string",
            "contentMediaType": "application/json",
            "contentSchema": {
              "additionalProperties": false,
              "properties": {
                "a": {
                  "contentMediaType": "application/json",
                  "contentSchema": {
                    "type": "string"
                  },
                  "type": "string"
                }
              },
              "required": [
                "a"
              ],
              "type": "object"
            }
          }
        }
      )
    })
  })

  it("Class", () => {
    class A extends Schema.Class<A>("A")({
      a: Schema.String
    }) {}
    assertJsonSchemaDocument(
      A,
      {
        schema: {
          "$ref": "#/$defs/A"
        },
        definitions: {
          A: {
            "type": "object",
            "properties": {
              "a": { "type": "string" }
            },
            "required": ["a"],
            "additionalProperties": false
          }
        }
      }
    )
  })

  it("ErrorClass", () => {
    class E extends Schema.ErrorClass<E>("E")({
      a: Schema.String
    }) {}
    assertJsonSchemaDocument(E, {
      schema: {
        "$ref": "#/$defs/E"
      },
      definitions: {
        E: {
          "type": "object",
          "properties": {
            "a": { "type": "string" }
          },
          "required": ["a"],
          "additionalProperties": false
        }
      }
    })
  })
})
