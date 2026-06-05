---
title: Branch from a shared database
description: Have ephemeral PR-preview stages reference a long-lived Neon project from the staging stage instead of provisioning their own — fast previews, copy-on-write branches, no extra Postgres clusters.
sidebar:
  order: 9
---

import { Code, Tabs, TabItem } from "@astrojs/starlight/components";

In the [Hyperdrive](/tutorial/cloudflare/hyperdrive)
tutorial you provisioned a `Neon.Project` and a `Neon.Branch`, then
[Drizzle](/tutorial/cloudflare/drizzle) layered automatic
migrations on top. Both work fine with a single stage — but the
moment you start deploying PR previews (`pr-147`, `pr-148`, …) the
default flow becomes painful:

- Every PR stage provisions its own `Neon.Project` — a whole
  Postgres cluster, with cold starts, project-count limits, and a
  full migration replay against an empty branch.
- Tearing the PR stage down deletes the project too, throwing away
  the data and any seeds you'd attached.

The fix is to share the **project** across stages — long-lived,
owned by `staging` — and only fork a per-stage **branch** off it.
PR stages get a fast, isolated, copy-on-write database without
touching project creation.

## Where we left off

Recap of `src/Db.ts` from the Drizzle tutorial — every stage
unconditionally creates its own `Neon.Project`:

```typescript
// src/Db.ts
import * as Cloudflare from "alchemy/Cloudflare";
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

export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* NeonDb;
  return yield* Cloudflare.Hyperdrive("app-hyperdrive", {
    origin: branch.origin,
  });
});
```

Today we'll change the project line — and only the project line —
so PR stages reuse `staging`'s.

## Read the active stage

The branching decision needs to know which stage is being
deployed. Pull it off the `Stack` service, which Alchemy provides
to every stack effect:

```diff lang="typescript"
+import * as Alchemy from "alchemy";
 import * as Cloudflare from "alchemy/Cloudflare";
 import * as Drizzle from "alchemy/Drizzle";
 import * as Neon from "alchemy/Neon";
 import * as Effect from "effect/Effect";

 export const NeonDb = Effect.gen(function* () {
+  const { stage } = yield* Alchemy.Stack;
+
   const schema = yield* Drizzle.Schema("app-schema", {
     schema: "./src/schema.ts",
     out: "./migrations",
   });
```

`stage` is whatever was passed to `bun alchemy deploy --stage <name>`
— `dev_sam`, `staging`, `prod`, or `pr-147`. We'll branch on
`stage.startsWith("pr-")` to decide whether to create a project or
reference one.

## Reference the shared project for PR stages

Replace the unconditional `Neon.Project(...)` with a conditional
that uses `Neon.Project.ref(...)` when the stage is a PR preview:

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

`Resource.ref` returns a typed reference to a resource that's
already been deployed in another stage. The lookup is keyed by
`{ stack, stage, id }`:

- The logical ID `"app-db"` matches the project the `staging`
  stage creates.
- `stage: "staging"` tells the lookup which stage's state file to
  read from.
- The current stack is implied — both stages share it.

`project` has type `Neon.Project` regardless of which branch ran.
The downstream `Neon.Branch` doesn't know (or care) which path
produced it.

For the bigger picture see [Shared database across stages](/guides/shared-database).

## The branch is still per-stage

Nothing changes below the project line. `Neon.Branch` still creates
a fresh branch per stage, off whichever project the conditional
returned:

```typescript
const branch = yield* Neon.Branch("app-branch", {
  project,
  migrationsDir: schema.out,
});
```

Branches are copy-on-write and free, so each PR stage gets a fully
isolated database — its own writes, its own migration history —
without paying for a whole Postgres cluster.

## Assembled file

```typescript
// src/Db.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
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

export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* NeonDb;
  return yield* Cloudflare.Hyperdrive("app-hyperdrive", {
    origin: branch.origin,
  });
});
```

## Deploy `staging` to seed the shared project

PR stages can only reference what `staging` has already deployed,
so `staging` has to go first:

```sh
bun alchemy deploy --stage staging
```

This runs the full path — creates `app-db` (the project),
`app-branch` against it, and `app-hyperdrive` in front. The state
for `Neon.Project("app-db")` lands in the `staging` state file,
which is what PR stages will read against.

## Deploy a PR stage

Now deploy a PR-preview stage. The same code, different stage flag:

```sh
bun alchemy deploy --stage pr-147
```

The plan is noticeably shorter:

- `Neon.Project("app-db")` → resolved as a **reference** to
  staging's project. No API call.
- `Neon.Branch("app-branch")` → freshly created against the
  referenced project.
- `Cloudflare.Hyperdrive("app-hyperdrive")` → points at the new
  branch's `origin`.
- `Api` → freshly created.

The PR stage has its own isolated branch, its own Hyperdrive, its
own Worker — and it shares the project with `staging`.

:::tip
If you `alchemy deploy --stage pr-147` *before* `staging` exists,
plan fails with `InvalidReferenceError` because there's nothing
under `{ stack, stage: "staging", id: "app-db" }` to read. Deploy
`staging` first.
:::

## Tear it down

```sh
bun alchemy destroy --stage pr-147
```

Destroy removes the per-stage resources — the branch, the
Hyperdrive, the Worker — but leaves the referenced project
untouched. Alchemy doesn't own `app-db` from this stage's
perspective, so it can't delete it. The shared project keeps
serving every other PR stage and `staging` itself.

## Where to from here

You now have:

- A **shared** Neon project owned by `staging`, surviving every
  PR stage's lifecycle.
- **Per-stage** Neon branches with their own migrations and data.
- A deploy/destroy story that scales to dozens of preview
  environments without flooding Neon with one project per PR.

The same `Resource.ref` pattern works for any other expensive,
shared resource you have — an S3 bucket of seed fixtures, a global
rate-limiter Durable Object, a DNS zone. Anywhere a per-stage
copy is wasteful, lift it to a long-lived stage and reference it
from the rest.
