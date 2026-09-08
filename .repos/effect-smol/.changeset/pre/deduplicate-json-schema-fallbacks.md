---
"effect": patch
"@effect/openapi-generator": patch
---

Deduplicate equivalent fallback definitions when compiling JSON Schema, and reconstruct only definitions reachable from multi-document roots.

Remove `SchemaMultiDocument` and `fromSchemaMultiDocument`; multi-document import and revival now return the ordered root schemas directly.

Stop the OpenAPI generator from emitting component schemas that are not reachable from a generated root.
