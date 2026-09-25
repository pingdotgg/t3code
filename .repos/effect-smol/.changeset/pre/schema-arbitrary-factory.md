---
"effect": patch
---

Consolidate schema arbitrary derivation into `Schema.toArbitrary`, which now returns a `Schema.Arbitrary` factory that accepts the fast-check module. Remove `Schema.toArbitraryLazy` and arbitrary derivation reports.
