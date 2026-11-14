# @alchemy.run/fly

Fly.io for [Alchemy](https://alchemy.run). Run Effect programs as Fly Services and Machines, next to Managed Postgres, Redis, Tigris buckets, and volumes, all in one TypeScript program.

```sh
npm install alchemy @alchemy.run/fly effect
```

A Service that counts visits in Redis:

```typescript
// src/api.ts
import * as Fly from "@alchemy.run/fly";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Cache = Fly.Redis("Cache");

export default class Api extends Fly.Service<Api>()(
  "Api",
  { main: import.meta.url, region: "iad", port: 3000 },
  Effect.gen(function* () {
    const cache = yield* Fly.ReadWriteRedis(Cache);

    return {
      fetch: Effect.gen(function* () {
        const visits = yield* cache.incr("visits");
        return yield* HttpServerResponse.json({ visits });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Fly.ReadWriteRedisHttp)),
) {}
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Fly from "@alchemy.run/fly";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

`alchemy deploy` builds the image, creates the app and its Machines, and provisions Redis. You never write a Dockerfile or a `fly.toml`.

## Learn more

- [Fly.io on alchemy.run](https://alchemy.run/fly)
- [Setup](https://alchemy.run/fly/setup)
- [Tutorial](https://alchemy.run/fly/tutorial/part-1)
- [API reference](https://alchemy.run/providers)
