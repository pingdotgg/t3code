---
title: Stack
description: A Stack is a collection of Resources deployed together as a unit.
sidebar:
  order: 0
---

import StackOutputsTerminal from "../../../components/marketing-islands/StackOutputsTerminal.tsx";

A **Stack** is the top-level unit of deployment in Alchemy. It groups
resources together, wires up providers, and tracks state across
deploys.

## Defining a Stack

A Stack is just an Effect that you `export default` from a TypeScript
file:

```typescript
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  { providers: Cloudflare.providers() },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket("Bucket");
    return { bucketName: bucket.bucketName };
  }),
);
```

`Alchemy.Stack` takes three arguments:

1. **Name** — identifies this stack in state storage
2. **Options** — `providers` (required), `state` (optional)
3. **Effect** — a generator that declares resources and returns outputs

:::note[`alchemy.run.ts` is a convention]
The CLI looks for `alchemy.run.ts` by default, but **any TypeScript
file with a default-exported Stack works**. Pass the path as the
first positional argument:

```sh
alchemy deploy infra/my-stack.ts
alchemy destroy stacks/github.ts
```

See the [CLI reference](/guides/cli#deploy) for the full invocation
syntax.
:::

## Stack outputs

The value returned from the generator becomes the **stack output**.
After a deploy, outputs are printed to the console and available
programmatically in tests.

```typescript
Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2Bucket("Bucket");
  const worker = yield* Worker;

  return {
    bucketName: bucket.bucketName,
    url: worker.url,
  };
});
```

The CLI renders them after every successful deploy:

<StackOutputsTerminal client:visible />

## Stages

Every deploy targets a **stage** — an isolated instance of the stack
like `dev_sam`, `staging`, or `prod`. The stage defaults to
`dev_$USER`, so each developer gets their own environment
automatically. State and physical names are namespaced by stage.

```sh
alchemy deploy --stage prod
alchemy deploy --stage pr-42
```

For naming patterns, isolation, and per-stage configuration see
[Stages](/concepts/stages). Credentials per environment are managed
via [Profiles](/concepts/profiles).

## Accessing the Stack

Inside a resource or layer, you can access the current Stack's
metadata via the `Stack` service:

```typescript
import { Stack } from "alchemy/Stack";

Effect.gen(function* () {
  const stack = yield* Stack;
  console.log(stack.name); // "MyApp"
  console.log(stack.stage); // "dev_sam"

  const queue = yield* SQS.Queue("Jobs").pipe(
    RemovalPolicy.retain(stack.stage === "prod"),
  );
});
```

### `Stack.useSync` for module-scope resources

When you declare a resource at module scope (outside any
`Effect.gen`), there is no `yield*` available to read the `Stack`
service. `Stack.useSync` lets you compute props synchronously from
the current stack — useful for parameterizing names by stage:

```typescript
import * as Axiom from "alchemy/Axiom";
import { Stack } from "alchemy/Stack";

export const Traces = Axiom.Dataset(
  "Traces",
  Stack.useSync(({ stage }) => ({
    name: `${stage}-traces`,
    kind: "otel:traces:v1" as const,
    description: `OTEL traces for stage '${stage}'`,
    retentionDays: 30,
  })),
);
```

The function runs once at plan time, after the stage is resolved.
Use it anywhere a resource accepts a `props` object.

## Cross-stack references

A typed `Alchemy.Stack` handle lets one stack read another's
persisted outputs at plan time:

```typescript
// backend/src/Stack.ts — typed handle shared across packages
export class Backend extends Alchemy.Stack<
  Backend,
  { url: string }
>()("Backend") {}
```

```typescript
// frontend/alchemy.run.ts — reads the matching stage of Backend
const backend = yield* Backend;             // current stage
const pinned = yield* Backend.stage.prod;   // pinned stage
yield* Cloudflare.Vite("Website", {
  env: { VITE_API_URL: backend.url },
});
```

`yield* Backend` defaults to the **current stage** — `sam`
frontend reads `sam` backend, `pr-42` reads `pr-42`. Use
`Backend.stage.<name>` to pin to a specific stage instead.

See [References](/concepts/references) for the underlying
operators and [Monorepos](/guides/monorepo) for the
end-to-end walkthrough (package layout, schema sharing, deploy
ordering).

## Stack and stages — the engine

After every deploy, alchemy persists the state of each resource so
the next plan knows exactly what changed. Stages keep these state
files (and physical names) isolated:

```sh
# Each stage = its own state file + its own physical names.
$ alchemy deploy --stage dev_sam     # -> myapp-dev_sam-photos-a3f1
$ alchemy deploy --stage pr-147      # -> myapp-pr_147-photos-9b2c
$ alchemy deploy --stage prod        # -> myapp-prod-photos-7d4e

# Three independent deployments. Destroying one
# never touches the others.
```

- **State, per stack** — Each stack gets a state file (local, S3, R2,
  D1 — pluggable). The plan diffs declared resources against persisted
  state.
- **Stages = isolation** — Stages namespace both state and physical
  names. Two PRs deploy the same code into different resources without
  colliding.
- **Deterministic physical names** — Physical names derive from
  `stack/stage/logical-id`. Re-running create is idempotent — alchemy
  finds the existing resource.
