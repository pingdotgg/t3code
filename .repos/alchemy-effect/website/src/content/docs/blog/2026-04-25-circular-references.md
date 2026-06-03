---
title: Circular references, without the deadlock
date: 2026-04-25
draft: true
excerpt: Two Workers can call each other. A Lambda's role and the KMS key it uses can grant each other access. Alchemy plans these as graphs with cycles — at both the runtime layer and the type system layer.
---

Say you have two services that need to talk to each other.
A web app handles login, an internal service handles
billing, and each one calls the other.

To deploy them, you need to tell each service where to
find the other. Easy enough if you're deploying by hand —
deploy the first, copy its URL, paste it into the second,
deploy that, copy its URL back into the first. Done.

But you want this in your infra code, so it's repeatable.
And now you have a problem: which one does the deployer
create first? Whichever you pick, you don't yet have the
other one's URL to give it.

This is a **circular dependency**, and most infrastructure
tools refuse to handle it. They'll plan your resources in
order, and the moment they detect a cycle they stop and
ask you to break it manually.

Alchemy doesn't. It plans the cycle in two passes.

## The observation that makes it work

When two resources depend on each other, they almost never
need the *whole* other resource. They need one piece of
identifying information — a URL, an ARN, a name. Something
short and stable that's known the moment the resource
exists, even before it's fully configured.

That's the wedge. If we can produce identifiers before we
do the rest of the work, we can plan the cycle as two
passes:

1. Reserve the identifiers for both resources.
2. Now that both identifiers exist, finish configuring each
   one — including the cross-reference to the other side.

Alchemy gives providers a lifecycle hook for step 1 called
**`precreate`**, and a regular lifecycle hook for step 2
called **`reconcile`**.

## `precreate` — reserving identifiers before reconcile

When the planner sees a cycle, it asks each participating
resource: *can you produce your stable identifiers without
needing the other side?* If the provider implements
`precreate`, the answer is yes.

