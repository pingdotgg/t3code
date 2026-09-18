---
"effect": patch
---

Fix `HttpApiBuilder` ignoring the status annotation on a `HttpApiSchema.WithHeaders` wrapper around a streaming success, which defected when the wrapper and inner statuses differed.
