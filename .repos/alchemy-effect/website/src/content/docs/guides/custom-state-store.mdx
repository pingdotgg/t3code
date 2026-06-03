---
title: Writing a Custom State Store
description: Build a Postgres-backed Alchemy state store step by step — implement the StateService interface, plug it into a stack, and test it end-to-end.
sidebar:
  order: 7
---

A state store is just an Effect `Layer` that provides Alchemy's
`State` service. The built-in stores (`localState()` on disk,
`Cloudflare.state()` on Cloudflare) cover most cases — but if you
already run Postgres, S3, Redis, or DynamoDB, you can back state
with that instead.

This guide builds a Postgres-backed state store from scratch. By the
end you'll have a `postgresState()` layer you can drop into any
`Alchemy.Stack`, and a test that round-trips a resource through it.

See [State Store](/concepts/state-store) for an overview of what
state Alchemy persists and why.

## Scaffold the layer

A state store is a `Layer.Layer<State, never, R>` where `R` is any
ambient services your implementation needs. The `State` service does
**not** hold a `StateService` directly — it holds an
`Effect<StateService>` that lazily builds one:

```typescript
class State extends Context.Service<State, Effect.Effect<StateService>>()(
  "alchemy/State",
) {}
```

This indirection matters. Commands like `alchemy login` provide the
state layer but never touch state, so a store must not connect to its
backend (open a DB connection, deploy a worker, prompt for
credentials) just because the layer was built. Wrapping the builder
in [`Effect.cached`](https://effect.website/docs/getting-started/control-flow/#caching)
**defers** initialization until the first `yield* State` and **caches**
it so subsequent accesses reuse the same `StateService`.

Start with an empty `StateService` so the types compile, then fill it
in one method at a time.

Create `src/postgres-state.ts`:

```typescript
// src/postgres-state.ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { State, type StateService } from "alchemy/State";

export interface PostgresStateProps {
  connectionString: string;
}

export const postgresState = (props: PostgresStateProps) =>
  // `Effect.cached` returns an `Effect<Effect<StateService>>`; yielding
  // it inside `Layer.effect` hands `State` the deferred, memoized
  // initializer. The body below only runs on first `yield* State`.
  Layer.effect(State, Effect.cached(makePostgresState(props)));

const makePostgresState = (_props: PostgresStateProps) =>
  Effect.gen(function* () {
    const service: StateService = {
      listStacks: () => Effect.die("not implemented"),
      listStages: () => Effect.die("not implemented"),
      list: () => Effect.die("not implemented"),
      get: () => Effect.die("not implemented"),
      set: () => Effect.die("not implemented"),
      delete: () => Effect.die("not implemented"),
      deleteStack: () => Effect.die("not implemented"),
      getReplacedResources: () => Effect.die("not implemented"),
    };
    return service;
  });
```

You now have a layer Alchemy will accept — it just dies on every
operation. Next we'll wire up the database.

## Connect to Postgres

We'll use the [`postgres`](https://github.com/porsager/postgres)
package and create one schema with a single `state` table keyed by
`(stack, stage, fqn)`. Acquire the connection with `Effect.acquireRelease`
so it's released when the stack tears down — this requires a `Scope`,
so the layer becomes `Layer.scoped`.

Because initialization is deferred, capture the scope at layer-build
time and provide it to the cached initializer, so the connection's
release is still tied to the stack's lifetime even though it opens
lazily on first use:

```diff lang="typescript"
// src/postgres-state.ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
+import * as Scope from "effect/Scope";
+import postgres from "postgres";
import { State, type StateService } from "alchemy/State";

export interface PostgresStateProps {
  connectionString: string;
}

export const postgresState = (props: PostgresStateProps) =>
-  Layer.effect(State, Effect.cached(makePostgresState(props)));
+  Layer.scoped(
+    State,
+    Effect.gen(function* () {
+      // Capture the layer's scope so the deferred initializer can
+      // register the connection's release on it.
+      const context = yield* Effect.context<Scope.Scope>();
+      const make = makePostgresState(props).pipe(
+        Effect.provideContext(context),
+      );
+      return yield* Effect.cached(make);
+    }),
+  );

const makePostgresState = (props: PostgresStateProps) =>
  Effect.gen(function* () {
+    const sql = yield* Effect.acquireRelease(
+      Effect.sync(() => postgres(props.connectionString)),
+      (sql) => Effect.promise(() => sql.end()),
+    );
+
+    yield* Effect.promise(
+      () => sql`
+        create table if not exists alchemy_state (
+          stack text not null,
+          stage text not null,
+          fqn   text not null,
+          value jsonb not null,
+          primary key (stack, stage, fqn)
+        )
+      `,
+    );
+
    const service: StateService = {
      listStacks: () => Effect.die("not implemented"),
      // ...
    };
    return service;
  });
```

## Implement `set` and `get`

These are the two hot-path methods Alchemy calls during every
deploy.

A few things to know before writing them:

- **Use `encodeState` / `reviveState`** from `alchemy/State` when
  serializing. They handle `Secret` values, `Date`s, and other
  non-JSON types in `ResourceState`.
- **Return `undefined` from `get`** for missing rows — don't error.
  `StateStoreError` is for transport failures only.
- **Map thrown errors** through `StateStoreError` so Alchemy can
  surface them with context.

```diff lang="typescript"
// src/postgres-state.ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import postgres from "postgres";
-import { State, type StateService } from "alchemy/State";
+import {
+  State,
+  StateStoreError,
+  encodeState,
+  reviveState,
+  type StateService,
+} from "alchemy/State";

// ...

const makePostgresState = (props: PostgresStateProps) =>
  Effect.gen(function* () {
    const sql = yield* Effect.acquireRelease(
      Effect.sync(() => postgres(props.connectionString)),
      (sql) => Effect.promise(() => sql.end()),
    );

    // ... create table ...

+    const run = <A>(thunk: () => Promise<A>) =>
+      Effect.tryPromise({
+        try: thunk,
+        catch: (cause) =>
+          new StateStoreError({
+            message: cause instanceof Error ? cause.message : String(cause),
+            cause: cause instanceof Error ? cause : undefined,
+          }),
+      });
+
    const service: StateService = {
      listStacks: () => Effect.die("not implemented"),
      listStages: () => Effect.die("not implemented"),
      list: () => Effect.die("not implemented"),
-      get: () => Effect.die("not implemented"),
-      set: () => Effect.die("not implemented"),
+      get: ({ stack, stage, fqn }) =>
+        run(
+          () => sql<{ value: string }[]>`
+            select value::text from alchemy_state
+            where stack = ${stack} and stage = ${stage} and fqn = ${fqn}
+          `,
+        ).pipe(
+          Effect.map((rows) =>
+            rows.length === 0
+              ? undefined
+              : JSON.parse(rows[0].value, reviveState),
+          ),
+        ),
+
+      set: ({ stack, stage, fqn, value }) =>
+        run(
+          () => sql`
+            insert into alchemy_state (stack, stage, fqn, value)
+            values (${stack}, ${stage}, ${fqn}, ${sql.json(encodeState(value))})
+            on conflict (stack, stage, fqn)
+            do update set value = excluded.value
+          `,
+        ).pipe(Effect.as(value)),
+
      delete: () => Effect.die("not implemented"),
      deleteStack: () => Effect.die("not implemented"),
      getReplacedResources: () => Effect.die("not implemented"),
    };
    return service;
  });
```

## Implement `list`, `listStacks`, `listStages`

These power `alchemy destroy`, drift detection, and the CLI's
inspection commands. They're straightforward `select distinct`
queries:

```diff lang="typescript"
const service: StateService = {
-  listStacks: () => Effect.die("not implemented"),
-  listStages: () => Effect.die("not implemented"),
-  list: () => Effect.die("not implemented"),
+  listStacks: () =>
+    run(() => sql<{ stack: string }[]>`
+      select distinct stack from alchemy_state order by stack
+    `).pipe(Effect.map((rows) => rows.map((r) => r.stack))),
+
+  listStages: (stack) =>
+    run(() => sql<{ stage: string }[]>`
+      select distinct stage from alchemy_state
+      where stack = ${stack} order by stage
+    `).pipe(Effect.map((rows) => rows.map((r) => r.stage))),
+
+  list: ({ stack, stage }) =>
+    run(() => sql<{ fqn: string }[]>`
+      select fqn from alchemy_state
+      where stack = ${stack} and stage = ${stage} order by fqn
+    `).pipe(Effect.map((rows) => rows.map((r) => r.fqn))),
+
  // get / set unchanged ...
  delete: () => Effect.die("not implemented"),
  deleteStack: () => Effect.die("not implemented"),
  getReplacedResources: () => Effect.die("not implemented"),
};
```

## Implement `delete` and `deleteStack`

`deleteStack` deletes the entire stack when `stage` is omitted, or
just one stage when provided:

```diff lang="typescript"
const service: StateService = {
  // listStacks / listStages / list / get / set unchanged ...

-  delete: () => Effect.die("not implemented"),
-  deleteStack: () => Effect.die("not implemented"),
+  delete: ({ stack, stage, fqn }) =>
+    run(() => sql`
+      delete from alchemy_state
+      where stack = ${stack} and stage = ${stage} and fqn = ${fqn}
+    `).pipe(Effect.asVoid),
+
+  deleteStack: ({ stack, stage }) =>
+    run(() =>
+      stage === undefined
+        ? sql`delete from alchemy_state where stack = ${stack}`
+        : sql`delete from alchemy_state where stack = ${stack} and stage = ${stage}`,
+    ).pipe(Effect.asVoid),
+
  getReplacedResources: () => Effect.die("not implemented"),
};
```

## Implement `getReplacedResources`

When Alchemy replaces a resource, the old one is kept in the store
with `status: "replaced"` until its destroy operation succeeds.
`getReplacedResources` returns that backlog so the next deploy can
finish cleanup.

You can implement this on top of `list` + `get`, but it's cheaper to
push the filter into Postgres:

```diff lang="typescript"
const service: StateService = {
  // ...

-  getReplacedResources: () => Effect.die("not implemented"),
+  getReplacedResources: ({ stack, stage }) =>
+    run(
+      () => sql<{ value: string }[]>`
+        select value::text from alchemy_state
+        where stack = ${stack}
+          and stage = ${stage}
+          and value->>'status' = 'replaced'
+      `,
+    ).pipe(
+      Effect.map((rows) =>
+        rows.map((r) => JSON.parse(r.value, reviveState)),
+      ),
+    ),
};
```

## Plug it into a stack

Pass your layer as the `state` option, exactly like the built-in
stores:

```diff lang="typescript"
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
+import { postgresState } from "./src/postgres-state.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Cloudflare.providers(),
-    state: Cloudflare.state(),
+    state: postgresState({
+      connectionString: process.env.DATABASE_URL!,
+    }),
  },
  Effect.gen(function* () {
    // resources...
  }),
);
```

## Test the round-trip

Spin up a throwaway Postgres (Docker, Testcontainers, or a local
instance) and verify a resource round-trips through your store. Note
the double `yield*`: the first resolves the `State` service to its
`Effect<StateService>` initializer, the second runs it to get the
`StateService`.

```typescript
// test/postgres-state.test.ts
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { State } from "alchemy/State";
import { postgresState } from "../src/postgres-state.ts";

const layer = postgresState({
  connectionString: process.env.TEST_DATABASE_URL!,
});

describe("postgresState", () => {
  it("round-trips a resource", () =>
    Effect.gen(function* () {
      const state = yield* yield* State;

      yield* state.set({
        stack: "Test",
        stage: "dev",
        fqn: "Bucket",
        value: {
          id: "Bucket",
          fqn: "Bucket",
          status: "created",
          kind: "Cloudflare.R2Bucket",
          props: { name: "my-bucket" },
          output: { name: "my-bucket" },
        } as any,
      });

      const got = yield* state.get({
        stack: "Test",
        stage: "dev",
        fqn: "Bucket",
      });
      expect(got?.id).toBe("Bucket");

      const fqns = yield* state.list({ stack: "Test", stage: "dev" });
      expect(fqns).toContain("Bucket");

      yield* state.deleteStack({ stack: "Test" });
      const after = yield* state.list({ stack: "Test", stage: "dev" });
      expect(after).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise));
});
```

For end-to-end testing of a real stack against your store, see the
[Testing](/concepts/testing) reference.

## Things to know

A few details that aren't obvious from the interface but matter in
production:

- **FQNs are arbitrary strings** containing `/` and other
  characters. Postgres handles them fine as parameterized values,
  but if your backend uses FQNs in keys (filenames, S3 keys, Redis
  keys) you'll need to escape them — Alchemy ships
  `encodeFqn` / `decodeFqn` from `alchemy/FQN`.
- **Concurrent writes happen** during a deploy as Alchemy applies
  resources in parallel. Your backend needs row-level (or
  equivalent) consistency on the `(stack, stage, fqn)` key.
- **State persists between deploys**, so schema changes to
  `ResourceState` are effectively migrations. Be conservative with
  the encoded shape, and use `reviveState` so future Alchemy
  versions can deserialize what you wrote.

## Reference implementations

If you'd rather start from one of the built-ins:

- [`LocalState.ts`](https://github.com/sam-goodwin/alchemy-effect/blob/main/packages/alchemy/src/State/LocalState.ts) — filesystem-backed, the simplest end-to-end example
- [`HttpStateStore.ts`](https://github.com/sam-goodwin/alchemy-effect/blob/main/packages/alchemy/src/State/HttpStateStore.ts) — HTTP client against the Alchemy state API
- [`InMemoryState.ts`](https://github.com/sam-goodwin/alchemy-effect/blob/main/packages/alchemy/src/State/InMemoryState.ts) — minimal in-process map, useful as a template
