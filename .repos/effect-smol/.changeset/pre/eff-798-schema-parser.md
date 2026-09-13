---
"effect": patch
---

Improve synchronous Schema decode and encode performance by preserving completed parser exits and using a direct loop for common struct parsers.
