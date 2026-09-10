---
"effect": patch
---

Improve Pool acquisition and release performance. Pool now tracks usage
incrementally, stores available items in an intrusive FIFO, and skips work for
fixed and empty pools. This changes the public `Pool.State` and `Pool.PoolItem`
interfaces.
