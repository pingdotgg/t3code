---
"effect": patch
---

Honor `captureStackTrace` in both forms of `Layer.withSpan`. Layer construction diagnostics previously reported a location inside `Layer.ts` instead of the `withSpan` call site, and ignored `captureStackTrace: false` or a supplied lazy stack.
