---
"effect": patch
---

Fix `TestClock.currentTimeNanosUnsafe()` to floor fractional millisecond instants before converting them to `BigInt`.
