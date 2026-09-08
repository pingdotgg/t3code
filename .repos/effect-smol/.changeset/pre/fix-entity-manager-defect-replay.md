---
"effect": patch
---

Fix EntityManager defect restarts so in-flight requests are replayed instead of being dropped when the old entity scope is interrupted.
