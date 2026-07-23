import { Schema, SchemaRepresentation } from "effect"
import { describe, it } from "vitest"
import { deepStrictEqual } from "../../utils/assert.ts"

describe("toJsonSchemaMultiDocument", () => {
  it("should handle multiple schemas", () => {
    const A = Schema.String.annotate({ identifier: "id", description: "a" })
    const B = Schema.String.annotate({ identifier: "id", description: "b" })
    const C = Schema.Tuple([A, B])
    const multiDocument = SchemaRepresentation.fromASTs([A.ast, B.ast, C.ast])
    const jsonMultiDocument = SchemaRepresentation.toJsonSchemaMultiDocument(multiDocument)
    deepStrictEqual(jsonMultiDocument, {
      dialect: "draft-2020-12",
      schemas: [
        { "$ref": "#/$defs/id" },
        { "$ref": "#/$defs/id1" },
        {
          "type": "array",
          "prefixItems": [
            { "$ref": "#/$defs/id" },
            { "$ref": "#/$defs/id1" }
          ],
          "minItems": 2,
          "maxItems": 2
        }
      ],
      definitions: {
        id: {
          "type": "string",
          "description": "a"
        },
        id1: {
          "type": "string",
          "description": "b"
        }
      }
    })
  })
})
