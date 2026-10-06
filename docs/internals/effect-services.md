# Effect services

Server features are Effect services. Transports call them: WebSocket RPC handlers in
[`ws.ts`](../../apps/server/src/ws.ts), HTTP routes, MCP tools, scheduled tasks, and the CLI. This
page holds the rules for writing them. The
[Effect Service Conventions](../../.macroscope/check-run-agents/effect-service-conventions.md)
review check enforces the same rules; keep the two in step.

## Where a feature lives

A server capability is a method on a service in its domain folder (`project/`, `workspace/`, `git/`,
`provider/`, ...). Extend the service that already owns the domain; add a new one only when none
does.

A transport handler does three things: decode the request, call one service method, and map the
service's typed errors to the transport's error. Nothing else. Filesystem, Git, process, or
persistence work, folder naming, multi-step dispatch, retries, and rollback belong in the service.

The reason is reach. Users trigger a capability from the WebSocket, agents reach it through MCP
tools, and scheduled tasks and the CLI run it too. Logic written into one handler is missing from
the others, and testing it needs a socket. Plain functions for pure work (a slug, an SVG, a
message) are fine next to the service; the capability itself is the method.

```ts
// ws.ts: a thin handler
[WS_METHODS.projectsCreateNew]: (input) =>
  observeRpcEffect(
    WS_METHODS.projectsCreateNew,
    projectFolders.createNamedProject(input).pipe(
      Effect.mapError((cause) => new ProjectCreateNewError({ cause })),
    ),
    { "rpc.aggregate": "orchestration" },
  ),
```

## Shape of a service module

One module per service, in this order: imports, errors and schemas, the `Context.Service` tag with
its interface inline, `make`, then `layer`. [`WorkspacePaths.ts`](../../apps/server/src/workspace/WorkspacePaths.ts)
and [`T3ProjectFileLoader.ts`](../../apps/server/src/project/T3ProjectFileLoader.ts) are good
references.

```ts
export class FooWriteError extends Schema.TaggedError<FooWriteError>()("FooWriteError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Failed to write the foo file.";
  }
}

export class Foo extends Context.Service<
  Foo,
  { readonly write: (input: { readonly path: string }) => Effect.Effect<void, FooWriteError> }
>()("t3/area/Foo") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // ...
  return Foo.of({ write });
});

export const layer = Layer.effect(Foo, make);
```

- **Imports.** Import Effect modules as namespaces from their subpaths:
  `import * as Effect from "effect/Effect"`, never `import { Effect } from "effect"`. Consumers use
  a service module the same way: `import * as Foo from "./Foo.ts"`, then `yield* Foo.Foo` and
  `Foo.layer`. Never `import { layer as fooLayer }`. Named imports are fine for packages like
  `@t3tools/contracts` and for modules used only for a pure helper, error, schema, config value, or
  type. A barrel exposes a whole service module as `export * as TokenStore from "./tokenStore.ts"`,
  not as renamed `make` and `layer` exports.
- **Interface.** No standalone `FooShape`; name the type `Foo["Service"]`.
- **Dependencies** come from the environment (`yield* FileSystem.FileSystem`), never as parameters
  to `make`, so the types of `make` and `layer` show what they need. Never hide one in a module
  global, a closure over a singleton, or a `Layer.succeed` that calls runtime-backed or imperative
  APIs. Tests may pass service instances directly. Configuration, immutable values, and deliberate
  callbacks are fine as parameters; they aren't services.
- **`make`** exists when the module owns construction and stays private unless another module
  imports it. Knip fails CI on an unused export. Don't write `make = Effect.succeed(...)` to force
  `Layer.effect`; use the constructor that fits, like `Layer.succeed` or `Layer.sync`.
- **Names.** A module named for its implementation uses plain `make` and `layer`
  ([`NodePtyAdapter.ts`](../../apps/server/src/terminal/NodePtyAdapter.ts)). A port module that also
  holds implementations names them, like `makeCloudflaredRelayClient` and `layerCloudflared`.
- **Moves.** Moving a service deletes the old files and updates every consumer, including
  orchestration, MCP, tests, and integration harnesses. No re-export shims.
- **Tests** exercise behavior through the service, with test layers only for external dependencies.
  Don't mock the logic under test.

## Runtime boundaries

`ManagedRuntime.make`, `runPromise`, and `runPromiseExit` belong at application and framework
boundaries: React, native callbacks, the CLI, HTTP adapters. Never in a domain service, repository,
persistence code, or service constructor. A named adapter may bridge a service into a Promise API,
but no Effect service depends on it.

Compose a shared resource once in an application-owned layer and provide its context to integration
runtimes. Don't create a managed or Atom runtime per feature to hand it out. When acquisition can
fail and callers need a fallback, keep the failure typed: an error on the operation or an explicit
optional-service layer. Don't route around the layer with an imperative runtime.

## Errors

- **Attributes.** Failures are `Schema.TaggedError` classes with structured attributes: the
  operation or stage, the resource path or entity id, a normalized category or status. The message
  is fixed or built from those attributes, never from `cause`, `cause.message`, or a stringified
  defect. No `detail` field that copies `cause.message`.
- **Cause.** An error that wraps a failure keeps the immediate underlying error as `cause`; make it
  required when every construction wraps one. Validation and domain errors with nothing underneath
  have none.
- **Safe values.** Attributes and log annotations stay bounded: no raw payloads, command arguments
  or output, signed URLs, credentials, query strings, or arbitrary defect text. The exact value
  lives only in `cause`. Expose a category, length, count, or a URL's protocol and host instead.
- **Translation.** Construct the error where the failure happens, and map it to a transport error
  only in the transport. A translation boundary passes through domain errors already in the target
  channel and wraps only unknown or lower-level failures. Map each failure where its context is
  known; don't wrap a whole pipeline in one generic error.
- **Discriminators.** Don't encode one distinction twice, as a specific tag and a single-value
  `operation`, `reason`, `kind`, or `phase` literal. Split classes when the distinction drives
  control flow or the user-facing message; a field that only helps diagnostics stays a field. A
  message that reaches HTTP, RPC, persisted state, or the UI is behavior, and a refactor keeps it.
- **Mappers.** Don't write a helper that only does `(...args) => new SomeError({ ...args })`. Keep
  a mapper only when it normalizes, passes domain errors through, or adds context. A mapper that
  belongs to the target error is a static factory on that class.
- **Predicates** are exported directly as `export const isFoo = Schema.is(Foo)`, not a function
  wrapping a private `Schema.is`.
- **Catching.** Catch known tags with `Effect.catchTags({ ... })`, even for one tag, not `catchTag`
  or `catchIf` with a schema predicate. `Effect.catch` is for handling the whole channel; `catchIf`
  is for structural checks like a platform error code.

## Before you push

- Does any handler you touched do more than decode, call, and map errors?
- Could an agent (MCP) or a scheduled task use this capability? If not, is that deliberate?
- Did you extend the domain's existing service before adding a new one?
- Did you run knip? A new export with no importer fails it.
- Does every directive you added that disables a lint, type-checker, or LSP diagnostic say why, in
  a `-- reason` suffix or a comment above it?
