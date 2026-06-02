---
"effect": patch
---

Port `SqlSchema.findOne` from effect v3 to return `Option` on empty results and add `SqlSchema.single` for the fail-on-empty behavior.
