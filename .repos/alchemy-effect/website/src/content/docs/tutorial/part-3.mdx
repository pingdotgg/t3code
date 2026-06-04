---
title: "Part 3: Testing"
description: Write integration tests that deploy your stack and make HTTP requests against your live Worker.
sidebar:
  order: 3
---

In [Part 2](/tutorial/part-2) you deployed a Worker with R2 Bucket
bindings. Now you'll write integration tests that deploy the stack,
hit the live Worker over HTTP, and verify it works.

## Create the test file

Alchemy ships test utilities for Bun that wrap `bun:test` with Effect
support. Configure providers (and state) once at the top of the file
with `Test.make({...})` — the same `Cloudflare.providers()` /
`Cloudflare.state()` you used in your `Stack`:

```typescript twoslash
// @filename: ../alchemy.run.ts
// ---cut---
// test/integ.test.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});
```

`expect` (and any other `bun:test` helpers like `describe`) come
from `bun:test` directly — `Test.make` only provides the
Effect-aware test runner pieces.

## Deploy the stack before tests

Use `beforeAll` with `deploy` to deploy your stack once before any
tests run:

```typescript twoslash
// @filename: ../alchemy.run.ts
// ---cut---
// test/integ.test.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

+const stack = beforeAll(deploy(Stack));
```

`deploy(Stack)` returns an Effect that plans and applies the stack.
`beforeAll` runs it once, then returns a lazy accessor you can
`yield*` inside each test to get the stack outputs.

## Access the stack outputs

Write your first test. Use `yield* stack` to get the outputs you
returned from your Stack in Part 2:

```typescript twoslash
// @filename: ../alchemy.run.ts
// ---cut---
// test/integ.test.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));

+test(
+  "worker returns a url",
+  Effect.gen(function* () {
+    const { url } = yield* stack;
+
+    expect(url).toBeString();
+  }),
+);
```

`test(name, effect)` wraps `bun:test` — you write an Effect generator
instead of an async function.

## Run the tests

```sh
bun test test/integ.test.ts
```

The first run deploys the stack (or reuses the existing one if
already deployed). Subsequent runs are fast because Alchemy diffs
and skips unchanged resources.

## Add HTTP assertions

The basic test just checks that a URL exists. Let's verify the Worker
actually handles requests:

```typescript twoslash
// @filename: ../alchemy.run.ts
// ---cut---
// test/integ.test.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
+import * as HttpBody from "effect/unstable/http/HttpBody";
+import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));

-test(
-  "worker returns a url",
-  Effect.gen(function* () {
-    const { url } = yield* stack;
-
-    expect(url).toBeString();
-  }),
-);
+test(
+  "PUT and GET round-trip an object",
+  Effect.gen(function* () {
+    const { url } = yield* stack;
+
+    const put = yield* HttpClient.put(`${url}/hello.txt`, {
+      body: HttpBody.text("Hello, World!"),
+    });
+    expect(put.status).toBe(201);
+
+    const get = yield* HttpClient.get(`${url}/hello.txt`);
+    expect(yield* get.text).toBe("Hello, World!");
+  }),
+);
+
+test(
+  "GET missing key returns 404",
+  Effect.gen(function* () {
+    const { url } = yield* stack;
+    const response = yield* HttpClient.get(`${url}/no-such-key`);
+    expect(response.status).toBe(404);
+  }),
+);
```

`HttpClient` is provided automatically by the test harness — no
extra setup needed.

## Destroy after tests on CI

Right now the stack stays deployed after tests finish. That's great
locally — you can re-run tests instantly against the already-deployed
stack. But on CI you want to clean up.

Add `afterAll` with `destroy`, using `skipIf` to only tear down when
`CI` is set:

```typescript twoslash
// @filename: ../alchemy.run.ts
// ---cut---
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));

+afterAll.skipIf(!process.env.CI)(destroy(Stack));

test(/* .. */);

test(/* .. */);
```

- **Locally** — `CI` is not set, so `skipIf` skips the destroy. You
  iterate fast against the live stack.
- **On CI** — set `CI=true` and the stack is torn down automatically
  after tests complete.

## Recap

You now have:

- `Test.make({ providers, state })` to wire your provider Layer and
  state store into the test runner once per file
- `beforeAll(deploy(Stack))` to deploy once before tests
- `yield* stack` to access outputs in each test
- HTTP assertions using Effect's `HttpClient`
- `afterAll.skipIf(!process.env.CI)(destroy(Stack))` for automatic
  cleanup on CI with fast iteration locally

In [Part 4](/tutorial/part-4), you'll run your stack locally with
`alchemy dev` for instant feedback during development.
