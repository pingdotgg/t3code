---
"effect": patch
---

Fix metrics reused across different `MetricRegistry` services to read and update the active registry while preserving each registry's values when revisited.
