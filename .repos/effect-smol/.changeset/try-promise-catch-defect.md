---
"effect": patch
---

Fix `Effect.try` thunk usage and `Effect.tryPromise` mapper and signal handling defects.

`Effect.try` now supports passing a thunk directly, matching `Effect.tryPromise`. Thrown values from direct-thunk usage are mapped to `Cause.UnknownError`.

When a promise handled by `Effect.tryPromise` rejected and the custom `catch` mapper threw while mapping that rejection, the effect could remain pending and produce an unhandled rejection. The mapper is now guarded consistently with the synchronous throw path, so a thrown mapper error becomes an Effect defect. The JSDoc for `Effect.try` and `Effect.tryPromise` was also corrected.

`Effect.tryPromise` now also only creates an `AbortController` when the wrapped thunk declares an `AbortSignal` parameter.
