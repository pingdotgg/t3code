---
title: Testing
description: Reference for alchemy/Test — every helper, hook, and option exposed by Test.make for Bun and Vitest.
sidebar:
  order: 11
---

`alchemy/Test/Bun` and `alchemy/Test/Vitest` provide an
Effect-aware test harness for both runners. This page documents
every helper, hook, and option exposed by `Test.make` — for the
walkthrough, see [Tutorial Part 3](/tutorial/part-3); for the
custom-provider use case, see
[Build a custom provider → Test the lifecycle](/guides/custom-provider#test-the-lifecycle).

## What Test.make returns

A single call returns a self-contained API for the file:

```typescript
const { test, beforeAll, beforeEach, afterAll, afterEach, deploy, destroy } =
  Test.make({
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  });
```

| Helper | Purpose |
|---|---|
| `test(name, effect)` | Effect-aware test. `HttpClient` and your providers Layer are in scope. |
| `test.skip` / `test.skipIf` / `test.only` / `test.todo` | Skip / focus / todo modifiers (same shape as `bun.test`). |
| `test.provider(name, fn)` | Provider-lifecycle test against a scratch in-memory stack. |
| `beforeAll(effect)` | Run an Effect once. Returns a lazy accessor (`yield* result`) usable inside tests. |
| `beforeEach(effect)` | Run an Effect before every test. |
| `afterAll(effect)` / `afterAll.skipIf(predicate)` | Cleanup hook with conditional teardown. |
| `afterEach(effect)` | Run an Effect after every test. |
| `deploy(Stack, opts?)` | Plan + apply a stack, resolve to its outputs. |
| `destroy(Stack, opts?)` | Plan + apply against an empty desired state. |

`expect` (and `describe`) come from the underlying runner —
`bun:test` or `@effect/vitest` — directly.

## Test.make options

```typescript
Test.make({
  providers,   // required
  state,       // optional
  profile,     // optional
  stage,       // optional
});
```

### `providers` (required)

The provider Layer that resolves resource implementations.
Usually the same one your `Stack` uses:

```typescript
providers: Cloudflare.providers(),
// or merge multiple:
providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
```

Credentials resolve through the same `AuthProviders` registry as
`alchemy deploy`, so tests pick up `alchemy login` profiles or
the env-var auth methods registered by each provider.

### `state`

The state store used by top-level `deploy(Stack)` and
`destroy(Stack)` (not by `test.provider`). Defaults to
`localState()` — `.alchemy/` on disk.

```typescript
state: Cloudflare.state(),  // R2-backed, survives across CI runners
state: localState({ path: ".alchemy-test/" }),  // separate dir
state: undefined,  // omit → defaults to localState()
```

A persistent state lets `deploy(Stack)` skip recreating unchanged
resources between runs, which is the whole point of running
tests against real cloud resources without paying the
provisioning cost every time.

### `profile`

Override `ALCHEMY_PROFILE` for this file only. Useful for
pinning tests to a sandbox profile regardless of what's set in
the environment:

```typescript
Test.make({
  providers: AWS.providers(),
  profile: "test-sandbox",
});
```

When omitted, the harness reads `ALCHEMY_PROFILE` from env / `.env`
the same way the CLI does.

### `stage`

Default stage for `deploy(Stack)` / `destroy(Stack)`. Defaults to
`"test"`. Override per file, or per call:

```typescript
Test.make({ providers, stage: "ci-pr-42" });

// or per-call:
beforeAll(deploy(Stack, { stage: "ci-pr-42" }));
afterAll.skipIf(!process.env.CI)(destroy(Stack, { stage: "ci-pr-42" }));
```

A unique stage per PR or test run lets multiple suites run in
parallel against the same provider account without colliding.

## Hooks

### `beforeAll(effect) → Effect.Effect<A>`

Runs the Effect once before any test in the file. Stores the
result and returns a lazy accessor — `yield* accessor` inside
any test or other hook returns the resolved value:

```typescript
const stack = beforeAll(deploy(Stack));
const seed = beforeAll(Effect.gen(function* () {
  yield* DynamoDB.putItem({ /* ... */ });
  return Date.now();
}));

test(
  "uses both",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const startedAt = yield* seed;
    /* ... */
  }),
);
```

Default timeout is **120s**. Override with the second argument:

```typescript
beforeAll(deploy(Stack), { timeout: 300_000 });
```

### `beforeEach(effect)`

Runs the Effect before every test. No accessor returned — for
side-effect setup only (truncate a table, reset a feature flag,
…).

### `afterAll(effect)` and `afterAll.skipIf(predicate)`

Cleanup hook with conditional teardown:

```typescript
afterAll(destroy(Stack));                          // always destroy
afterAll.skipIf(!process.env.CI)(destroy(Stack));  // CI only
afterAll.skipIf(true)(destroy(Stack));             // never (debugging)
```

`afterAll.skipIf(true)` short-circuits without registering a
hook at all — there's no risk of an `Effect` being constructed
and dropped.

### `afterEach(effect)`

Runs after every test. Combine with `beforeEach` for
test-isolated fixtures.

## Test variants

```typescript
test.skip("not ready yet", Effect.gen(function* () { /* ... */ }));

test.skipIf(process.env.CI)(
  "local-only smoke test",
  Effect.gen(function* () { /* ... */ }),
);

test.only(
  "the one I'm debugging",
  Effect.gen(function* () { /* ... */ }),
);

test.todo("backfill once R2 has multipart helper");
```

`test.provider` mirrors the same shape:

```typescript
test.provider.skip(name, fn);
test.provider.skipIf(condition)(name, fn);
```

:::note[Vitest differences]
On Vitest, `test.only` is supported but `test.todo` is a stub
(maps to `it.todo`). `test.skip` / `test.skipIf` work identically.
:::

## HttpClient is in scope

`HttpClient` is wired into every `test` Effect, so you can call
it directly:

```typescript
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";

test(
  "PUT and GET round-trip",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const put = yield* HttpClient.put(`${url}/k`, {
      body: HttpBody.text("hello"),
    });
    expect(put.status).toBe(201);

    const get = yield* HttpClient.get(`${url}/k`);
    expect(yield* get.text).toBe("hello");
  }),
);
```

The implementation comes from
`effect/unstable/http/FetchHttpClient` — same client the CLI
uses.

## test.provider for provider-lifecycle tests

`test.provider(name, (stack) => effect)` builds a **scratch
stack** with a private in-memory state store, isolated from
`.alchemy/` and from sibling tests. Use it to exercise create /
update / replace / delete paths of a provider:

```typescript
test.provider(
  "create, update, delete",
  (stack) => Effect.gen(function* () {
    // create
    const v1 = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* MyResource("Test", { name: "v1" });
      }),
    );

    // update — same logical ID, new inputs
    const v2 = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* MyResource("Test", { name: "v2" });
      }),
    );
    expect(v2.id).toBe(v1.id);

    // destroy
    yield* stack.destroy();
  }),
);
```

Inside the test body the configured `providers` Layer is
already in scope, so SDK calls (`DynamoDB.describeTable`,
`stripe.products.retrieve`, …) work without extra setup —
handy for asserting the cloud actually matches the resource's
reported outputs.

For a full walkthrough using a real custom provider, see
[Build a custom provider → Test the lifecycle](/guides/custom-provider#test-the-lifecycle).

### Scratch state vs persistent state

| | `test` + `deploy(Stack)` | `test.provider` |
|---|---|---|
| State store | `state` option (default `localState()`) | private in-memory, per test |
| Survives runs | yes (the point) | no |
| Use case | end-to-end against a real stack | provider unit tests |

## Bun vs Vitest

The two adapters expose the **same API**:

```diff lang="typescript"
-import * as Test from "alchemy/Test/Bun";
-import { expect } from "bun:test";
+import * as Test from "alchemy/Test/Vitest";
+import { expect } from "@effect/vitest";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});
```

- **Bun** uses `bun:test` directly. Every `test(...)` becomes a
  `bun.test(...)` call wrapped with `Effect.runPromise`.
- **Vitest** uses `@effect/vitest`'s `it.live`, so Effect-aware
  tests stay first-class. Default hook timeout is the same
  (120s).

Pick whichever runner your project already uses; nothing in the
test code changes.

## Patterns

### Run tests against an existing deployed stack

`afterAll.skipIf(!process.env.CI)(destroy(Stack))` is the
default pattern — `bun test test/integ.test.ts` deploys once,
re-runs reuse the cached state. To skip the deploy too (e.g.
you've already run `alchemy deploy` manually and just want to
hit the live URL), promote the stack outputs into a
`beforeAll` that reads them instead:

```typescript
const stack = beforeAll(
  process.env.SKIP_DEPLOY
    ? Effect.succeed({ url: process.env.STACK_URL! })
    : deploy(Stack),
);
```

### Share state across files

Each `Test.make` call creates its own runtime, but they all
hit the same `state` Layer if you give them the same one. To
share one deployed stack across multiple test files, use a
remote state store (`Cloudflare.state()` / S3-backed) and the
same `stage` in every file's `Test.make`.

### Seed pre-existing resources in a scratch stack

`test.provider`'s in-memory state is exposed as the `state`
field on `ScratchStack` for advanced cases. For simpler seeds,
just call `stack.deploy(...)` once with the seed, then again
with the actual test inputs — the second call sees the first
call's output as existing state.

## See also

- [Tutorial Part 3](/tutorial/part-3) — your first integration
  test, walked through step by step.
- [Build a custom provider](/guides/custom-provider) —
  including a full `test.provider` example.
- [State store](/concepts/state-store) — choosing between
  `localState()`, `Cloudflare.state()`, and friends.
- [Profiles](/concepts/profiles) — how `ALCHEMY_PROFILE` and
  the `profile` factory option resolve credentials.
