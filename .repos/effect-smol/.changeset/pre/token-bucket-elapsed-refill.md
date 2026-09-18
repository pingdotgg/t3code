---
"effect": patch
---

Fix token-bucket `retryAfter`, `delay` and `resetAfter` in the memory and Redis stores. Timing now follows whole-token refill boundaries and accounts for elapsed time, including fractional token costs. Redis preserves signed fractional counts and keeps keys until capacity actually refills.

`RateLimiterStore.tokenBucket` now returns `[remaining, elapsedMillis]` instead of `remaining`. Custom stores must return both values from the same atomic operation; see the `tokenBucket` docs for the contract. Returning `[remaining, 0]` keeps the old timing bug.