Here's the Cloudflare `Worker` provider's `precreate`
(abbreviated from [`Worker.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/Worker.ts)):

```typescript
precreate: Effect.fnUntraced(function* ({ id, news, session }) {
  const name = yield* createWorkerName(id, news.name);

  // Upload a placeholder script. Just enough to reserve the
  // worker name and any Durable Object class IDs the cycle
  // might reference.
  yield* putScript({
    accountId,
    scriptName: name,
    metadata: { mainModule: "main.js", /* ...DO stubs... */ },
    files: [new File([placeholderScript], "main.js")],
  });

  return {
    workerId: name,
    workerName: name,
    url: undefined,                          // not yet — filled in by reconcile
    durableObjectNamespaces,
    // ...
  } satisfies Worker["Attributes"];
}),
```

The placeholder script is a no-op. It returns
`"Alchemy worker is being deployed..."`. That's fine — its
job isn't to handle traffic, it's to reserve a script name
and (if there are Durable Objects) generate stable namespace
IDs that other resources can refer to.

In alchemy v1 this was an explicit `WorkerStub` resource you
had to declare in your stack. In v2 it's invisible — the
planner detects the cycle, calls `precreate` on the
participating resources first, and then runs `reconcile` on
all of them with the cross-references resolved.

For [`AWS/S3/Bucket.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/AWS/S3/Bucket.ts)
the `precreate` is even shorter — it just calls
`ensureBucketExists`, since for the BucketPolicy → Lambda
cycle all the other side needs is the bucket ARN, which is
known the moment the bucket exists.

If a provider *doesn't* implement `precreate`, the planner
still works — it just can't participate in a cycle. You'd
get the same DAG-only behavior as Terraform. `precreate` is
an opt-in for the resources where the cycle pattern matters.

## The type-system problem

Engine support is half the battle. The other half is
authoring code that *expresses* the cycle without the
TypeScript compiler exploding.

The naive thing to write looks like this:

```typescript
// src/A.ts
import { B } from "./B.ts";

export const A = Cloudflare.Worker("A", { main: import.meta.path },
  Effect.gen(function* () {
    const b = yield* Cloudflare.Worker.bind(B);
    return { fetch: ... };
  }),
);

// src/B.ts
import { A } from "./A.ts";

export const B = Cloudflare.Worker("B", { main: import.meta.path },
  Effect.gen(function* () {
    const a = yield* Cloudflare.Worker.bind(A);
    return { fetch: ... };
  }),
);
```

Three things go wrong:

1. **Bundle bloat.** Each Worker's `import` pulls in the
   other Worker's entire implementation. When you bundle `A`
   for deployment, you also bundle `B`'s handler code — and
   vice versa. The Cloudflare Worker that's supposed to be
   small now contains both implementations.

2. **Circular type inference.** TypeScript needs `B`'s type
   to type-check `A`, but `B`'s type depends on `A`'s type
   (because the Effect inside `B` references `A`). The
   compiler bails with:

   > `'A' implicitly has return type 'any' because it does not have a return type annotation and is referenced directly or indirectly in one of its return expressions.ts(7023)`

3. **Runtime initialization order.** Even if the types
   resolved, the module loader has to execute *something*
   first. Whichever module loads first sees `undefined` on
   the other side.

## Tag-based design

The fix is to separate **identity** from **implementation**.
The class is the Tag — it carries the type, the resource ID,
the binding contract — and it's cheap to import. The
implementation is attached via a separate `.make()` call
that runs only when the Stack provides it.

```typescript
// src/A.ts — just the Tag
import * as Cloudflare from "alchemy/Cloudflare";

export class A extends Cloudflare.Worker<A>()("A", {
  main: import.meta.path,
}) {}
```

That's the whole identity declaration. Importing `A` from
another file gets you the type and the resource ID. It does
*not* pull in any handler code — there is no handler code
yet. The class is the Tag.

The runtime piece is a second file-level export:

```diff lang="typescript"
  // src/A.ts
  import * as Cloudflare from "alchemy/Cloudflare";
+ import * as Effect from "effect/Effect";
+ import { B } from "./B.ts";

  export class A extends Cloudflare.Worker<A>()("A", {
    main: import.meta.path,
  }) {}

+ export default A.make(
+   Effect.gen(function* () {
+     const b = yield* Cloudflare.Worker.bind(B);
+     return {
+       fetch: Effect.gen(function* () {
+         return yield* b.fetch(new Request("https://b/work"));
+       }),
+     };
+   }),
+ );
```

The `import { B }` here imports B's Tag only — its identity
and binding contract. `Worker.bind(B)` returns a typed
callable; at plan time the URL is an `Output<URL>`
placeholder, at runtime it's a real `fetch` stub.

`B.ts` mirrors the pattern: imports `A`'s Tag, binds it
inside its own `.make()`. Each file's `Effect.gen` references
the *other* class as a Tag, not as a value that has to be
initialized. The bundler sees the Tag import as type-only
and tree-shakes it from the runtime bundle. The TypeScript
compiler can resolve the types because each Tag is a single
class declaration with no dependencies on the other side's
implementation.

### Why `.make()` and not the inline form

For the non-cyclic case Alchemy lets you write the resource
and its implementation in a single expression:

```typescript
export default Cloudflare.Worker("MyWorker", { main: import.meta.path },
  Effect.gen(function* () { /* ... */ }),
);
```

This is the convenient default — one file, one expression,
type inference flows in one direction. But the moment the
generator references *itself*'s tag (`yield* MyWorker`), TS
trips on the self-reference. The class-form-plus-`.make()`
splits the declaration from the inferred body, which is
what unblocks both self-references and cross-references.

The rule of thumb: use the inline form for DAG-shaped
resources, use the class form when something else
references the resource before its implementation is in
scope — including the resource itself.

## How the two pieces compose

At plan time, the engine builds a dependency graph from the
Stack expression. When it sees a cycle, it routes the
participating resources through a two-pass lifecycle:

```
1. precreate — reserve identifiers (placeholder Worker scripts,
                empty Buckets, KMS keys without policies).
                Cross-references now have valid Output<…> values.
2. reconcile — every resource runs with the resolved bindings.
                For Worker A this means a real putScript with
                the binding to B's reserved URL; for the KMS
                key, the full resource policy referencing the
                role's ARN.
```

The Tag/Layer split is what makes step 2 *authorable* — the
generator inside `A.make(...)` can `yield* Worker.bind(B)`
without anyone needing to evaluate `B`'s `.make()` body. The
`precreate` hook is what makes step 2 *executable* — by the
time the generator runs, `B` already has a reserved URL.

You need both layers. Engine support without the Tag/Layer
split leaves you writing un-bundle-able, un-type-checkable
code. The Tag/Layer split without engine support leaves you
with code that type-checks but deadlocks at deploy time.

## When you don't need any of this

If your services form a DAG, write them inline. The
machinery exists for the cases where the natural shape of
your system has cycles — bidirectional resource policies,
mutually-recursive services, queue-mediated callbacks. For
everything else, the simple form is still simple:

```typescript
export default Cloudflare.Worker("Web", { main: import.meta.path },
  Effect.gen(function* () {
    const db = yield* Database;
    return { fetch: /* ... */ };
  }),
);
```

The interesting design choice is that the *engine*
capability — `precreate` and cycle-aware planning — is
opt-in per provider, not part of the framework's core
contract. Most providers don't need it. The ones that do
(Cloudflare `Worker`, AWS `Bucket`, KMS `Key`, IAM `Role`,
Lambda `Function`) implement it explicitly, and the planner
only invokes it when a cycle is actually present.

## Where to go next

- [Guides › Circular Bindings](/guides/circular-bindings) —
  the step-by-step Worker A ↔ Worker B walkthrough.
- [`Cloudflare/Workers/Worker.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/Worker.ts)
  — the canonical `precreate` reference, including Durable
  Object namespace reservation.
- [`AWS/S3/Bucket.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/AWS/S3/Bucket.ts)
  — `precreate` for the BucketPolicy ↔ Lambda Role cycle.
