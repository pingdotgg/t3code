# @effect/sql-pglite

An Effect SQL client for [PGlite](https://pglite.dev), a WASM build of PostgreSQL that runs in the browser, Node.js, and Bun.

## Installation

```sh
npm install effect@rc @effect/sql-pglite@rc
```

## LISTEN / NOTIFY

`listen` is a scoped subscription that returns after the listener is installed.
It exposes notifications through a queue and keeps the subscription active for
the surrounding scope:

```ts
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Queue } from "effect"

const program = Effect.gen(function*() {
  const sql = yield* PgliteClient.PgliteClient
  const notifications = yield* sql.listen("events")

  yield* sql.notify("events", "ready")
  return yield* Queue.take(notifications)
})
```

## Documentation

- [Effect website](https://effect.website)
- [API reference](https://effect.website/docs/v4/api/sql-pglite)
