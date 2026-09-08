---
"effect": patch
---

Fix Redis script evaluation so transient `SCRIPT LOAD` failures are retried instead of being cached indefinitely.
