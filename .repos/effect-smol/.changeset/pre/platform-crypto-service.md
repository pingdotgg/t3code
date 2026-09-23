---
"effect": patch
"@effect/platform-node": patch
"@effect/platform-node-shared": patch
"@effect/platform-bun": patch
"@effect/platform-browser": patch
---

Add a platform-agnostic `Crypto` service for cryptographic random bytes, secure random generators, UUIDv4 / UUIDv7 generation, and digest operations. UUID generation should now use the `Crypto` service's `randomUUIDv4` or `randomUUIDv7`, which format bytes from the platform `Crypto` service; UUIDv7 also uses the `Clock` service timestamp. `Random.nextUUIDv4` has been removed because the base `Random` service is not cryptographically secure.
