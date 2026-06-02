---
"effect": patch
---

Fix a race in `Semaphore.take` where interruption could leak permits after a waiter was resumed.
