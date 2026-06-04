---
title: State Store
description: How Alchemy persists resource state between deploys to compute diffs and track infrastructure.
sidebar:
  order: 10
---

import StateStoreBootstrap from "../../../components/marketing-islands/StateStoreBootstrap.tsx";

Alchemy persists resource state between deploys so it can compute
diffs — comparing the desired state in your code against the current
state of your infrastructure.

## How state is stored

Each resource's state is keyed by its **fully qualified name** (FQN),
which includes the namespace path and logical ID. State is scoped by
**stack name** and **stage**, so different stacks and environments
are fully isolated.

A resource's persisted state includes:

- **Resource type** — e.g. `Cloudflare.R2Bucket`
- **Input properties** — the props you passed when creating it
- **Output attributes** — the values returned after creation
- **Instance ID** — a unique identifier for this instance
- **Lifecycle status** — `created`, `updating`, `deleting`, etc.
- **Bindings** — data attached by policies and event sources

## Local state

By default, state is stored on disk in the `.alchemy/` directory:

```
.alchemy/
  state/
    MyApp/
      dev_sam/
        Bucket.json
        Worker.json
```

Add `.alchemy/` to your `.gitignore`:

```sh
echo ".alchemy/" >> .gitignore
```

Local state works for solo development. Each developer gets their own
state via their default stage (`dev_$USER`).

## Remote state

For teams and CI, configure a remote state store so all deploys share
the same state. Alchemy includes a Cloudflare-backed store:

```typescript
Alchemy.Stack(
  "MyApp",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // ...
  }),
);
```

## Cloudflare state store

`Cloudflare.state()` is the recommended state store for projects
already running on Cloudflare. It persists state in a Worker backed
by a Durable Object with embedded SQLite, with the auth token and
encryption key kept in your account's Secrets Store.

### First-run bootstrap

The first time you run `alchemy deploy`, `plan`, or `dev` against a
stack configured with `Cloudflare.state()`, Alchemy can't find the
state-store Worker on your account and pauses to ask permission
before deploying it. Confirming kicks off a one-time deploy of the
state-store and its supporting resources:

<StateStoreBootstrap client:visible />

What gets created:

- **`Api`** — the state-store Worker itself (a Durable Object with
  embedded SQLite, enabled on a `workers.dev` subdomain)
- **`AlchemyStateStoreToken`** — bearer token used by the CLI to
  authenticate to the Worker, stored in your Secrets Store
- **`StateStoreEncryptionKey`** — symmetric key used to encrypt
  resource state at rest inside the Durable Object's SQLite
- **`StateStoreSecrets`** — the Secrets Store that holds the two
  secrets above, scoped to your Cloudflare account
- **`StateStoreAuthTokenValue` / `StateStoreEncryptionKeyValue`** —
  the generated random values bound into the secrets above

These resources are reused across every stack and stage that uses
`Cloudflare.state()` on this account — no duplication per project.
Subsequent runs detect the existing Worker and skip the prompt.

### Where credentials live

After the bootstrap, Alchemy writes the state-store URL and bearer
token to a credentials file under your Alchemy profile directory
(`~/.alchemy/<profile>/cloudflare-state-store.json` by default). On
CI, set `CI=true`; the credentials are resolved from the Secrets
Store on every run via a short-lived edge-preview Worker, so nothing
needs to be persisted to disk.

### Customizing the worker name

By default the state-store Worker is named `alchemy-state-store`.
Pass `workerName` to use a separate state store — for example, when
you want a dedicated store per Cloudflare account or per team:

```typescript
state: Cloudflare.state({ workerName: "alchemy-state-store-team-a" }),
```

## State and lifecycle

State transitions track the lifecycle of each resource:

| Status      | Meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| `creating`  | Create operation in progress                                     |
| `created`   | Resource exists and is healthy                                   |
| `updating`  | Update operation in progress                                     |
| `updated`   | Resource was updated successfully                                |
| `deleting`  | Delete operation in progress                                     |
| `replacing` | Resource is being replaced (new one created, old pending delete) |

These intermediate states (`creating`, `updating`, `deleting`) exist
because state is persisted before the cloud operation completes. If
the process crashes mid-operation, Alchemy uses the intermediate
state to recover on the next deploy.

## Writing your own state store

A state store is just an Effect `Layer` that provides the `State`
service. If the built-in stores don't fit, you can back one with
Postgres, S3, Redis, DynamoDB, or any other backend.

The `State` service holds an `Effect<StateService>` — a deferred
initializer — rather than a `StateService` directly. Wrap your
builder in `Effect.cached` so the backend is only contacted on first
use and the result is reused afterwards. This keeps commands that
provide the layer but never read state (like `alchemy login`) from
connecting to your backend or prompting for credentials.

See [Writing a Custom State Store](/guides/custom-state-store) for
a walkthrough of the `StateService` interface, an end-to-end
implementation, and references to the built-in stores you can copy
from.

## In-memory state (testing)

For tests, Alchemy provides an in-memory state store so tests don't
touch the filesystem:

```typescript
import * as TestState from "alchemy/Test/TestState";

// Seed with existing resource state
const state = TestState.state({
  Bucket: {
    /* ... */
  },
});
```

The test harness (`alchemy/Test/Bun` and `alchemy/Test/Vitest`)
handles state setup automatically.
