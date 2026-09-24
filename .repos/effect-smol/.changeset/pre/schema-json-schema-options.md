---
"effect": patch
---

JSON Schema generation now follows the canonical JSON codec more closely and leaves unmodeled object properties open by default, matching Effect decoding.

### Breaking changes

`Schema.ToJsonSchemaOptions.additionalProperties` has been replaced by `onExcessProperty`:

- Replace `{ additionalProperties: true }` with `{ onExcessProperty: "ignore" }`.
- Replace `{ additionalProperties: false }` with `{ onExcessProperty: "error" }`.
- Replace a schema-valued `additionalProperties` option with `Schema.Record` or `Schema.StructWithRest`.

`Schema.Enum` now rejects non-finite numeric members. `Schema.isMultipleOf` now rejects zero and non-finite divisors, and normalizes negative divisors.

Generation is more accurate for index signatures, empty structs, template literal alternatives, capitalized strings, and unique symbols. Conjunctive index keys remain open by default; `onExcessProperty: "error"` constrains them with `propertyNames`.
