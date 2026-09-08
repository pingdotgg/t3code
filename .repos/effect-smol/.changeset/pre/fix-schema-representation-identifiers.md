---
"effect": patch
---

SchemaRepresentation: generate references from encoded AST identity, suffix colliding identifiers instead of throwing, and preserve sharing across property-key context. This avoids false-positive duplicate identifier errors while keeping referentially distinct schemas addressable; generated fallback definitions now use the clearer `Encoded` suffix.
