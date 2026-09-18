---
"effect": patch
---

Improve `PersistedQueue` reliability across SQL, Redis, and memory stores. Retry policy now lives on `make()`, attempts count on claim, retries follow a `Schedule`, and exhausted or undecodable elements are dead-lettered. Add retention cleanup, durable acknowledgement retries, storage schema fixes, local poll wakeups, and fixes for the memory take race and Redis dedup growth.
