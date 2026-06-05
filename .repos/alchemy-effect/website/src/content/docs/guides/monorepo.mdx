---
title: Monorepos
description: Two patterns for organizing an Alchemy monorepo with a backend API and a frontend website — one shared stack (recommended) or one stack per package — with the trade-offs and a working example for each.
sidebar:
  order: 3
---

A real app usually ships a backend API and a frontend that calls
it. In a monorepo, you have two ways to organize the deploy:

1. **Single-stack** — one `alchemy.run.ts` at the workspace root
   that deploys both packages together. **Recommended** for most
   projects.
2. **Multi-stack** — each package owns its own `alchemy.run.ts`
   and the frontend reads the backend's deployed outputs through
   a typed cross-stack reference.

Both shapes share the same package layout and the same browser
client. The only thing that changes is **where the deploy lives**
and how the frontend discovers the backend's URL.

## Which one should I use?

Start with **single-stack**. It's simpler, faster to iterate on,
and avoids the deploy-ordering and reference-resolution gotchas
that come with cross-stack references.

| Situation                                                                  | Use          |
| -------------------------------------------------------------------------- | ------------ |
| One team owns both packages, ships them together                           | Single-stack |
| You want one `deploy` / `destroy` command per environment                  | Single-stack |
| Just starting out                                                          | Single-stack |
| Backend and frontend deploy on different cadences (different teams, CI)    | Multi-stack  |
| Backend has consumers besides the frontend, with their own deploy lifecycle | Multi-stack |
| You want to be able to `destroy` the frontend without touching the backend | Multi-stack  |

The two example projects:

- [`examples/monorepo-single-stack`](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/monorepo-single-stack)
- [`examples/monorepo-multi-stack`](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/monorepo-multi-stack)

## Shared layout

Both shapes start from the same workspace + backend package
layout. Walk through this section once; the next two sections
just add the deploy glue on top.

### Workspace root

Set up the workspace `package.json`:

```json
{
  "name": "monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["frontend", "backend"]
}
```

Workspaces let `frontend` import from `backend` by package name
— that's the channel the runtime client (and, in the multi-stack
shape, the typed stack handle) flow through.

### Backend package

Create `backend/package.json`:

```json
{
  "name": "backend",
  "private": true,
  "type": "module",
  "dependencies": {
    "alchemy": "workspace:*",
    "effect": "catalog:"
  },
  "exports": {
    ".": {
      "bun": "./src/index.ts",
      "import": "./lib/index.js",
      "default": "./lib/index.js"
    }
  }
}
```

The `bun` condition resolves `import "backend"` straight to the
TypeScript source under Bun, which keeps inner-loop iteration fast.

### Define the API schema

Put the `HttpApi` schema in its own file so it's importable from
both the Worker (which serves it) and the React app (which calls
it through a typed client):

```typescript
// backend/src/Spec.ts
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

export class Greeting extends Schema.Class<Greeting>("Greeting")({
  message: Schema.String,
}) {}

export const hello = HttpApiEndpoint.get("hello", "/", {
  success: Greeting,
});

export class HelloGroup extends HttpApiGroup.make("Hello").add(hello) {}

export class BackendApi extends HttpApi.make("BackendApi").add(HelloGroup) {}
```

Pure value-level descriptions. Both sides of the wire share the
same `BackendApi` constant.

### Implement the Worker

```typescript
// backend/src/Service.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { BackendApi, Greeting } from "./Spec.ts";

export default class Service extends Cloudflare.Worker<Service>()(
  "Service",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const helloGroup = HttpApiBuilder.group(BackendApi, "Hello", (handlers) =>
      handlers.handle("hello", () =>
        Effect.succeed(new Greeting({ message: "Hello World" })),
      ),
    );
    return {
      fetch: HttpApiBuilder.layer(BackendApi).pipe(
        Layer.provide(helloGroup),
        Layer.provide([HttpPlatform.layer, Etag.layer]),
        HttpRouter.toHttpEffect,
      ),
    };
  }),
) {}
```

Standard `HttpApi` plumbing — see
[Effect HTTP API](/guides/effect-http-api) for the long-form
walkthrough.

### Build the typed client

```typescript
// backend/src/Client.ts
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { BackendApi } from "./Spec.ts";

export const BackendClient = (baseUrl: string) =>
  HttpApiClient.make(BackendApi, { baseUrl });
```

