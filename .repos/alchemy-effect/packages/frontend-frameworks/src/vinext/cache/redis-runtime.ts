/**
 * vinext data-cache adapter backed by Redis. Default export is the
 * factory `virtual:vinext-cache-adapters` calls as
 * `({ env, options }) => CacheHandler`.
 *
 * Speaks RESP through `connect` from `alchemy/Redis` — the same client
 * Fly/Railway `*RedisHttp` layers use. One process-lifetime connection
 * per URL. Prerender artifacts are seeded into Redis in the background.
 */
import { connect, type Connection } from "alchemy/Redis";
import type { Arg, Reply } from "alchemy/Redis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { makeDataCacheHandler, type DataCacheStore } from "./handler.ts";
import { readEnvString } from "./shared.ts";
import { seedStoreFromPrerenderLogged } from "./seed.ts";

export interface RedisAdapterOptions extends Record<string, unknown> {
  /** Env var holding the Redis URL. @default "REDIS_URL" */
  readonly urlEnv?: string;
  readonly appPrefix?: string;
  /** Default key TTL in seconds. @default 2592000 (30 days) */
  readonly ttlSeconds?: number;
  readonly tagCacheTtlMs?: number;
}

const DEFAULT_URL_ENV = "REDIS_URL";

const asBulk = (reply: Reply): string | null =>
  typeof reply === "string" ? reply : null;

const send = (
  connection: Connection,
  command: string,
  args: readonly Arg[] = [],
): Promise<Reply> => Effect.runPromise(connection.send(command, args));

const connections = new Map<string, Promise<Connection>>();

const open = (url: string): Promise<Connection> => {
  const existing = connections.get(url);
  if (existing) return existing;
  const scope = Scope.makeUnsafe();
  const created = Effect.runPromise(
    connect(url).pipe(Effect.provide(Layer.succeed(Scope.Scope, scope))),
  );
  connections.set(url, created);
  created.catch(() => connections.delete(url));
  return created;
};

const redisStore = (connection: Connection): DataCacheStore => ({
  async getText(key) {
    return asBulk(await send(connection, "GET", [key])) ?? undefined;
  },
  async putText(key, value, ttlMs) {
    const args: Arg[] =
      ttlMs !== undefined && ttlMs > 0
        ? [key, value, "PX", ttlMs]
        : [key, value];
    await send(connection, "SET", args);
  },
  async delete(key) {
    await send(connection, "DEL", [key]);
  },
});

const createRedisDataCacheAdapter = ({
  env,
  options,
}: {
  env?: Record<string, unknown>;
  options?: RedisAdapterOptions;
}) => {
  const urlEnv = options?.urlEnv ?? DEFAULT_URL_ENV;
  const url = readEnvString(env, urlEnv);
  if (url === undefined) {
    throw new Error(
      `[vinext] The Redis data cache adapter requires \`${urlEnv}\` in the process environment.`,
    );
  }
  let handler: ReturnType<typeof makeDataCacheHandler> | undefined;
  const ready = open(url).then(async (connection) => {
    const store = redisStore(connection);
    await seedStoreFromPrerenderLogged(store, "Redis");
    handler = makeDataCacheHandler(store, options);
    return handler;
  });
  return {
    async get(key: string, ctx?: Record<string, unknown>) {
      return (handler ?? (await ready)).get(key, ctx);
    },
    async set(
      key: string,
      data: Record<string, unknown> | null,
      ctx?: Record<string, unknown>,
    ) {
      return (handler ?? (await ready)).set(key, data, ctx);
    },
    async revalidateTag(tags: string | Array<string>) {
      return (handler ?? (await ready)).revalidateTag(tags);
    },
    resetRequestCache() {
      handler?.resetRequestCache();
    },
  };
};

export default createRedisDataCacheAdapter;
