/**
 * Cloud-agnostic Redis runtime client. Fly and Railway resources bind
 * `REDIS_URL`; this module speaks RESP over that URL. Import from
 * `alchemy/Redis`.
 *
 * The codec is a complete RESP2 parser (plus RESP3 types) reimplemented
 * in TypeScript after the official spec and the algorithm in
 * `node-redis-parser`. There is no ioredis / node-redis dependency.
 *
 * Bindings stay on the cloud (`Fly.ReadWriteRedis`,
 * `Railway.ReadWriteRedis`). Those layers call {@link makeReadWrite}
 * so the RESP client is not duplicated.
 *
 * @example
 * ```typescript
 * import * as Redis from "alchemy/Redis";
 *
 * const cache = Redis.makeReadWrite(url);
 * yield* cache.set("marker", "hello");
 * const value = yield* cache.get("marker");
 * const custom = yield* cache.send("ECHO", ["hi"]);
 * ```
 */
export * from "./Client.ts";
export * from "./Errors.ts";
export * from "./Protocol.ts";
export * from "./Resp.ts";
