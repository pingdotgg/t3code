---
"effect": patch
---

Report retried RPC socket open failures through the `onTransientError` protocol hook and fail in-flight requests when the retry policy is exhausted.
