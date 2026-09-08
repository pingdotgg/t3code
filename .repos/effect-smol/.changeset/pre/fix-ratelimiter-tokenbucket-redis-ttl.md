---
"effect": patch
---

Fix the Redis `RateLimiterStore` token-bucket failing with opaque errors under memory pressure: it now writes its keys with a TTL and guards against a missing refill timestamp.
