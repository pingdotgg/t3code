---
"effect": patch
---

Fix `Stream.toQueue` types and implementation to return a `Queue.Dequeue` in both overloads and delegate to `Channel.toQueueArray`.
