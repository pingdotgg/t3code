---
"effect": patch
---

Fix `AtomRpc.query` returning `never` for RPCs whose middleware declares service `requires`. The return-type conditional now infers all six `Rpc` type parameters, matching `mutation` and every utility in `Rpc`.
