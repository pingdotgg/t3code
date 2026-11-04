# @alchemy.run/redis

The Redis client behind [Alchemy](https://alchemy.run)'s Redis bindings. A dependency-free RESP client whose commands are Effects with typed errors. It connects over TCP or TLS on Node and Bun.

```sh
npm install alchemy @alchemy.run/redis effect
```

You usually get this client from a binding. `Fly.ReadWriteRedis` and `Railway.ReadWriteRedis` connect it to the Redis they deploy:

```typescript
// src/api.ts
import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Site = Railway.Project("Site");
export const Cache = Railway.Redis("Cache", { project: Site });

export default class Api extends Railway.Service<Api>()(
  "Api",
  { project: Site, main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const cache = yield* Railway.ReadWriteRedis(Cache);

    return {
      fetch: Effect.gen(function* () {
        const visits = yield* cache.incr("visits");
        return yield* HttpServerResponse.json({ visits });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Railway.ReadWriteRedisHttp)),
) {}
```

Point it at any other Redis by URL:

```typescript
// src/cache.ts
import * as Redis from "@alchemy.run/redis";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const url = Config.String("REDIS_URL").pipe(
  Effect.mapError(() => new Redis.UrlMissing({ name: "cache" })),
);

export const cache = Redis.makeReadWrite(url);

export const program = Effect.gen(function* () {
  yield* cache.set("greeting", "hello", { ex: 60 });
  return yield* cache.get("greeting");
});
```

## Learn more

- [Redis on Fly.io](https://alchemy.run/fly/data/redis)
- [Redis on Railway](https://alchemy.run/railway/data/redis)
- [Alchemy](https://alchemy.run)
