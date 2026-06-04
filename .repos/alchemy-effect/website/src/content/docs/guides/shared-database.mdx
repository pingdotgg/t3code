---
title: Shared database across stages
description: Have ephemeral PR-preview stages reference a long-lived Neon Postgres project from staging instead of provisioning their own — fast previews, copy-on-write branches, no extra Postgres clusters.
sidebar:
  order: 4
---

[Stages](/concepts/stages) make it cheap to spin up isolated copies
of a stack — per-developer, `pr-42`, `prod`. Most resources should
be isolated. But some — a Neon Postgres project, a shared S3
bucket, a global rate limiter — are too expensive or too stateful
to re-provision per stage. PR-preview stages should *point at* the
shared instance instead.

`Resource.ref(id, { stage })` reads a deployed resource's
attributes from another stage of the same stack — typed, lazy,
resolved at plan time against the persisted state store. See
[References](/concepts/references) for the full reference surface
(`Output.ref`, `Output.stackRef`, `Stack.stage`).

The example we'll build: a Neon Postgres project that's owned by
`staging`, with PR-preview stages (`pr-*`) referencing it instead
of creating their own. The full file lives in
[`examples/cloudflare-neon-drizzle/src/Db.ts`](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-neon-drizzle/src/Db.ts).

## Start with the unconditional version

A Neon project plus a per-stage branch. Every stage gets its own
project — wasteful for short-lived PR previews:

```typescript
// src/Db.ts
import * as Alchemy from "alchemy";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export const NeonDb = Effect.gen(function* () {
  const schema = yield* Drizzle.Schema("app-schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
  });

  const project = yield* Neon.Project("app-db", {
    region: "aws-us-east-1",
  });

  const branch = yield* Neon.Branch("app-branch", {
    project,
    migrationsDir: schema.out,
  });

  return { project, branch, schema };
});
```

Each stage that runs this gets:

- its own `Neon.Project` (a whole Postgres cluster),
- its own `Neon.Branch` against that project,
- migrations re-applied from scratch.

Fine for `staging` and `prod`. Overkill for `pr-147`.

## Read the current stage

Pull the active stage from the `Stack` service so we can branch on
it. `Alchemy.Stack` is the same handle used everywhere — it gives
you `name`, `stage`, and friends:

```diff lang="typescript"
 export const NeonDb = Effect.gen(function* () {
+  const { stage } = yield* Alchemy.Stack;
+
   const schema = yield* Drizzle.Schema("app-schema", {
     schema: "./src/schema.ts",
     out: "./migrations",
   });
```

`stage` is whatever was passed to `alchemy deploy --stage <name>`.
We'll use it to route PR previews to the shared project.

## Swap in `Neon.Project.ref` for PR stages

Here's the key step. Replace the unconditional `Neon.Project(...)`
with a conditional that uses `Neon.Project.ref(...)` when the stage
is a PR preview, and creates a real project otherwise:

```diff lang="typescript"
-  const project = yield* Neon.Project("app-db", {
-    region: "aws-us-east-1",
-  });
+  const project = stage.startsWith("pr-")
+    ? yield* Neon.Project.ref("app-db", { stage: "staging" })
+    : yield* Neon.Project("app-db", {
+        region: "aws-us-east-1",
+      });
```

Three things to know about `Resource.ref`:

1. **Same logical ID.** `"app-db"` — the same logical ID the
   `staging` stage uses to create the project. The ref lookup is
   keyed by `{ stack, stage, id }`.
2. **Typed.** `project` is `Neon.Project` either way — same
   attributes, same downstream API. The branch resource doesn't
   know or care that one stage's `project` is real and another's
   is a reference.
3. **Resolved at plan time.** Alchemy reads the attributes (project
   id, host, etc.) from the staging stage's state file. If
   `staging` hasn't been deployed yet, plan fails with
   `InvalidReferenceError` — deploy `staging` first, then PR
   stages can reference it.

The signature is
`Resource.ref(id, { stage?: string, stack?: string })`. Both
options default to the current stack and stage; here we override
`stage` to point at the long-lived shared environment.

## Pass the reference downstream

Once `project` exists (real or referenced), the rest of the file
is identical. The branch creates per-stage:

```typescript
const branch = yield* Neon.Branch("app-branch", {
  project,
  migrationsDir: schema.out,
});
```

Each PR stage gets its own ephemeral Neon **branch** off the
shared **project** — which is exactly the point. Branches are
copy-on-write and free; projects aren't.

## The whole picture

```typescript
// src/Db.ts
import * as Alchemy from "alchemy";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export const NeonDb = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  const schema = yield* Drizzle.Schema("app-schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
  });

  const project = stage.startsWith("pr-")
    ? yield* Neon.Project.ref("app-db", { stage: "staging" })
    : yield* Neon.Project("app-db", {
        region: "aws-us-east-1",
      });

  const branch = yield* Neon.Branch("app-branch", {
    project,
    migrationsDir: schema.out,
  });

  return { project, branch, schema };
});
```

## Deploy

Deploy `staging` once to materialize the shared project:

```sh
alchemy deploy --stage staging
```

Then PR stages can reference it:

```sh
alchemy deploy --stage pr-147
```

Plan reads `staging`'s state, resolves `app-db` against it, and
provisions only the per-stage `Neon.Branch`. Tearing down a PR
stage with `alchemy destroy --stage pr-147` deletes the branch but
leaves the shared project alone — Alchemy doesn't own it from this
stage's perspective.

## Cross-stack too

`Resource.ref` also takes a `stack` option for pulling a resource
out of a *different* stack:

```typescript
const project = yield* Neon.Project.ref("app-db", {
  stack: "shared-infra",
  stage: "prod",
});
```

The lookup is `{ stack, stage, id }` — change any of them and
you're pointing at a different deployed resource. For pulling a
whole stack's outputs (instead of a single resource) see the
multi-stack section of [Monorepos](/guides/monorepo).

## When to use which

| Goal                                        | Use                                            |
| ------------------------------------------- | ---------------------------------------------- |
| Reference a single resource, same stack, different stage | `Resource.ref(id, { stage })`            |
| Reference a single resource, different stack | `Resource.ref(id, { stack, stage })`           |
| Reference an entire stack's outputs         | `Backend.stage[name]` ([guide](/guides/monorepo))             |
| Reference an arbitrary deployed Output      | [`Output.ref`](/concepts/outputs#ref)          |

All four resolve through the same state store — they just differ
in what shape they return.

## Related

- [Resource](/concepts/resource#ref) — `Resource.ref` reference.
- [Stages](/concepts/stages) — naming conventions for `pr-*`,
  `dev_*`, `staging`, `prod`.
- [Monorepos](/guides/monorepo) — whole-stack references via
  typed `Stack` handles.
