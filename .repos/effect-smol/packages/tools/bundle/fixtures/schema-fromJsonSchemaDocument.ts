import * as SchemaRepresentation from "effect/SchemaRepresentation"

SchemaRepresentation.fromJsonSchemaDocument({
  "dialect": "draft-2020-12",
  "schema": {
    "type": "object",
    "properties": {
      "a": {
        "type": "string"
      }
    }
  },
  "definitions": {}
})
