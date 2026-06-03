---
title: Inputs and Outputs
description: Output<T> is alchemy's lazy reference type — the lazy values that flow between resources, get composed with .pipe, mapped, interpolated, and resolved during deploy.
sidebar:
  order: 2
---

A [Resource](/concepts/resource)'s **inputs** are the props you pass
in. Its **outputs** are the attributes the cloud returns after
creation. The catch: outputs don't exist when you write the code.
They only exist after the resource is deployed.

Alchemy bridges this with **`Output<T>`** — a lazy, typed reference
that resolves once the upstream resource has run. You can read
properties off it, transform it with `pipe`, combine it with other
outputs, and feed it as input to the next resource. The resource
graph is built from these dependencies.

This page is a reference for every operator. For the bigger picture
of how the graph deploys, see
[Resource Lifecycle](/concepts/resource-lifecycle).

## What an Output is

```typescript
const bucket = yield* Cloudflare.R2Bucket("Bucket");

bucket.bucketName;
// ^? Output<string>
```

Three things to know:

1. **Lazy** — `bucket.bucketName` doesn't have a value yet. It's a
   description of "the bucket's name once it's created."
2. **Typed** — TypeScript still knows it's `string`, even though
   you can't `console.log` it directly.
3. **Tracked** — passing it as input to another resource registers
   a dependency edge. Alchemy uses these edges to deploy in the
   right order.

You almost never construct an `Output` yourself — they fall out of
resource declarations and the operators below.

## Property access

Reading a property off a resource (or any `Output`) returns another
`Output`:

```typescript
const bucket = yield* Cloudflare.R2Bucket("Bucket");

bucket.bucketName;        // Output<string>
bucket.bucketArn;         // Output<string>
bucket.tags?.environment; // Output<string | undefined>
```

Nested access works too — `expr.nested.deep` walks down the object
without forcing the value.

## `literal`

When you need an `Output` shape but the value is already known:

```typescript
import * as Output from "alchemy/Output";

Output.literal("hello");      // Output<string>
Output.literal(42);           // Output<number>
Output.literal({ a: 1 });     // Output<{ a: number }>
```

Useful as a default for an optional output, or as a placeholder in
templates and `Output.all` calls.

## `asOutput`

Lifts a plain value, an `Effect`, or an existing `Output` into an
`Output`:

```typescript
Output.asOutput("foo");                  // wraps as a literal
Output.asOutput(Effect.succeed(123));    // wraps as an EffectExpr
Output.asOutput(existingOutput);         // returns it unchanged
```

Use this when writing helpers that should accept "anything output-y."

## `map`

`Output.map` transforms an `Output<A>` into an `Output<B>` without
forcing it. The function runs once, after the upstream resource
resolves:

```typescript
import * as Output from "alchemy/Output";

const upper = bucket.bucketName.pipe(
  Output.map((name) => name.toUpperCase()),
);
// Output<string>
```

It also supports a data-first form when you don't want to use
`pipe`:

```typescript
Output.map(bucket.bucketName, (name) => name.toUpperCase());
```

`map` composes — pipe several together to build up a chain:

```typescript
const slug = bucket.bucketName.pipe(
  Output.map((s) => s.toLowerCase()),
  Output.map((s) => s.replaceAll("_", "-")),
);
```

The function only runs once (per evaluation) and only after every
upstream `Output` is ready. There is no risk of "the function ran
before the resource existed."

## `mapEffect`

`Output.mapEffect` is the same idea but the transform returns an
`Effect`. Use this when the transformation needs to do real work —
read a file, hit an API, decode a JWT — and you want it to live in
the Effect graph.

```typescript
const decoded = secret.value.pipe(
  Output.mapEffect((s) =>
    Effect.gen(function* () {
      const result = yield* JwtDecoder.decode(s);
      return result.payload;
    }),
  ),
);
// Output<Payload>
```

Chain them just like `map`:

```typescript
"a".pipe(
  Output.mapEffect((s) => Effect.succeed(s + "b")),
  Output.mapEffect((s) => Effect.succeed(s + "c")),
);
// resolves to "abc"
```

Requirements (the `R` channel of the inner Effects) are tracked in
the resulting `Output`'s requirements, so anything those Effects
need must be provided wherever the Output is finally evaluated.

## `all`

`Output.all` zips several `Output`s into one. The result resolves
to a tuple (preserving the input shape and types):

```typescript
const both = Output.all(bucket.bucketName, queue.queueUrl);
// Output<[string, string]>

const url = both.pipe(
  Output.map(([name, queue]) => `s3://${name}?dlq=${queue}`),
);
```

If you pass an array of `Output<T>` of unknown length, the result
is `Output<T[]>` instead of a fixed tuple.

## `interpolate`

The most common combination of `all` + `map` is "build a string
from outputs." `Output.interpolate` is a tagged template literal
for exactly that:

```typescript
const arn = Output.interpolate`arn:aws:s3:::${bucket.bucketName}/objects/*`;
// Output<string>

