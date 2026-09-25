---
"effect": patch
---

Fix Latch open/release resuming waiters that registered after a subsequent close.

`Latch.open` and `Latch.release` schedule the waiter flush on the fiber's
dispatcher. Previously the flush drained whatever waiters existed at flush
time, so a waiter that registered after the latch was closed again could be
resumed by the stale flush. The waiters are now snapshotted at schedule time,
so only waiters covered by an `open`/`release` call are resumed.
