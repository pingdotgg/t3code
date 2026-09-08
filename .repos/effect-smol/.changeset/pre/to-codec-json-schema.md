---
"effect": patch
---

Expose the original input schema on `Schema.toType`, `Schema.toEncoded`, `Schema.toCodecJson`, and `Schema.toCodecStringTree` results via the `schema` property. This aligns these schema wrappers with other wrappers that retain their source schema for type-level and runtime introspection.
