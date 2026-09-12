---
"effect": patch
---

Rename the Schema error constructors to align with their `Data` counterparts.

- `Schema.ErrorClass` is now `Schema.Error`.
- `Schema.TaggedErrorClass` is now `Schema.TaggedError`.
- The JavaScript `Error` instance schema is now `Schema.ErrorInstance`.
- `Schema.ErrorReviver` is now `Schema.ErrorInstanceReviver`.
