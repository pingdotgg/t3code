import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const REDIS_PORT = 3000;
export const REDIS_KEY = "alchemy-marker";
export const REDIS_VALUE = "hello-from-redis";

export const RedisSite = Fly.App("RedisSite", {
  enableSubdomains: true,
});

export const Cache = Fly.Redis("Cache");

export const RedisIp = Fly.IpAssignment("Shared", {
  app: RedisSite,
  type: "shared_v4",
});

/**
 * HTTP Service that PINGs Redis and round-trips a key via
 * {@link Fly.ReadWriteRedis}.
 */
export default class RedisApi extends Fly.Service<RedisApi>()(
  "RedisApi",
  {
    app: RedisSite,
    main: import.meta.url,
    region: "iad",
    port: REDIS_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const cache = yield* Fly.ReadWriteRedis(Cache);
    const resource = yield* Cache;
    const url = yield* resource.url;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;

        if (path === "/health" || path === "/") {
          const pong = yield* cache.ping().pipe(
            Effect.map((body) => /pong/i.test(body)),
            Effect.orElseSucceed(() => false),
          );
          const resolvedUrl = yield* url;
          return yield* HttpServerResponse.json({
            pong,
            hasOutputUrl:
              resolvedUrl !== undefined &&
              Redacted.isRedacted(resolvedUrl) &&
              Redacted.value(resolvedUrl).length > 0,
          });
        }

        if (path === "/set") {
          yield* cache.set(REDIS_KEY, REDIS_VALUE).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true, key: REDIS_KEY });
        }

        if (path === "/get") {
          const value = yield* cache.get(REDIS_KEY).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            ok: value === REDIS_VALUE,
            value,
          });
        }

        return yield* HttpServerResponse.json({ ok: false }, { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Fly.ReadWriteRedisHttp)),
) {}
