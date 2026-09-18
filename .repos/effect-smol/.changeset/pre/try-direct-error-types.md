---
"effect": patch
---

Correct the error types of `Effect.try` and `Effect.tryPromise`. Direct function forms retain `Cause.UnknownError`, while `{ try, catch }` options use the error type returned by `catch`.

Explicit two-generic direct calls, union-valued arguments, and generic aliases that combine the two forms no longer compile. Use `{ try, catch }` with a real error mapper, or narrow a union before calling the constructor.

Runtime behavior, callback arguments, and error mapping are unchanged.
