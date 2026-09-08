---
"effect": patch
---

Fix `Stream.groupedWithin` to stop emitting empty arrays when schedule ticks fire while upstream is idle.