A function that takes the deployed URL and returns a fully-typed
`HttpApiClient` for `BackendApi`. The React app calls this with
`VITE_API_URL`.

### Re-export the runtime modules

```typescript
// backend/src/index.ts
export * from "./Client.ts";
export * from "./Spec.ts";
```

`import { BackendApi, BackendClient } from "backend"` now works
across the workspace.

### Add a `./Client` subpath for the browser

The browser doesn't need anything but `BackendClient` — and
under tree-shaking it's safer to import it through its own
subpath rather than the package barrel. That keeps the React
build's dependency graph tightly scoped to the runtime client:

```diff lang="json"
   "exports": {
     ".": {
       "bun": "./src/index.ts",
       "import": "./lib/index.js",
       "default": "./lib/index.js"
+    },
+    "./Client": {
+      "bun": "./src/Client.ts",
+      "import": "./lib/Client.js",
+      "default": "./lib/Client.js"
     }
   }
```

The React app will use `import { BackendClient } from "backend/Client"`.

### Frontend package

`frontend/package.json` declares `backend` as a workspace
dependency:

```json
{
  "name": "frontend",
  "private": true,
  "type": "module",
  "dependencies": {
    "alchemy": "workspace:*",
    "backend": "workspace:*",
    "effect": "catalog:",
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "vite": "catalog:"
  }
}
```

### React entry point

```typescript
// frontend/src/main.tsx
import { BackendClient } from "backend/Client";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import React from "react";
import ReactDOM from "react-dom/client";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

const client = BackendClient(API_URL).pipe(
  Effect.provide(FetchHttpClient.layer),
);

function App() {
  // … call `client.Hello.hello()` and render the result
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
```

The browser only ever imports from `"backend/Client"` and never
from `"backend"`. The React bundle stays scoped to the runtime
client; nothing else from the backend package leaks into it.

That's the shared base. From here, choose a deploy shape.

## Option 1 — Single-stack (recommended)

One `alchemy.run.ts` at the workspace root deploys both packages.
The Worker and the Vite-built website are siblings inside one
stack; the frontend reads the Worker's URL directly off the
in-memory output, no cross-stack reference required.

### Wire it up

Create `alchemy.run.ts` at the workspace root:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";
import Service from "./backend/src/Service.ts";

export default Alchemy.Stack(
  "Monorepo",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const backend = yield* Service;
    const path = yield* Path;

    const website = yield* Cloudflare.Vite("Website", {
      rootDir: path.resolve(import.meta.dirname, "frontend"),
      env: {
        VITE_API_URL: backend.url.as<string>(),
      },
    });

    return {
      backendUrl: backend.url.as<string>(),
      websiteUrl: website.url.as<string>(),
    };
  }),
);
```

Two things to call out:

- The Worker's `backend.url` is an `Output<string>`. Passing it
  into `Cloudflare.Vite`'s `env` makes Alchemy build the website
  *after* the Worker is deployed, with the resolved URL baked in.
- `Cloudflare.Vite` takes a `rootDir` so a single stack can build
  a Vite project that lives elsewhere in the workspace — here,
  the `frontend/` directory.

### Deploy

```sh
alchemy deploy
```

One plan, one apply, one set of state. Both resources go up
together; both come down together with `alchemy destroy`.

That's it. No subpath-versus-barrel for the stack handle, no
deploy ordering, no `Output.stackRef`. The single-stack shape is
the one to reach for unless you have a reason not to.

## Option 2 — Multi-stack

Each package owns its own `alchemy.run.ts`. The frontend reads
the backend's deployed outputs through a **cross-stack
reference** (`yield* Backend`), resolved at plan time against the
state store. Each package can deploy and destroy independently.

You pay for that with two extra moving parts:

- A typed `Backend` stack handle declared in `backend/src/Stack.ts`.
- An order-of-deploys constraint: backend must be deployed (to
  the same stage you're referencing) before the frontend plan
  can resolve.

### Declare the typed Stack handle

```typescript
// backend/src/Stack.ts
import * as Alchemy from "alchemy";

export class Backend extends Alchemy.Stack<
  Backend,
  {
    url: string;
  }
