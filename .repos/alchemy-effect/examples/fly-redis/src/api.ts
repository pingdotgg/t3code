import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT, Cache, Site } from "./shared.ts";

/**
 * HTTP Service that PINGs Upstash Redis via {@link Fly.ReadRedis}.
 */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const cache = yield* Fly.ReadRedis(Cache);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        const pong = yield* cache.ping().pipe(
          Effect.map((body) => /pong/i.test(body)),
          Effect.orElseSucceed(() => false),
        );
        if (path === "/health") {
          return yield* HttpServerResponse.json({ ok: pong });
        }
        return yield* HttpServerResponse.json({ pong });
      }),
    };
  }).pipe(Effect.provide(Fly.ReadRedisHttp)),
) {}
