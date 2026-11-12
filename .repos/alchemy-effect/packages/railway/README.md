# @alchemy.run/railway

Railway for [Alchemy](https://alchemy.run). Run Effect programs as Railway Services, next to Postgres, MySQL, Redis, Mongo, volumes, and buckets, all in one TypeScript program.

```sh
npm install alchemy @alchemy.run/railway @alchemy.run/sql effect
```

A Project with Postgres and a Service that queries it:

```typescript
// src/api.ts
import * as Railway from "@alchemy.run/railway";
import * as SQL from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Site = Railway.Project("Site");
export const Db = Railway.Postgres("Db", { project: Site });

export default class Api extends Railway.Service<Api>()(
  "Api",
  { project: Site, main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const db = yield* Railway.ConnectPostgres(Db);
    const sql = yield* SQL.Postgres({ url: db.connectionString });

    return {
      fetch: Effect.gen(function* () {
        const users = yield* sql`SELECT * FROM users`;
        return yield* HttpServerResponse.json(users);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Railway.ConnectPostgresHttp)),
) {}
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

## Learn more

- [Railway on alchemy.run](https://alchemy.run/railway)
- [Setup](https://alchemy.run/railway/setup)
- [Tutorial](https://alchemy.run/railway/tutorial/part-1)
- [API reference](https://alchemy.run/providers)
