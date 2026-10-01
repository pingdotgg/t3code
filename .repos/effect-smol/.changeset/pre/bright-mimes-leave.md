---
"@effect/platform-node": patch
"effect": patch
---

Remove the `mime` runtime dependency. The new `effect/unstable/http/Mime` module provides top-level lookup functions
backed by a vendored standard MIME registry.
