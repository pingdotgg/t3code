---
"effect": patch
---

Fix `Effectable.Class` evaluation by delegating to its abstract `asEffect()` method. The method is called on the instance for each execution, preserving current receiver state and provided services.
