---
"effect": patch
---

Add `Schema.DurationFromString` and `SchemaTransformation.durationFromString`, support `"Infinity"` and `"-Infinity"` in `Duration.fromInput`, and simplify config duration parsing around the shared schema codec, closes #2092.
