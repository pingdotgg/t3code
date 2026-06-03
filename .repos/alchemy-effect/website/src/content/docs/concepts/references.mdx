---
title: References
description: Read values out of another stack or stage at plan time — typed, lazy, and resolved from persisted state.
sidebar:
  order: 3
---

Stacks deploy independently. A PR-preview stage wants to share
`staging`'s expensive database instead of provisioning its own.
A frontend stack needs the URL of a backend that lives in a
different repo. A tools script wants to read prod's bucket name
without re-running prod's plan.

A **reference** points at something **already deployed**
somewhere else — a different stage, a different stack, or both —
and resolves to that thing's live attributes at plan time by
reading the persisted [state store](/concepts/state-store).

References are lazy. They don't hit any cloud API at declaration
time, and they don't drift — every plan re-reads the upstream's
persisted state, so what flows into your downstream resources is
always whatever was actually last deployed.

## Reference a resource — `Resource.ref`

The most common case: read one resource from another stage of
the same stack.

```typescript
const db = yield* Neon.Project.ref("app-db", { stage: "staging" });

db.connectionString; // Output<Redacted<string>>
```

`Neon.Project.ref("app-db", …)` returns a `Neon.Project` — the
same shape you'd get from `yield* Neon.Project("app-db", { … })`.
You can pass it anywhere a `Neon.Project` is accepted; the rest
of the graph doesn't know (or care) that it's a reference.

If `app-db` hasn't been deployed in `staging` yet, the plan
fails fast with `InvalidReferenceError` — there is no
"deploy-and-hope" path.

A common pattern is long-lived `staging` / `prod` stages owning
the expensive resources while ephemeral `pr-*` stages reference
them. See [Shared database across stages](/guides/shared-database)
for the full walkthrough.

## Cross a stack boundary

Pass `stack` to read from a completely different stack:

```typescript
const sharedBucket = yield* Storage.Bucket.ref("Assets", {
  stack: "shared-infra",
  stage: "prod",
});
```

`{ stack, stage, id }` is the full address. Anything you omit
defaults to the current stack/stage, so `MyResource.ref("foo")`
with no options is "the `foo` in this same stack and stage" —
useful for adopting a resource that another part of the program
already declared.

## Reference a whole stack — `yield* MyStack`

Sometimes one resource isn't the right unit — you want the
**outputs** the upstream stack chose to expose. Declare a typed
stack handle and `yield*` it:

```typescript
// backend/src/Stack.ts
export class Backend extends Alchemy.Stack<
  Backend,
  { url: string }
>()("Backend") {}
```

```typescript
// frontend/alchemy.run.ts
const a = yield* Backend;                // current stage
const b = yield* Backend.stage.prod;     // pinned to "prod"
const c = yield* Backend.stage["pr-42"]; // any stage name
```

- `yield* Backend` defaults to the current stage — `sam`
  frontend reads `sam` backend, `pr-42` reads `pr-42`. Use this
  when stages line up across stacks.
- `Backend.stage.<name>` pins to a specific stage. Use it when
  you need to **break** stage symmetry — e.g. a feature-branch
  frontend that must always read `prod`'s backend.

At the end of every successful `apply`, Alchemy persists
whatever the stack's effect returned as a per-stack-per-stage
**stack output** record. `yield* Backend` reads that record and
returns a proxy that turns property access into typed Outputs,
so `(yield* Backend).url` is `Output<string>`.

See [Monorepos](/guides/monorepo) for the full walkthrough.

## Escape hatches — `Output.ref` and `Output.stackRef`

When the resource constructor isn't in scope (e.g. inside a
generic helper), use the underlying `Output.ref` primitive:

```typescript
import * as Output from "alchemy/Output";

const bucket = Output.ref<typeof Bucket>("Bucket", {
  stack: "shared-infra",
  stage: "prod",
});

bucket.bucketName; // Output<string>
```

Same `{ stack, stage, id }` lookup, same `InvalidReferenceError`
failure mode. Prefer `Resource.ref` whenever you can — the
proxied attribute access is identical, and the type erases to
the resource interface instead of a bare `Output`.

Similarly, when a typed stack handle isn't in scope, `Output.stackRef`
reads the stack-output record directly:

```typescript
const backend = yield* Output.stackRef<{ url: string }>("Backend", {
  stage: "prod",
});

backend.url; // Output<string>
```

Prefer `yield* MyStack` whenever you can — it's the same lookup
with a real type binding instead of an inline shape.

## How resolution works

Every reference — resource or stack — carries a
`{ stack, stage, id }` triple:

| Field | Default when omitted |
| ----- | -------------------- |
| `stack` | The current stack's name |
| `stage` | The current stage |
| `id` | required for resource refs; equals the stack name for stack refs |

At plan time Alchemy:

1. Reads the upstream's persisted state under that triple
   (`state.get` for resource refs, `state.getOutput` for stack
   refs).
2. Substitutes the resolved attributes into downstream resource
   props.
3. Hands the result to the provider.

This is the same flow as an in-stack Output, with one
difference: an in-stack Output's upstream is reconciled in this
same plan; a reference's upstream was reconciled by a previous
deploy and only its persisted attributes participate now.

Per-resource state and per-stack outputs are stored separately —
`state.set({ stack, stage, fqn })` for resources,
`state.setOutput({ stack, stage })` for stack outputs. The
separation keeps `O(1)` stack-output lookups and means destroying
a stage clears both. See [State Store](/concepts/state-store) for
the contract.

## When a reference misses

If the upstream hasn't been deployed, evaluation fails with:

```ts
class InvalidReferenceError extends Data.TaggedError(
  "InvalidReferenceError",
)<{
  message: string;
  stack: string;
  stage: string;
  resourceId: string;
}> {}
```

For resource refs, this propagates as a typed failure through
`Output.evaluate`. For stack refs and the `Plan.make` call path
it becomes a defect (`Effect.die`) — the call site can't
reasonably recover mid-deploy.

The fix is always the same: deploy the upstream first.

## Selection cheatsheet

| Goal | Use |
| --- | --- |
| Reference a resource in the current stack/stage (create OR adopt) | `MyResource.ref(id)` |
| Reference a resource in a different stage of the current stack | `MyResource.ref(id, { stage })` |
| Reference a resource in a different stack | `MyResource.ref(id, { stack, stage })` |
| Reference a single resource without the constructor in scope | `Output.ref<R>(id, opts?)` |
| Reference a whole stack's outputs at the matching stage | `yield* MyStack` |
| Reference a whole stack's outputs at a pinned stage | `MyStack.stage[name]` |
| Reference a whole stack's outputs without a typed handle | `Output.stackRef<A>(name, opts?)` |

## Related

- [Monorepos](/guides/monorepo) — `Stack.stage` / `yield* Stack`
  in practice.
- [Shared database across stages](/guides/shared-database) —
  `Resource.ref` for sharing expensive cloud resources between
  PR-preview and long-lived stages.
- [Inputs and Outputs](/concepts/outputs) — the broader Output
  model that references plug into.
- [State Store](/concepts/state-store) — where persisted state
  lives and how it's read.
