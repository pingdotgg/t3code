/**
 * vinext data-cache adapter builder for Redis.
 *
 * Node Website.Vinext resources inject this adapter automatically.
 * The runtime factory uses {@link connect} from `alchemy/Redis` (the same
 * client Fly/Railway `*RedisHttp` layers use) and reads `REDIS_URL`
 * (or `urlEnv`) from the process environment.
 *
 * Pair with `Railway.Redis` / `Fly.Redis` so the Website host gets
 * `REDIS_URL`. Missing URL (local `vinext start` / `alchemy dev`) makes
 * vinext log and fall back to the in-memory handler.
 */
import { fileURLToPath } from "node:url";
import type { RedisAdapterOptions } from "./redis-runtime.ts";

export type { RedisAdapterOptions } from "./redis-runtime.ts";

export const DEFAULT_REDIS_URL_ENV = "REDIS_URL";

export const redisAdapter = (options?: RedisAdapterOptions) => {
  if (options?.urlEnv !== undefined && typeof options.urlEnv !== "string") {
    throw new TypeError(
      "[vinext] redisAdapter({ urlEnv }) must be a string env var name.",
    );
  }
  return {
    adapter: fileURLToPath(new URL("./redis-runtime.js", import.meta.url)),
    options,
  };
};
