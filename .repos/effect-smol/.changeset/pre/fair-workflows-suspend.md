---
"effect": patch
---

Fix parallel child workflows inside activities to dispatch before suspending, release activity resources during durable waits, and resume reliably when children complete during cleanup.
