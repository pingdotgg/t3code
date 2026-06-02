---
"effect": patch
---

Add `schema.makeEffect(input, options?)` to `Schema.Bottom` and schema-backed classes, matching the existing constructor behavior exposed by `makeUnsafe` / `makeOption` while returning an `Effect` failure with `Schema.SchemaError`.
