---
"effect": patch
---

Fix cluster shutdown hangs by failing abandoned non-discard requests and stream chunk acknowledgements with `EntityNotAssignedToRunner`, including persisted requests sent after runner unregistration. This adds `EntityNotAssignedToRunner` to the typed error channel of entity clients and request-only `EntityProxy` RPC/HTTP endpoints; discard endpoints remain unchanged.
