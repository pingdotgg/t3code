---
"effect": patch
---

Fix `TaggedUnion.match` to use `Unify` for return types, allowing
branches to return distinct Effect types that are properly merged.
