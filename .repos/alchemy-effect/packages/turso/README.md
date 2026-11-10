# @alchemy.run/turso

Turso for [Alchemy](https://alchemy.run). Declare SQLite databases, groups, and tokens in the same TypeScript program as the Workers that query them.

```sh
npm install alchemy @alchemy.run/turso @alchemy.run/cloudflare @alchemy.run/sql @effect/sql-libsql effect
```

A database with migrations, queried from a Cloudflare Worker:

```typescript
// src/worker.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SQL from "@alchemy.run/sql/SQLite";
import * as Turso from "@alchemy.run/turso";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Db = Effect.gen(function* () {
  const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
  return yield* Turso.Database("Db", {
    group: group.name,
    migrations: "./migrations",
  });
});

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    // The Worker gets the database URL and its own scoped token.
    const sql = yield* SQL.LibSQL(yield* Turso.Connect(Db));

    return {
      fetch: Effect.gen(function* () {
        const notes = yield* sql`SELECT * FROM notes`;
        return yield* HttpServerResponse.json(notes);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Turso.ConnectHttp)),
);
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Turso from "@alchemy.run/turso";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Turso.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
```

Turso databases are cheap, so a Worker can also create one per tenant with `Turso.ManageDatabases`.

## Learn more

- [Turso on alchemy.run](https://alchemy.run/turso)
- [Setup](https://alchemy.run/turso/setup)
- [Tutorial](https://alchemy.run/turso/tutorial/part-1)
- [Database per tenant](https://alchemy.run/turso/database-per-tenant)
