---
"@effect/platform-node": patch
---

Migrate `NodeRedis` from `ioredis` to `redis` (node-redis), replacing the peer dependency with `redis: >=5.0.0 <7.0.0`.

`layer` and `layerConfig` now accept `RedisClientOptions`: socket settings move under `socket`, `db` becomes `database`, command methods are camelCase, and arbitrary commands use `sendCommand`. Protocol selection follows the installed node-redis version's default.

Layers connect while being built and can fail with `RedisError`. Initial connections fail fast unless a `socket.reconnectStrategy` is provided; after `ready`, the default reconnect behavior applies. Scope finalization uses `close()`, so in-flight or blocking commands can delay closure.
