---
"effect": patch
---

Rename `Effect.transaction` to `Effect.tx` and `Effect.retryTransaction` to `Effect.txRetry`, remove `Effect.transactionWith` / `Effect.withTxState`, make nested `Effect.tx` calls compose into the active transaction, and make the public `Tx*` APIs establish atomic transactions without requiring `Transaction` in common usage.
