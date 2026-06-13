---
title: Define an RPC Worker
description: Define a typed Effect RPC group, serve it from `Cloudflare.RpcWorker`, drive it from an integration test, and (later) bind a typed client from another Worker.
sidebar:
  order: 11
---

The [Effect RPC guide](/guides/effect-rpc) walks through the long-form
`Cloudflare.Worker(...)` recipe: build the handler `Layer`, pipe it
into `RpcServer.toHttpEffect`, return `{ fetch }`. Most of that is
identical for every RPC Worker. `Cloudflare.RpcWorker` takes the
`RpcGroup` directly in props and wraps the `{ fetch }` shape for you.

This tutorial walks through a single RPC Worker end-to-end: declare
the schema, implement the worker, deploy it, and drive it from an
integration test. Cross-Worker binding via `RpcWorker.bind` shows up
at the end as a follow-on.

## Declare a tagged error

```typescript
// src/rpcs.ts
import * as Schema from "effect/Schema";

export class TaskNotFound extends Schema.TaggedClass<TaskNotFound>()(
  "TaskNotFound",
  { id: Schema.String },
) {}
```

RPC errors are schema-typed values rather than HTTP status codes —
clients pattern-match on them with `Effect.catchTag`.

## Declare a procedure

```diff lang="typescript"
 import * as Schema from "effect/Schema";
+import { Rpc } from "effect/unstable/rpc";

 export class TaskNotFound extends Schema.TaggedClass<TaskNotFound>()(
   "TaskNotFound",
   { id: Schema.String },
 ) {}
+
+const getTask = Rpc.make("getTask", {
+  payload: { id: Schema.String },
+  success: Schema.String,
+  error: TaskNotFound,
+});
```

Each `Rpc.make` declares one procedure: a name, a payload schema, a
success schema, and an error schema.

## Group procedures into an `RpcGroup`

```diff lang="typescript"
-import { Rpc } from "effect/unstable/rpc";
+import { Rpc, RpcGroup } from "effect/unstable/rpc";

 // ...

+export class TaskRpcs extends RpcGroup.make(getTask) {}
```

`TaskRpcs` is a single value the server, the client, and any tests
all import. Both ends share the same schema.

## Define the Worker

```typescript
// src/worker.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { TaskRpcs } from "./rpcs.ts";

export default class Worker extends Cloudflare.RpcWorker<Worker>()(
  "Worker",
  { main: import.meta.filename, schema: TaskRpcs },
  Effect.gen(function* () {
    return Effect.succeed(undefined as never);
  }),
) {}
```

`Cloudflare.RpcWorker<Self>()(...)` is class-shaped just like
`Cloudflare.Worker<Self>()(...)`. The only new prop is `schema`,
which carries the `RpcGroup`.

## Wire the handlers

```diff lang="typescript"
 import * as Cloudflare from "alchemy/Cloudflare";
 import * as Effect from "effect/Effect";
 import { TaskRpcs } from "./rpcs.ts";

 export default class Worker extends Cloudflare.RpcWorker<Worker>()(
   "Worker",
   { main: import.meta.filename, schema: TaskRpcs },
   Effect.gen(function* () {
-    return Effect.succeed(undefined as never);
+    const handlers = TaskRpcs.toLayer({
+      getTask: ({ id }) => Effect.succeed(`task-${id}`),
+    });
   }),
 ) {}
```

`TaskRpcs.toLayer({ getTask: ... })` is type-checked against the
group — every procedure must be implemented, with the right payload
and return type.

## Return the piped Effect

```diff lang="typescript"
 import * as Cloudflare from "alchemy/Cloudflare";
 import * as Effect from "effect/Effect";
+import * as Layer from "effect/Layer";
+import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
 import { TaskRpcs } from "./rpcs.ts";

 export default class Worker extends Cloudflare.RpcWorker<Worker>()(
   "Worker",
   { main: import.meta.filename, schema: TaskRpcs },
   Effect.gen(function* () {
     const handlers = TaskRpcs.toLayer({
       getTask: ({ id }) => Effect.succeed(`task-${id}`),
     });
+    return RpcServer.toHttpEffect(TaskRpcs).pipe(
+      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
+    );
   }),
 ) {}
```

The init returns the **piped `RpcServer.toHttpEffect` Effect
directly** — no `{ fetch }` wrapper.

