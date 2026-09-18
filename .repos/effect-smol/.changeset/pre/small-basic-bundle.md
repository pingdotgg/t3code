---
"effect": patch
---

Reduce the basic Effect bundle size by keeping cause deduplication local, making encoding lookup tables tree-shakeable, removing redundant cause field declarations, and simplifying primitive hash dispatch without changing hash values.
