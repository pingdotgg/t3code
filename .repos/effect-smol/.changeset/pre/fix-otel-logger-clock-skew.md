---
"@effect/opentelemetry": patch
---

Use the Effect wall clock for log timestamps to match span timestamps.

The Logger used `Date.now()` directly for log `timestamp` while the Tracer used `clock.currentTimeNanosUnsafe()` for span `startTime`. These could diverge when the high-resolution wall-clock origin drifted, causing logs to appear before their parent span. Both now use the same Effect wall clock via `nanosToHrTime(clock.currentTimeNanosUnsafe())`.
