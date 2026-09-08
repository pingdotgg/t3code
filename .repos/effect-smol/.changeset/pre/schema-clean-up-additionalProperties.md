---
"effect": patch
---

Schema: `toJsonSchemaDocument` now emits JSON Schema `false` for unannotated
`Never` index signatures (including `additionalProperties`) instead of `{ not: {} }`.
Annotated `Never` still emits a schema object so metadata like `description` is preserved.
