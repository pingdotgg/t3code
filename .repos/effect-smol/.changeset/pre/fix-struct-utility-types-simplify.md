---
"effect": patch
---

Fix `Struct` utility return types (for example `pick`) to preserve the previous simplified shape instead of exposing raw utility types like `Pick<T, K>`, closes #1855.
