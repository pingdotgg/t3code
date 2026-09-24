---
"@effect/platform-node": patch
---

Defer loading Undici until an Undici-backed layer is acquired, preventing Node HTTP client imports from replacing Node's global fetch dispatcher. Import Undici APIs from `@effect/platform-node/Undici` instead of the package root.
