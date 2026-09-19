---
"effect": patch
---

Fix `Types.RequiredKeys` dropping named required keys on types with index signatures. Derived type annotations may need to include these keys.
