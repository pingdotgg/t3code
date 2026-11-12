# @alchemy.run/drizzle

[Drizzle ORM](https://orm.drizzle.team) for [Alchemy](https://alchemy.run). Generate migrations from your schema at deploy time, and query D1, Postgres, MySQL, or libSQL from a Worker or Lambda with a typed Effect client.

```sh
npm install alchemy @alchemy.run/drizzle @alchemy.run/cloudflare drizzle-orm drizzle-kit effect
```

A schema:

```typescript
// src/schema.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const Users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
});
```

A D1 database whose migrations are generated from that schema on deploy, and a Worker that queries it:

```typescript
// src/api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Users } from "./schema.ts";

export const Database = Effect.gen(function* () {
  const schema = yield* Drizzle.Schema("Schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
    dialect: "sqlite",
  });
  return yield* Cloudflare.D1.Database("Db", { migrations: schema });
});

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1.QueryDatabase(yield* Database);
    const db = yield* Drizzle.D1(d1);

    return {
      fetch: Effect.gen(function* () {
        const users = yield* db.select().from(Users);
        return yield* HttpServerResponse.json({ users });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

`Drizzle.Postgres`, `Drizzle.MySQL`, and `Drizzle.LibSQL` work the same way for the other databases.

## Learn more

- [Drizzle with D1](https://alchemy.run/sql/drizzle/d1)
- [Drizzle with Postgres](https://alchemy.run/sql/drizzle/postgres)
- [Drizzle migrations](https://alchemy.run/sql/drizzle/migrations)
- [SQL on alchemy.run](https://alchemy.run/sql)
