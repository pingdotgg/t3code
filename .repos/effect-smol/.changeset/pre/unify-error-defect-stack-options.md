---
"effect": patch
---

Replace the `Schema.Error` and `Schema.Defect` schema constants with constructor
functions, `Schema.Error()` and `Schema.Defect()`.

Unify `Schema.ErrorWithStack` into `Schema.Error({ includeStack: true })` and
`Schema.DefectWithStack` into `Schema.Defect({ includeStack: true })`.

Error causes are encoded by default using the same JSON defect encoding
semantics used by `Schema.Defect`; pass `{ excludeCause: true }` to omit nested
cause data.

Equivalent `Schema.Error` and `Schema.Defect` options are canonicalized, so
repeated constructor calls with the same option values reuse the same schema.

`Schema.Defect()` now models defects as `unknown` values with a JSON encoded
form. Error-shaped JSON objects with a string `message` decode to JavaScript
`Error` values, so non-`Error` objects such as `{ message: "boom" }` do not
round-trip unchanged. Other non-`Error` values are normalized through JSON
serialization, with non-JSON values falling back to Effect's formatted string
representation.
