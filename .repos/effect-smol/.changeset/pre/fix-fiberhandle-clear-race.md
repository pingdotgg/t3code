---
"effect": patch
---

Fix a race where FiberHandle.clear could remove a newer fiber installed while the previous fiber was still interrupting.
