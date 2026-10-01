---
"effect": patch
---

Keep completed results in `RequestResolver.withCache` when a losing `RequestResolver.race` resolver is interrupted after the winner completes, avoiding repeated backend requests on subsequent equal lookups.
