---
title: Action
description: A node in the dependency graph that runs an Effect during apply when its inputs change.
sidebar:
  order: 2
---

An **Action** is a node in the stack's dependency graph that runs an
arbitrary Effect during `apply`. Unlike a [Resource](/concepts/resource), it has
no provider lifecycle — no replace, no read, no delete. The engine just
diffs the resolved input against the last persisted hash and either runs
the body or skips it.

Actions are useful for one-off deploy-time work that needs to be
reproducible and dependency-aware: seeding a database, posting a
release notification, generating an artifact and uploading it,
invalidating a CDN cache, running a migration check.

## Declaring an Action

Define an Action with its type name and a body, then call it inside a
stack to register an instance. `yield*` returns `Output<Out>` ready to
feed into downstream nodes:

```typescript
const Sync = Action("Sync", Effect.fn(function* (input: { table: string }) {
  yield* Effect.log(`syncing ${input.table}`);
  return { rows: 42 };
}));

// In a stack — default form uses the Type as the LogicalId:
const rows = yield* Sync({ table: bucket.name });
//          ^ Output<{ rows: number }>
rows.rows // Output<number>
```

The body Effect receives the **resolved** input — any
[Output](/concepts/outputs) references in the input are evaluated against the
current tracker before the body runs.

### Init constructor (pulling in dependencies)

Pass an Effect that yields the runner instead of the runner itself.
The init Effect can `yield*` services, and those dependencies surface
as `Req` on the call site:

```typescript
const Sync = Action("Sync", Effect.gen(function* () {
  const db = yield* Database;
  const logger = yield* Logger;
  return Effect.fn(function* (input: { table: string }) {
    yield* logger.info(`syncing ${input.table}`);
    return { rows: yield* db.count(input.table) };
  });
}));

// `yield* Sync({...})` now requires `Database | Logger | Stack`.
```

The init runs at most once per process and the resolved runner is
reused across every instance and re-run.

### Multiple instances

Pass an explicit logical id to register more than one instance of the
same Action definition:

```typescript
const nightly = yield* Sync("nightly", { table: usersBucket.name });
const hourly  = yield* Sync("hourly",  { table: eventsBucket.name });
```

### Tagged form (service + layer)

When you want to split the contract from the implementation — e.g. for
testing or to keep stack code declarative — use the class form. It
mirrors [Platform](/concepts/platform):

```typescript
export class Sync extends Action<Sync, { table: string }, { rows: number }>()("Sync") {}

export const SyncLive = Sync.make(
  Effect.gen(function* () {
    const db = yield* Database;
    return Effect.fn(function* (input) {
      return { rows: yield* db.count(input.table) };
    });
  }),
);

// In a stack:
const rows = yield* Sync({ table: bucket.name });
//          ^ requires `Sync` — add `SyncLive` to the stack's providers.
```

`.make(...)` accepts either a direct runner or an init Effect.

## Lifecycle

An Action has only two terminal states:

| Action | Symbol | When |
| --- | --- | --- |
| **run**  | `λ` | First time, or `inputHash` differs from the last persisted run, or `--force` is set |
| **skip** | `·` | Persisted `inputHash` matches the newly resolved input |

There is no `replace` and no `delete`. When an Action is removed from the
stack, its persisted state is dropped without the body being invoked.

### Input hashing

The Action's input is JSON-serialized and SHA-256 hashed after upstream
Outputs are resolved. The hash is persisted alongside the result; on
the next plan, a new hash that matches means "skip", a new hash that
differs means "run".

### Forcing a re-run

```sh
alchemy deploy --force
```

`--force` flips every `skip` to `run` at plan time, including actions.

### Dependencies

Actions live in the same FQN namespace as Resources. They can:

- Take Resource outputs as input (`{ table: bucket.name }`)
- Be referenced by Resources via `action.output` (downstream resource
  waits for the action before reconciling)
- Reference other Actions

Cycles are rejected at plan time just like resource cycles.

## What Actions are not

- **Not a Resource.** No `diff`/`read`/`reconcile`/`delete`. If you
  need lifecycle management of a cloud entity, model it as a Resource.
- **Not a runtime function.** An Action runs at deploy time. To call code
  from a deployed Worker/Lambda, use a [Platform](/concepts/platform).
- **Not idempotent for free.** The engine guarantees the body runs
  only when inputs change, but the body itself must tolerate retries
  on apply restart (its `running` state is persisted but not its
  side effects).
