import * as Fly from "@/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Site = Fly.App("Site");
export const CacheOne = Fly.Redis("CacheOne");
export const CacheTwo = Fly.Redis("CacheTwo");

export class BoundSecrets extends Fly.Service<BoundSecrets>()(
  "BoundSecrets",
  {
    app: Site,
    main: import.meta.url,
    count: 2,
    port: 3000,
    deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
    shutdown: { timeout: "10 seconds" },
    services: [
      {
        protocol: "tcp",
        internalPort: 3000,
        autostop: "off",
        ports: [{ port: 80, handlers: ["http"] }],
        checks: [
          {
            type: "http",
            port: 3000,
            path: "/ready",
            interval: "2s",
            timeout: "1s",
          },
        ],
      },
    ],
  },
  Effect.gen(function* () {
    const token = yield* Config.Redacted("ACCEPTANCE_BOUND_SECRET");
    const slot = yield* Config.String("ACCEPTANCE_CACHE");
    const cache = yield* Fly.ReadWriteRedis(
      slot === "one" ? CacheOne : CacheTwo,
    );
    const version = Redacted.value(token).endsWith("-one") ? "one" : "two";
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/ready")) {
          yield* cache.ping().pipe(Effect.orDie);
          return HttpServerResponse.text("ready");
        }
        if (request.url.startsWith("/seed")) {
          yield* cache.set("bluegreen-marker", version).pipe(Effect.orDie);
        }
        const value = yield* cache.get("bluegreen-marker").pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          config: version,
          redis: value === "one" ? "one" : value === "two" ? "two" : "empty",
        });
      }),
    };
  }).pipe(Effect.provide(Fly.ReadWriteRedisHttp)),
) {}

export default BoundSecrets;
