---
"effect": patch
---

Fix `Semaphore.withPermits` leaking permits when interrupted between acquiring them and installing their release.