## Deploy the Worker

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "Tasks",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url.as<string>() };
  }),
);
```

Yielding the class returns the underlying `Worker` resource;
`worker.url` is the public `workers.dev` URL the test will hit.

## Set up the test runner

```typescript
// test/worker.test.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});
```

`Test.make({ providers: Cloudflare.providers() })` returns
`test`/`beforeAll`/`afterAll`/`deploy`/`destroy` bound to a real
Cloudflare deployment. These are drop-in replacements for vitest's
own — `test` is the same shape, `beforeAll` / `afterAll` are wired
to the alchemy deploy/destroy lifecycle.

## Deploy the stack once for the file

```diff lang="typescript"
 import * as Cloudflare from "alchemy/Cloudflare";
 import * as Test from "alchemy/Test/Vitest";
+import Stack from "../alchemy.run.ts";

 const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
   providers: Cloudflare.providers(),
 });
+
+const stack = beforeAll(deploy(Stack));
+afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));
```

`beforeAll(deploy(Stack))` deploys once at the start of the file and
returns a handle each test `yield*`s for the stack's outputs.
`afterAll(destroy(Stack))` tears the deployment down at the end —
skip with `NO_DESTROY=1` to keep it around between iterations.

## Build a typed RPC client layer

```diff lang="typescript"
+import * as Layer from "effect/Layer";
+import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
+import * as RpcClient from "effect/unstable/rpc/RpcClient";
+import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";

 // ...
+const clientLayer = (url: string) =>
+  RpcClient.layerProtocolHttp({ url }).pipe(
+    Layer.provide(FetchHttpClient.layer),
+    Layer.provide(
+      Layer.succeed(RpcSerialization.RpcSerialization, RpcSerialization.json),
+    ),
+  );
```

The same `TaskRpcs` value the worker serves drives the test client.
`layerProtocolHttp` carries requests over `fetch`; `RpcSerialization.json`
matches the worker's wire codec (use `RpcSerialization.ndjson` if any
procedure is a streaming RPC).

## Write the round-trip test

```diff lang="typescript"
+import { expect } from "@effect/vitest";
+import * as Effect from "effect/Effect";
+import { TaskRpcs } from "../src/rpcs.ts";

 // ...