const dsn = Output.interpolate`postgres://${db.host}:${db.port}/${db.name}`;
```

Nullish interpolated values render as the empty string.

Behind the scenes this is `Output.all(...args).pipe(Output.map(...))` —
so the dependency graph is wired up automatically.

## `of`

You rarely call this directly because resources already act like
`Output`s, but it's how the conversion happens internally:

```typescript
const bucketOut = Output.of(bucket);          // Output<R2BucketAttrs>
const refOut    = Output.of(Ref({ id: "B" })); // for cross-stack refs
```

Use `Output.of(Ref(...))` (or [`Output.ref`](#ref))
to read a resource's attributes from another stack — see below.

## `ref`

`Output.ref` produces an `Output` referencing a deployed
resource's attributes in another stack or stage:

```typescript
const sharedBucket = Output.ref<typeof Bucket>("Bucket", {
  stack: "shared-infra",
  stage: "prod",
});

sharedBucket.bucketName; // Output<string>
```

Resolved at plan time against the persisted state store, fails
with `InvalidReferenceError` when the target is missing. In
day-to-day code prefer `Resource.ref` — same primitive, more
ergonomic surface.

See [References](/concepts/references) for the full reference
surface (`Output.ref`, `Resource.ref`, `Output.stackRef`,
`Stack.stage`) and how each is resolved.

## How Outputs compose in props

You can pass an `Output` (or any structure containing Outputs) as
the input prop of another resource. Alchemy walks the structure,
collects upstream dependencies, and waits for them to resolve
before calling the provider.

```typescript
const queue = yield* AWS.SQS.Queue("Jobs", {
  name: Output.interpolate`${bucket.bucketName}-events`,
  tags: {
    bucket: bucket.bucketName,
    region: Output.literal("us-west-2"),
  },
  deadLetter: {
    queueUrl: dlq.queueUrl,
  },
});
```

Plain values, Outputs, nested objects, and arrays are all valid —
the engine evaluates them recursively.

## Helpers

| Helper                 | Returns                                       |
| ---------------------- | --------------------------------------------- |
| `Output.isOutput(v)`   | `true` if `v` is an `Output<T>`               |
| `Output.isExpr(v)`     | `true` for any internal expression node       |
| `Output.upstream(o)`   | Map of upstream resources `o` depends on      |
| `Output.hasOutputs(v)` | `true` if `v` (or anything inside) is lazy    |
| `Output.toEnvKey(id, suffix)` | `"my-bucket" + "name"` → `"MY_BUCKET_NAME"` |

`upstream` and `hasOutputs` power the dependency graph — most code
won't call them directly, but they're useful when writing custom
providers.

## Redacted values

Alchemy preserves `Redacted<T>` (Effect's secret wrapper) through
evaluation. Logs and console output show `<redacted>` instead of
the underlying value:

```typescript
import * as Redacted from "effect/Redacted";

const apiKey = Redacted.make(env.API_KEY);

yield* MyService("svc", {
  apiKey, // stays Redacted in state and logs
});
```

## Evaluation semantics

When alchemy needs the actual value of an `Output` (to call a
provider, to print outputs at the end of a deploy, to satisfy a
binding), it runs `Output.evaluate(expr, upstream)`:

1. **Resource expressions** look up the resolved attributes of
   their upstream resource.
2. **Property expressions** evaluate their parent and read the
   property.
3. **Apply / EffectExpr** evaluate the parent first, then run the
   user function.
4. **All** evaluates its children in parallel.
5. **Ref** reads from the state store using `{ stack, stage, id }`.
6. **Plain values** (objects, arrays, primitives) are walked
   recursively so Outputs inside them get evaluated too.
7. **`Redacted`** values are preserved as-is.

You normally never call `Output.evaluate` yourself — alchemy invokes
it during plan and apply. But understanding the ordering helps:
**every Output is lazy until alchemy decides to resolve it**, and
the deploy graph is exactly the set of dependencies your Outputs
declared.

## Cheat sheet

| You want to…                                | Use                                          |
| ------------------------------------------- | -------------------------------------------- |
| Reference an attribute that doesn't exist yet | `resource.attr`                            |
| Wrap a constant as an Output                | `Output.literal(value)`                      |
| Coerce a value / Effect / Output to Output  | `Output.asOutput(x)`                         |
| Transform an Output                         | `output.pipe(Output.map(fn))`                |
| Transform with an Effect                    | `output.pipe(Output.mapEffect(fn))`          |
| Combine several Outputs                     | `Output.all(a, b, c)`                        |
| Build a string from Outputs                 | `` Output.interpolate`a/${b}/c` ``           |
| Read a resource from another stack          | `Output.ref<typeof X>("id", { stack, stage })` |
| Inspect dependencies                        | `Output.upstream(output)`                    |

For the surrounding model — what an `Output` actually flows into,
and how the graph deploys — see [Resource](/concepts/resource) and
[Resource Lifecycle](/concepts/resource-lifecycle).
