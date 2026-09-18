---
"@effect/atom-solid": patch
---

Allow `RegistryProvider` to leave `defaultIdleTTL` undefined, matching the React binding and enabling immediate cleanup of unused atoms unless a TTL is explicitly configured.
