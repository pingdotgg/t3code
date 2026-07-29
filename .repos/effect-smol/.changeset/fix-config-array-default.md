---
"effect": patch
---

Fix `Config.schema` so missing array values are treated as missing data, allowing `Config.withDefault` to apply.
