---
"effect": patch
---

Fix `FiberMap` losing track of fibers started under the same key by a replaced fiber's synchronous finalizer, ensuring they are interrupted when the map's scope closes.
