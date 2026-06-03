---
title: Secrets and env vars
description: Wire OPENAI_API_KEY from .env into a Cloudflare Worker as a secret_text binding.
sidebar:
  order: 3
---

Wire an `OPENAI_API_KEY` from your `.env` into a Cloudflare Worker
as a `secret_text` binding.

For the bigger picture — how this works, the Init/Runtime split,
trade-offs, and `Cloudflare.Secret` — see
[Concepts › Secrets and Variables](/concepts/secrets).

## 1. Add the env var

```sh
# .env
OPENAI_API_KEY=sk-proj-...
```

## 2. Resolve it in the Worker's Init phase

```diff lang="typescript"
// src/worker.ts
 import * as Cloudflare from "alchemy/Cloudflare";
+import * as Config from "effect/Config";
 import * as Effect from "effect/Effect";
 import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

 export default Cloudflare.Worker(
   "Worker",
   { main: import.meta.filename },
   Effect.gen(function* () {
+    const apiKey = yield* Config.redacted("OPENAI_API_KEY");

     return {
       fetch: Effect.gen(function* () {
         return HttpServerResponse.text("Hello, world!");
       }),
     };
   }),
 );
```

:::tip
At deploy time, Alchemy reads `OPENAI_API_KEY` from your `.env`
and records it as a `secret_text` binding on the Worker. At
runtime, the same `Config.redacted("OPENAI_API_KEY")` resolves
from that binding — one line, both phases.

See [Concepts › Secrets and Variables](/concepts/secrets) for how
the Init/Runtime hook-up works.
:::

## 3. Use it inside `fetch`

```diff lang="typescript"
 // src/worker.ts
 import * as Cloudflare from "alchemy/Cloudflare";
 import * as Config from "effect/Config";
 import * as Effect from "effect/Effect";
 import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
+import * as Redacted from "effect/Redacted";

 export default Cloudflare.Worker(
   "Worker",
   { main: import.meta.filename },
   Effect.gen(function* () {
     const apiKey = yield* Config.redacted("OPENAI_API_KEY");

     return {
       fetch: Effect.gen(function* () {
+        const response = yield* Effect.tryPromise(() =>
+          fetch("https://api.openai.com/v1/models", {
+            headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
+          }),
+        );
+        return HttpServerResponse.text(
+          yield* Effect.promise(() => response.text()),
+        );
-        return HttpServerResponse.text("Hello, world!");
       }),
     };
   }),
 );
```

Unwrap with `Redacted.value` only at the call site that needs the
raw string.

## 4. Deploy

```sh
alchemy deploy
```

The Worker now has an `OPENAI_API_KEY` `secret_text` binding, and
`Config.redacted("OPENAI_API_KEY")` resolves from that binding at
runtime — not from `process.env`.
