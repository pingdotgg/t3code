---
"effect": patch
---

Mark `Schema.UnknownFromJsonString` as internal and remove its type-level interface. Use `Schema.fromJsonString(Schema.Unknown)` instead. Add `reviver`, callback or array `replacer`, and `space` options to `Schema.fromJsonString`, and make `SchemaTransformation.fromJsonString` a configurable factory.
