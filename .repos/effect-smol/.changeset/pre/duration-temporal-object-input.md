---
"effect": patch
---

Add `DurationObject` to `Duration.Input` to support Temporal-style object input.

Durations can now be created from objects with named unit properties like `{ hours: 1, minutes: 30 }`, similar to `Temporal.Duration.from()`. Supported fields: `weeks`, `days`, `hours`, `minutes`, `seconds`, `millis`, `micros`, `nanos`.
