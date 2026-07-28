---
"effect": patch
---

`Config.withDefault` no longer recovers from schema filter failures. A filter
failure means a present value reached refinement checks, so using the default
could hide invalid configuration values.
