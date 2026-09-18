---
"effect": patch
---

Preserve resource acquisition errors on `LayerMap.Service` when `preload: true` is set. The yielded service instance and its `get`, `contextEffect`, and `contextEffectOption` accessors now retain the resource error type because a resource can fail when reacquired, even if preloading succeeded.

Consumers that assumed these accessors had a `never` error must handle the resource error. Runtime behavior is unchanged.
