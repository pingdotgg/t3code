---
"effect": patch
---

Fix `PartitionedSemaphore.take` leaking partially acquired permits when interrupted.