+test(
+  "getTask round-trip",
+  Effect.gen(function* () {
+    const { url } = yield* stack;
+    yield* Effect.gen(function* () {
+      const client = yield* RpcClient.make(TaskRpcs);
+      const result = yield* client.getTask({ id: "abc" });
+      expect(result).toBe("task-abc");
+    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
+  }),
+);
```

`yield* stack` resolves the deploy handle to its outputs, including
`url`. `RpcClient.make(TaskRpcs)` gives you a fully typed client — the
test asserts on `client.getTask({...})` directly, with schema decoding
and tagged errors built in.

## Ride the cold-start with retries

```diff lang="typescript"
+import * as Schedule from "effect/Schedule";

 test(
   "getTask round-trip",
   Effect.gen(function* () {
     const { url } = yield* stack;
     yield* Effect.gen(function* () {
       const client = yield* RpcClient.make(TaskRpcs);
-      const result = yield* client.getTask({ id: "abc" });
+      const result = yield* client
+        .getTask({ id: "abc" })
+        .pipe(
+          Effect.retry({
+            schedule: Schedule.exponential("500 millis"),
+            times: 5,
+          }),
+        );
       expect(result).toBe("task-abc");
     }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
   }),
+  { timeout: 60_000 },
 );
```

Fresh `workers.dev` URLs take a few seconds to start serving 200s.
The retry schedule rides through that warm-up so the first test in
the file doesn't fail on edge propagation.

## Streaming procedures

If any procedure in the group is a streaming RPC, switch the wire
codec from `layerJson` to `layerNdjson` (newline framing is required):

```diff lang="typescript"
-      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
+      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
```

Use the matching serialization layer in your test client.

## Bonus: call it from another Worker

Once the single-worker flow is solid, any other Worker in the same
account can call it via `Cloudflare.RpcWorker.bind` — no public URL,
no extra schema. To keep the example focused on the cross-Worker
call, the caller is a plain `Cloudflare.Worker` with a `fetch`
handler. Start with a bare class:

```typescript
// src/caller.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class Caller extends Cloudflare.Worker<Caller>()(
  "Caller",
  { main: import.meta.filename },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
```

A regular Worker — same shape as any other `Cloudflare.Worker`.

## Bind the typed client at init

```diff lang="typescript"
 import * as Cloudflare from "alchemy/Cloudflare";
 import * as Effect from "effect/Effect";
 import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
+import TaskWorker from "./worker.ts";

 export default class Caller extends Cloudflare.Worker<Caller>()(
   "Caller",
   { main: import.meta.filename },
   Effect.gen(function* () {
+    const tasks = yield* Cloudflare.RpcWorker.bind(TaskWorker);
+
     return {
       fetch: Effect.gen(function* () {
         return HttpServerResponse.text("ok");
       }),
     };
   }),
 ) {}
```

`Cloudflare.RpcWorker.bind(TaskWorker)` registers the service
binding on this Worker so workerd surfaces the stub on `env`, and
returns a typed `RpcClient` that mirrors `TaskWorker`'s schema.

## Call it from `fetch`

```diff lang="typescript"
 return {
   fetch: Effect.gen(function* () {
+    const task = yield* tasks.getTask({ id: "abc" });
+    return HttpServerResponse.text(task);
-    return HttpServerResponse.text("ok");
   }),
 };
```

`tasks.getTask({...})` is just an Effect — fully typed against
`TaskWorker`'s schema (success type `string`, error channel includes
`TaskNotFound`). Each call goes over the in-account service binding,
not the public network.

:::note[How it works under the hood]
Cloudflare rejects I/O objects (the service-binding `stub.fetch`
body) created on a previous request, which means the underlying
`RpcClient` has to be fresh every call. The bind hides that behind a
`Proxy`: each method invocation transparently builds a fresh client,
runs the call inside its own scope, and tears the client down with
the call. The consumer just sees a normal `RpcClient`.
:::

## Modular form: separate the class from its runtime

The inline form above bakes the runtime into the class
declaration. The **two-arg form** — `(id, props)` with no impl —
declares the class as a pure tagged identifier and provides the
runtime via `static make(impl)`:

```typescript
// src/worker.ts
export class Worker extends Cloudflare.RpcWorker<Worker>()(
  "Worker",
  { main: import.meta.filename, schema: TaskRpcs },
) {}

export default Worker.make(
  Effect.gen(function* () {
    const handlers = TaskRpcs.toLayer({
      getTask: ({ id }) => Effect.succeed(`task-${id}`),
    });
    return RpcServer.toHttpEffect(TaskRpcs).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
    );
  }),
);
```

`Worker.make(impl)` returns a `Layer<Worker>`. Consumers import
the class for type information; only the script that actually
hosts the Worker imports the default Layer.

## Host a Durable Object for cross-script binding

`RpcWorker<Self, Deps>()` mirrors `Cloudflare.Worker<Self, Bindings, Deps>`
— the optional second type argument declares DOs the script
publishes for cross-script binding:

```diff lang="typescript"
+import { Counter } from "./counter.ts";

-export class Worker extends Cloudflare.RpcWorker<Worker>()(
+export class Worker extends Cloudflare.RpcWorker<Worker, Counter>()(
   "Worker",
   { main: import.meta.filename, schema: TaskRpcs },
 ) {}
```

With `Counter` declared in `Deps`, any other Worker can write
`Counter.from(Worker)` and have it type-check — see the
[RPC Durable Object tutorial](/tutorial/cloudflare/rpc-durable-object)
for the full cross-script pattern.

## Recap

- `Cloudflare.RpcWorker` keeps everything from
  [Effect RPC](/guides/effect-rpc) and removes the `{ fetch }`
  wrapper. `props.schema` declares the served `RpcGroup`; the init
  returns the piped `RpcServer.toHttpEffect(schema)` Effect directly.
- Inline form `(id, props, impl)` bundles the runtime into the
  class; modular form `(id, props)` + `Class.make(impl)` keeps the
  class importable without the runtime.
- `RpcWorker<Self, Deps>()` declares cross-script DOs that
  consumers can bind to via `Counter.from(Worker)`.
- A single `Test.make` + `beforeAll(deploy(Stack))` + typed
  `RpcClient.make(TaskRpcs)` gets you an integration test that
  hammers a real `workers.dev` URL.
- For streaming procedures, switch `layerJson` → `layerNdjson` on
  both ends.
- `Cloudflare.RpcWorker.bind(WorkerClass)` works from any Worker —
  `RpcWorker` or plain `Cloudflare.Worker` — and gives you a typed
  client over the in-account service binding.
