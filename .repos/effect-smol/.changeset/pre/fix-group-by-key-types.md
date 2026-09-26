---
"effect": patch
---

Preserve finite string and unique symbol key unions in the return types of `Array.groupBy` and `Iterable.groupBy`.

Previously, grouping widened finite keys to `string` or `symbol`, which lost known-key autocomplete and allowed access to keys that the selector could never produce. The new `Record.ReadonlyRecord.GroupByResult` keeps finite keys and marks their properties optional because any group may be absent at runtime, while open `string` and `symbol` selectors retain their existing record index signatures.
