---
"effect": patch
---

Stop declaring `SynchronizedRef` as a subtype of `Ref`, preventing `Ref` combinators from accepting values that do not implement the required runtime representation.
