---
"effect": minor
---

Separate wall-clock timestamps from monotonic elapsed time.

`Clock.Clock` now requires `monotonicTimeNanosUnsafe()` and `monotonicTimeNanos` for measuring elapsed time. Custom `Clock` implementations must provide both members. The live clock's `currentTimeNanos` now re-anchors its high-resolution Unix wall-clock timestamp when it drifts from `Date.now()`, while `Effect.timed`, duration metric tracking, and `Sink.withDuration` use monotonic time so wall-clock corrections do not distort elapsed durations.
