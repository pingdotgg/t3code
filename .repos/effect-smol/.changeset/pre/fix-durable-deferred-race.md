---
"effect": patch
---

Fix `DurableDeferred.raceAll` so a completed deferred can wake an active workflow without changing success-biased race semantics
