---
"effect": patch
---

Ensure `TxQueue.poll` and `TxQueue.clear` complete a closing queue after draining its buffered items.
