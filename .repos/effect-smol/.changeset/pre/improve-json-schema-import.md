---
"effect": patch
---

Improve `SchemaRepresentation.fromJsonSchemaDocument` and `fromJsonSchemaMultiDocument`:

- Import `{ not: {} }` as `Schema.Never` (#8137).

- Import closed records with one `patternProperties` entry, `additionalProperties: false`, and no declared or required properties when `patterns: "apply"` is enabled. These were previously rejected.

  ```json
  {
    "type": "object",
    "patternProperties": { "^a": { "type": "number" } },
    "additionalProperties": false
  }
  ```

  ```ts
  Schema.Record(
    Schema.String.check(Schema.isPattern(/^a/)),
    Schema.Finite
  )
  ```

- Reject open patterned objects with `patterns: "apply"` instead of generating incompatible TypeScript index signatures.

  ```json
  {
    "type": "object",
    "patternProperties": { "^a": { "type": "number" } },
    "additionalProperties": true
  }
  ```

  Import now explains that the generated TypeScript index signatures would give incorrect types to unmatched keys, and reports the source path. The same applies when `additionalProperties` is omitted or `{}`. Patterns can still be combined with a closed object in `allOf` when the result has a finite set of keys. Use `patterns: "ignore"` only if you intend to discard the pattern and its value constraints.

- Reject references inside a subschema with its own `$id` instead of potentially resolving against the wrong definitions. Resolve or flatten these references before importing. A `$id` on the document root remains supported.

  ```json
  {
    "$id": "https://example.com/root",
    "$defs": { "Value": { "type": "string" } },
    "type": "object",
    "properties": {
      "child": {
        "$id": "child",
        "$defs": { "Value": { "type": "number" } },
        "$ref": "#/$defs/Value"
      }
    }
  }
  ```

  Here `child` refers to the nested numeric `Value`, not the root string `Value`. Import now reports that references inside a subschema with its own `$id` are unsupported instead of incorrectly using the root definition.

- Explain import failures using JSON Schema keyword names, the reason for rejection, and the source path. Reference errors distinguish missing definitions, unsupported reference formats, and circular aliases. Pattern errors explain how to opt in for trusted schemas or explicitly discard the constraints.
