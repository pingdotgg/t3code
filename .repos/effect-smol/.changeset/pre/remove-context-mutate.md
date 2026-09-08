---
"effect": patch
---

Remove `Context.mutate` and `Context.getReferenceUnsafe`. Context updates now use overlays, and `Context.get` resolves reference defaults.
