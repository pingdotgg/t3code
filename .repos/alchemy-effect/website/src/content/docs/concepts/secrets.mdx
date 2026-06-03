---
title: Secrets and Config
description: Use effect/Config to read env vars at init time and have Alchemy automatically bind them onto the deploy target.
sidebar:
  order: 8
---

Alchemy integrates with [effect/Config](https://effect.website/docs/configuration)
to automatically bind env vars to your [Platform](/concepts/platform) environment. 

## Bind a secret to your Worker

Any `Config` value that is evaluated with `yield*` in the [Init phase](/concepts/phases)
of (for example) a Worker, is automatically bound to its environment
at deploy time.

```typescript
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("API_KEY"); 
    // apiKey is Redacted<string> — usable here in Init AND captured as a binding

    return {
      fetch: Effect.gen(function* () {
        return new Response(`Bearer ${Redacted.value(apiKey)}`);
      }),
    };
  }),
);
```

:::tip
See [Phases](/concepts/phases) for why Init and Runtime run separately.
:::

## Use the value during Init

Unlike an [Output](/concepts/outputs), the value can be used immediately
within the Init phase. For example, to initialize a client:

```typescript
export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY");
    const client = createOpenAI(Redacted.value(apiKey));

    return {
      fetch: Effect.gen(function* () {
        const reply = yield* Effect.tryPromise(() => client.chat(/* ... */));
        return new Response(reply);
      }),
    };
  }),
);
```


## Transformations

Any combinator works — `withDefault`, `orElse`, `mapAttempt`, and so
on. What gets bound is the *source* value (the raw env var), not the
transformed result; the combinators run again at runtime against that
source.

```typescript
const port = yield* Config.number("PORT").pipe(
  Config.withDefault(3000),
);
```

- If `PORT` is set, its raw value is bound. At runtime `Config.number("PORT")`
  reads it from the binding and the combinators re-apply.
- If `PORT` is not set, nothing is bound. At runtime the source is
  still empty and `Config.withDefault(3000)` produces `3000` again.

Because a default is never bound, its code runs in both phases — keep
it deterministic, so both phases evaluate to the same value.

## Footgun: don't `yield*` Config at runtime

If you only `yield*` the `Config` in `fetch`, it will not be bound to the environment
because `fetch` does not run during deployment, so the engine never discovers it.

```typescript
export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        // 🚫 nothing is bound to the Worker — API_KEY won't exist at runtime
        const apiKey = yield* Config.redacted("API_KEY");
        // ...
      }),
    };
  }),
);
```

Always resolve the `Config` in the outer `Effect.gen` (Init) — even
if you only need the value inside `fetch`. Capture it in a `const`,
and reference that `const` from the runtime body:

```typescript
// ✅ bound in Init, used in Runtime
Effect.gen(function* () {
  const apiKey = yield* Config.redacted("API_KEY");
  return {
    fetch: Effect.gen(function* () {
      return new Response(Redacted.value(apiKey));
    }),
  };
});
```

## Async Workers — bind via `env`

Async (non-Effect) Workers don't have an Init `Effect.gen` to
`yield*` into, so you put the `Config` on the resource's `env`
prop instead. Alchemy resolves each `Config` at deploy time and
records the appropriate binding — same end result as the `yield*`
form, just declared statically:

```typescript
// alchemy.run.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";

export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  env: {
    API_KEY: Config.redacted("API_KEY"),
    HOST:    Config.string("HOST"),
    Bucket, // resource references work the same
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
```

```typescript
// src/worker.ts
import type { WorkerEnv } from "../alchemy.run.ts";

export default {
  async fetch(request: Request, env: WorkerEnv) {
    return new Response(`Bearer ${env.API_KEY}`);
  },
};
```

`env.API_KEY` is the resolved string at runtime — Cloudflare hands
the `secret_text` value to the async handler directly, no
`Redacted.value` unwrap. The always-binds-as-secret rule and
transformation semantics from the previous sections still apply.

For the step-by-step "wire up `OPENAI_API_KEY` from `.env`" walk,
see [Guides › Secrets and env vars](/guides/secrets).
