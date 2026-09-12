---
"effect": patch
---

Fix `SchemaRepresentation.toCodeDocument` generating invalid TypeScript for optional tuple elements containing unions or nested readonly tuples. Optional element types are now parenthesized, for example `readonly [(string | number)?]` instead of `readonly [string | number?]`. Generated runtime schemas are unchanged.
