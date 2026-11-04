# @alchemy.run/sql

SQL for [Alchemy](https://alchemy.run). Typed Effect SQL clients for Postgres, MySQL, and SQLite (libSQL), deploy-time migrations for every database resource, and a Postgres state store.

```sh
npm install alchemy @alchemy.run/sql @effect/sql-pg pg effect
```

Query Postgres from any runtime. The connection opens on the first query of a request and closes when the request ends, so nothing connects at deploy time:

```typescript
// src/worker.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SQL from "@alchemy.run/sql/Postgres";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sql = yield* SQL.Postgres({ url: Config.Redacted("DATABASE_URL") });

    return {
      fetch: Effect.gen(function* () {
        const users = yield* sql`SELECT * FROM users`;
        return yield* HttpServerResponse.json(users);
      }).pipe(Effect.orDie),
    };
  }),
);
```

The same shape works for MySQL and SQLite:

| Database | Import | Driver |
| --- | --- | --- |
| Postgres | `@alchemy.run/sql/Postgres` | `@effect/sql-pg`, `pg` |
| MySQL | `@alchemy.run/sql/MySQL` | `@effect/sql-mysql2`, `mysql2` |
| SQLite (libSQL, Turso, local files) | `@alchemy.run/sql/SQLite` | `@effect/sql-libsql` |

Keep Alchemy's own state in a Postgres database you already run:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import { postgresState } from "@alchemy.run/sql/PostgresState";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
    state: postgresState({ url: Config.Redacted("STATE_DATABASE_URL") }),
  },
  Effect.gen(function* () {
    return {};
  }),
);
```

## Learn more

- [SQL on alchemy.run](https://alchemy.run/sql)
- [Effect SQL with Postgres](https://alchemy.run/sql/effect-sql/postgres)
- [Migrations](https://alchemy.run/sql/effect-sql/migrations)
- [State stores](https://alchemy.run/state-store)
