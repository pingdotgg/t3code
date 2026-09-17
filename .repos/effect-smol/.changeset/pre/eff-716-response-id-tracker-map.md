---
"effect": patch
---

Use a normal Map in ResponseIdTracker and clear it on divergence / reset instead of reallocating a WeakMap.
