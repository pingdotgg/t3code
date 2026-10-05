---
"effect": patch
---

Preserve an already registered fiber when `FiberHandle` or `FiberMap` registers it again with `onlyIfMissing: true`, instead of interrupting it and clearing the entry.
