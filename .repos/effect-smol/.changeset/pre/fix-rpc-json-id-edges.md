---
"effect": patch
---

Fix JSON-RPC serialization for `id` values that are falsey but valid, including `0` and `""`, while still mapping `null` to Effect's internal notification sentinel.
