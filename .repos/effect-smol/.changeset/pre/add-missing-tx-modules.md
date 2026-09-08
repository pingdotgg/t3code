---
"effect": patch
---

Add transactional STM modules: TxDeferred, TxPriorityQueue, TxPubSub, TxReentrantLock, TxSubscriptionRef.

Refactor transaction model: remove `Effect.atomic`/`Effect.atomicWith`. All Tx operations now return `Effect<A, E, Transaction>` requiring explicit `Effect.tx(...)` at boundaries.

Expose `TxPubSub.acquireSubscriber`/`releaseSubscriber` for composable transaction boundaries. Fix `TxSubscriptionRef.changes` race condition ensuring current value is delivered first.

Remove `TxRandom` module.
