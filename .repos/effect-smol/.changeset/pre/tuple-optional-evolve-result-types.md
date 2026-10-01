---
"effect": patch
---

Correct `Tuple.evolve` result types when a transform may be `undefined`. The result now includes both the transformed and unchanged element types, matching the existing runtime behavior. Accepted inputs and runtime behavior are unchanged.

Code relying on the previous, incorrect result type must handle both outcomes. For example, a number-to-string transform that may be absent now produces `number | string`, so callers assuming a number-only result must adjust.
