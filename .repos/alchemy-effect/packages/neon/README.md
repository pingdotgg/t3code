# @alchemy.run/neon

Neon for [Alchemy](https://alchemy.run). Declare Postgres projects and branches, Functions, object storage, Auth, and websites in the same TypeScript program as the code that uses them.

```sh
npm install alchemy @alchemy.run/neon @alchemy.run/sql effect
```

A Neon Function on its own branch, with migrations applied on deploy:

```typescript
// src/api.ts
import * as Neon from "@alchemy.run/neon";
import * as SQL from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Branch = Effect.gen(function* () {
  const project = yield* Neon.Project("Project", { region: "aws-us-east-2" });
  return yield* Neon.Branch("Main", { project, migrations: "./migrations" });
});

export default class Api extends Neon.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    return { branch: yield* Branch, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const db = yield* Neon.Connect(yield* Branch);
    const sql = yield* SQL.Postgres({ url: db.connectionString });

    return {
      fetch: Effect.gen(function* () {
        const notes = yield* sql`SELECT * FROM notes`;
        return yield* HttpServerResponse.json(notes);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Neon.ConnectHttp)),
) {}
```

The Stack deploys it:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Neon from "@alchemy.run/neon";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Neon.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

## Learn more

- [Neon on alchemy.run](https://alchemy.run/neon)
- [Setup](https://alchemy.run/neon/setup)
- [Tutorial](https://alchemy.run/neon/tutorial)
- [API reference](https://alchemy.run/providers)