>()("Backend") {}
```

`Alchemy.Stack<Self, Outputs>()(name)` produces a class that:

1. Names the stack (`"Backend"`) — must match across both stacks.
2. Declares the output shape — TypeScript enforces it on both sides.
3. Exposes `.make(...)` to deploy the stack.
4. Exposes `.stage[name]` to reference a deployed stage.

### Re-export the stack handle

Add `Stack.ts` to the package barrel so the frontend can import
it by package name:

```diff lang="typescript"
 // backend/src/index.ts
 export * from "./Client.ts";
 export * from "./Spec.ts";
+export * from "./Stack.ts";
```

`import { Backend } from "backend"` now resolves the typed handle.
The browser never imports from the bare `"backend"` barrel —
it goes through `"backend/Client"` — so adding `Stack.ts` here
does not affect the React bundle.

### Deploy the backend with `Backend.make`

```typescript
// backend/alchemy.run.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Service from "./src/Service.ts";
import { Backend } from "./src/Stack.ts";

export default Backend.make(
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Service;
    return {
      url: api.url.as<string>(),
    };
  }),
);
```

`Backend.make` is a typed shorthand for `Alchemy.Stack` that uses
the name and output shape declared on the handle. If the returned
object doesn't match `{ url: string }`, the file fails to
typecheck.

### Deploy the frontend with a cross-stack reference

```typescript
// frontend/alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Backend } from "backend";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Frontend",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const backend = yield* Backend;

    const website = yield* Cloudflare.Vite("Website", {
      env: {
        VITE_API_URL: backend.url,
      },
    });

    return {
      url: website.url.as<string>(),
    };
  }),
);
```

`yield* Backend` resolves to the **same stage** of the named
stack that the frontend is being deployed to — `sam` frontend
reads `sam` backend, `pr-42` reads `pr-42`, and so on. Under the
hood it's [`Output.stackRef`](/concepts/outputs#ref) reading
the backend's persisted stack output from the state store.

### Deploy

Deploy in dependency order — backend first, then frontend, with
matching stage flags:

```sh
cd backend && alchemy deploy --stage sam
cd frontend && alchemy deploy --stage sam
```

The frontend's plan resolves `Backend` against the state store
under the current stage (`sam`). The backend must be deployed to
the same stage first; otherwise evaluation fails with
`InvalidReferenceError`.

Destroy in reverse — frontend first, then backend.

### Pin to a specific stage

The bare `yield* Backend` is the right default. Sometimes you
want to **break** stage symmetry — e.g. the production frontend
always points at the production backend even when deployed from
a feature branch. Use `Backend.stage.<name>` to pin:

```diff lang="typescript"
   Effect.gen(function* () {
-    const backend = yield* Backend;
+    const backend = yield* Backend.stage.prod;
     // ...
   })
```

`Backend.stage` is a proxy keyed by stage name. Any string works:

```typescript
const backend = yield* Backend.stage.staging;
const backend = yield* Backend.stage["pr-42"];
```

| You want…                                                | Use                          |
| -------------------------------------------------------- | ---------------------------- |
| Frontend's stage maps 1:1 to the backend's stage         | `yield* Backend`             |
| Always pin to a specific backend stage                   | `yield* Backend.stage.prod`  |
| Branch on the current stage (e.g. PR previews → staging) | a conditional, see [Shared database across stages](/guides/shared-database) |

## Comparison

| Concern                           | Single-stack                | Multi-stack                              |
| --------------------------------- | --------------------------- | ---------------------------------------- |
| Number of `alchemy.run.ts` files  | 1                           | 2                                        |
| Number of state files per stage   | 1                           | 2                                        |
| Deploy ordering                   | Implicit (one plan)         | Backend first, then frontend             |
| Cross-package reference mechanism | Direct `Output<string>`     | `yield* Backend` → state-store lookup    |
| `destroy` blast radius            | Whole app                   | One package at a time                    |
| Best for                          | Most projects               | Independent deploy cadences / consumers  |

## Related

- [Stack](/concepts/stack) — defining stacks and stack outputs.
- [Inputs and Outputs](/concepts/outputs#ref) — the underlying
  `Output.stackRef` and `Output.ref` operators.
- [Shared database across stages](/guides/shared-database) —
  per-resource references between stages of the same stack.
- [Stages](/concepts/stages) — naming and isolating per-environment
  deploys.
