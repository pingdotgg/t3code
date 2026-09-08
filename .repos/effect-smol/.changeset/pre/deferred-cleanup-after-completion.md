---
"effect": patch
---

Fix `Deferred.await` dying with a `TypeError` when a waiter is interrupted after the `Deferred` has been completed.
