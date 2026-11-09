# @alchemy.run/planetscale

PlanetScale for [Alchemy](https://alchemy.run). Declare serverless MySQL and Postgres databases, branches, and roles in the same TypeScript program as the code that uses them.

```sh
npm install alchemy @alchemy.run/planetscale @alchemy.run/cloudflare @alchemy.run/sql effect
```

A Postgres database, a branch with migrations, and a role, reached from a Cloudflare Worker through Hyperdrive:

```typescript
// src/db.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Effect from "effect/Effect";

export const Hyperdrive = Effect.gen(function* () {
  const database = yield* Planetscale.PostgresDatabase("Db", {
    region: { slug: "us-east" },
    clusterSize: "PS_10",
  });
  const branch = yield* Planetscale.PostgresBranch("Main", {
    database,
    migrations: "./migrations",
  });
  const role = yield* Planetscale.PostgresRole("App", {
    database,
    branch,
    inheritedRoles: ["postgres"],
  });
  return yield* Cloudflare.Hyperdrive.Connection("Hyperdrive", {
    origin: role.origin,
  });
});
```

```typescript
// src/worker.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SQL from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Hyperdrive } from "./db.ts";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* Hyperdrive);
    const sql = yield* SQL.Postgres({ url: hyperdrive.connectionString });

    return {
      fetch: Effect.gen(function* () {
        const users = yield* sql`SELECT * FROM users`;
        return yield* HttpServerResponse.json(users);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
);
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Planetscale.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
```

## Learn more

- [PlanetScale on alchemy.run](https://alchemy.run/planetscale)
- [Setup](https://alchemy.run/planetscale/setup)
- [API reference](https://alchemy.run/providers)
