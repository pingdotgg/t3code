---
"@effect/opentelemetry": patch
---

Use monotonic clock for log timestamps to match span timestamps.

The Logger used `Date.now()` (wall clock) for log `timestamp` while the Tracer used `clock.currentTimeNanosUnsafe()` (monotonic clock) for span `startTime`. This caused logs to appear before their parent span due to clock drift between the two sources. Both now use the same monotonic clock via `nanosToHrTime(clock.currentTimeNanosUnsafe())`.
