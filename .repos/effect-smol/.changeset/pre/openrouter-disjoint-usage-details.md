---
"@effect/ai-openrouter": patch
---

Fix negative text and uncached token usage when reasoning or cached counts exceed their parent totals. Treat these counts as disjoint, adding them to the total and retaining the parent count as text or uncached usage.

Disjoint counts at or below their parent totals remain indistinguishable from subsets, so their totals are still undercounted.
