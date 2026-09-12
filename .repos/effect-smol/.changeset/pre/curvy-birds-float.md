---
"effect": patch
---

Update `Schema.Void` to model ignored `void` return values.

Runtime parsing now accepts any present value and discards it as `undefined`.
This matches TypeScript `void` return values, where callers do not observe the
returned value. Use `Schema.Undefined` when the input must be exactly
`undefined`.
