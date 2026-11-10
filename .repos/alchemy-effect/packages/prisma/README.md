# @alchemy.run/prisma

Prisma Postgres and Prisma Compute for [Alchemy](https://alchemy.run). Declare projects, databases, connections, and deployed apps in the same TypeScript program as the code that uses them, with a zero-config local database in `alchemy dev`.

```sh
npm install alchemy @alchemy.run/prisma @alchemy.run/sql effect
```

A Postgres database and an app on Prisma Compute that queries it:

```typescript
// src/api.ts
import * as Prisma from "@alchemy.run/prisma";
import * as SQL from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Project = Prisma.Project("Project", { createDatabase: false });

export const Connection = Effect.gen(function* () {
  const database = yield* Prisma.Postgres("Db", { project: yield* Project });
  return yield* Prisma.Connection("Api", { database });
});

export default class Api extends Prisma.Compute<Api>()(
  "Api",
  Effect.gen(function* () {
    return { project: yield* Project, main: import.meta.filename, port: 3000 };
  }),
  Effect.gen(function* () {
    const db = yield* Prisma.Connect(yield* Connection);
    const sql = yield* SQL.Postgres({ url: db.databaseUrl });

    return {
      fetch: Effect.gen(function* () {
        const users = yield* sql`SELECT * FROM users`;
        return yield* HttpServerResponse.json(users);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Prisma.ConnectBinding)),
) {}
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Prisma from "@alchemy.run/prisma";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Prisma.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

## Learn more

- [Prisma on alchemy.run](https://alchemy.run/prisma)
- [Setup](https://alchemy.run/prisma/setup)
- [Tutorial](https://alchemy.run/prisma/tutorial/part-1)
- [Prisma ORM with Alchemy](https://alchemy.run/sql/prisma/postgres)
