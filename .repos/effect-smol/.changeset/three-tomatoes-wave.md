---
"effect": patch
---

Fix `unstable/sql/SqlSchema` request input typing so `findAll` and `findNonEmpty` accept `Request["Type"]` instead of `Request["Encoded"]`.
