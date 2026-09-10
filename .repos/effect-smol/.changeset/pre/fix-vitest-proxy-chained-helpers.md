---
"@effect/vitest": patch
---

Preserve chained vitest helpers like `it.describe.each` and `it.skip.each` when accessed through the `it` proxy. Previously the proxy returned bound copies of vitest's functions, which stripped their static helper properties and caused `TypeError: it.describe.each is not a function`.
