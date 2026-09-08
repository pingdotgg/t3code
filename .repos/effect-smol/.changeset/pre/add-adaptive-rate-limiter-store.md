---
"effect": patch
---

Add adaptive consume and feedback operations to the unstable persistent RateLimiterStore API, including in-memory and Redis-backed bounded cooldown, learning, learned pacing, and expiry behavior for 429 Retry-After feedback.
