---
"effect": patch
---

Normalize numeric collection and batch counts across `Stream`, `Channel`, `Sink`, `MutableList`, `RequestResolver`, `Queue`, `TxQueue`, `PubSub`, and `HashRing`, preventing fractional, `NaN`, and non-positive counts from producing incorrect output, exceptions, waits for the wrong batch size, or non-terminating pulls.
