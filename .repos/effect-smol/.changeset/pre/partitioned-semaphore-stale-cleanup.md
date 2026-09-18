---
"effect": patch
---

Fix `PartitionedSemaphore` leaving a new waiter suspended when a previously resumed waiter for the same partition is interrupted before its acquisition completes.
