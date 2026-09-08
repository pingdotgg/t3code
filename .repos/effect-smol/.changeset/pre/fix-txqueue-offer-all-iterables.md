---
"effect": patch
---

Fix `TxQueue.offerAll` to preserve one-shot iterables across transaction retries and repeated runs.
