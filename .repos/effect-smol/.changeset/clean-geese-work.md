---
"effect": patch
---

Remove `Inspectable.stringifyCircular` and fix `Formatter.formatJson` so shared object references are preserved while only circular references are omitted.
