---
"effect": patch
---

Fix `SqlResolver.findById` failing to complete duplicate requests when id encoding fails, which surfaced as a `RequestResolver did not complete request` defect instead of the underlying `SchemaError`.
