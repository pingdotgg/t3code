---
"effect": patch
---

Fix `Match.value` terminal combinators failing to typecheck when the input
contains a generic type parameter.

The fifth type argument of `Matcher` for value matchers is now `ValueFlavor`,
and `ValueMatcher` has a seventh flavor argument; update hand-written
annotations accordingly.
