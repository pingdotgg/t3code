import * as Railway from "@/Railway";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Partition } from "./suite-env.ts";
import { Cache, REDIS_KEY, REDIS_VALUE, Site } from "./redis-shared.ts";

export { Cache, REDIS_KEY, REDIS_VALUE, Site };

export const REDIS_PORT = 3000;

/**
 * HTTP Service that PINGs Redis and round-trips a key via
 * {@link Railway.ReadWriteRedis}.
 */
export default class RedisApi extends Railway.Service<RedisApi>()(
  "RedisApi",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
    port: REDIS_PORT,
  },
  Effect.gen(function* () {
    const cache = yield* Railway.ReadWriteRedis(Cache);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;

        if (path === "/health" || path === "/") {
          const body = yield* cache.ping();
          return yield* HttpServerResponse.json({ pong: /pong/i.test(body) });
        }

        if (path === "/set") {
          yield* cache.set(REDIS_KEY, REDIS_VALUE);
          return yield* HttpServerResponse.json({ ok: true, key: REDIS_KEY });
        }

        if (path === "/get") {
          const value = yield* cache.get(REDIS_KEY);
          return yield* HttpServerResponse.json({
            ok: value === REDIS_VALUE,
            value,
          });
        }

        return yield* HttpServerResponse.json({ ok: false }, { status: 404 });
      }).pipe(
        Effect.catch((error) =>
          HttpServerResponse.json(
            {
              ok: false,
              error: String(error),
              cause:
                error !== null && typeof error === "object" && "cause" in error
                  ? String((error as { cause: unknown }).cause)
                  : undefined,
            },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Railway.ReadWriteRedisHttp)),
) {}
