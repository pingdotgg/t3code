---
"effect": patch
---

Expose `SchemaError` as a public module and re-export `Schema.isSchemaError`.

This gives consumers a stable import path and guard for schema failures without
depending on the internal schema implementation, while preserving the existing
`Schema.SchemaError` surface.
