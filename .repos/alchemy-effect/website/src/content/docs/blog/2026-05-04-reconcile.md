---
title: One reconcile, no create vs. update
date: 2026-05-04
draft: true
excerpt: We replaced `create` and `update` with a single `reconcile` function. Both halves were already converging on the same defensive code.
---

Most IaC tools you've probably used are CRUD-based.
CloudFormation, Terraform, Pulumi, SST, and the CDK all
model a resource's lifecycle as four distinct operations:
**Create**, **Read**, **Update**, **Delete**. When you write
a provider, you write four functions, and the engine picks
which one to call based on whether prior state exists.

Kubernetes took a different approach. A controller doesn't
"create" or "update" — it *reconciles*. It looks at desired
state, looks at actual state, and does whatever it takes to
make them match. Same function, every time. But Kubernetes
pays for that simplicity with a **continuous control loop**:
controllers run forever, polling and reconciling on every
tick. There's no `plan` step, no `apply` step, no human in
the loop telling it "yes, do that now."

Alchemy wants both halves. We keep Terraform's *plan and
apply* model — you run `alchemy deploy`, the engine computes
a diff, shows you what's about to change, and applies it
once. But inside that apply step, each resource runs a
Kubernetes-style reconcile instead of a CRUD branch. One
shot, not a loop; but the function itself doesn't care
whether the resource is new, stale, drifted, or adopted —
it just makes the cloud match desired state and returns.

This post is about why we made that switch, and why the
providers got noticeably smaller for it.

## What `create` and `update` actually look like

If you've written an SST or CDK custom resource, or a
Terraform provider, you've seen the shape. Two functions —
`create` provisions from nothing, `update` mutates toward
new props.

Let's build one up for a DynamoDB `Table`, which we'll keep
using as the running example. Alchemy is Effect-native, so
the lifecycle functions are written as `Effect.fn` generators
that `yield*` AWS SDK calls instead of awaiting promises —
but the *shape* is the same as any CRUD provider. Start
with the skeleton:

```typescript
{
  create: Effect.fn(function* ({ id, news }) {
    // resource doesn't exist. provision it from `news`.
  }),
  update: Effect.fn(function* ({ id, news, olds, output }) {
    // resource exists. mutate it from `olds` toward `news`.
  }),
}
```

`create` runs once, when the engine has no prior state.
`update` runs every time after, with the previous props
(`olds`), the new props (`news`), and the attributes the
resource returned last time (`output`).

### Fill in `create`

DynamoDB's `CreateTable` call takes the whole table shape
in a single round trip — key schema, attributes, billing
mode, tags, all of it:

```diff lang="typescript"
  create: Effect.fn(function* ({ id, news }) {
+   const tableName = yield* createTableName(id, news);
+   const desiredTags = yield* createTags(id, news.tags);
+
+   yield* dynamodb.createTable({
+     TableName: tableName,
+     KeySchema: toKeySchema(news),
+     AttributeDefinitions: toAttributeDefinitions(news.attributes),
+     BillingMode: news.billingMode ?? "PAY_PER_REQUEST",
+     StreamSpecification: news.stream,
+     Tags: createTagsList(desiredTags),
+   });
+
+   yield* waitForTableActive(tableName);
+   return { tableName, tableArn: ... };
  }),
```

Notice `Tags` is a field on `CreateTable` itself — there's
no follow-up `TagResource` call. AWS designed it so a fresh
table comes out of the API fully tagged in one round trip.
This is the natural shape of `create`: take props, hand them
to the cloud, return attributes.

### Fill in `update` — tags

After the table exists, AWS won't let you change tags via
`UpdateTable`. There are separate `TagResource` and
`UntagResource` APIs, so `update` has to *diff* old props
against new props:

```diff lang="typescript"
  update: Effect.fn(function* ({ id, news, olds, output }) {
+   const desiredTags = yield* createTags(id, news.tags);
+   const oldTags = yield* createTags(id, olds.tags);
+   const { removed, upsert } = diffTags(oldTags, desiredTags);
+
+   if (upsert.length > 0) {
+     yield* dynamodb.tagResource({
+       ResourceArn: output.tableArn,
+       Tags: upsert,
+     });
+   }
+   if (removed.length > 0) {
+     yield* dynamodb.untagResource({
+       ResourceArn: output.tableArn,
+       TagKeys: removed,
+     });
+   }
  }),
```

This is the line we'll keep coming back to:
`diffTags(oldTags, desiredTags)`, where `oldTags` is derived
from `olds`. `update` is using `olds` as its baseline —
*the props we last wrote down* — rather than what's actually
attached to the table in AWS right now. Hold onto that.

### Fill in `update` — stream config

Stream configuration is mutable, but via `UpdateTable`
rather than `CreateTable`:

```diff lang="typescript"
  update: Effect.fn(function* ({ id, news, olds, output }) {
    // ...tag sync above...
+   if (news.stream !== olds.stream) {
+     yield* dynamodb.updateTable({
+       TableName: output.tableName,
+       StreamSpecification: news.stream,
+     });
+     yield* waitForTableActive(output.tableName);
+   }
+   return output;
  }),
```

Same shape: compare `news` to `olds`, fire the delta API if
they differ. Every mutable aspect of the table — tags,
stream, TTL, PITR, GSIs — is its own `if (news.X !== olds.X)`
branch.

That's a textbook CRUD provider — `create` is a single-shot
bootstrap that consumes every prop at once, `update` is a
per-aspect diff between `news` and `olds`. Clean.
Reasonable. It falls apart in three places.

## Break #1 — adoption

A user has an existing DynamoDB table called `Orders` in
their account. They want to start managing it with Alchemy
without re-creating it:

```sh
alchemy deploy --adopt
```

The engine has no prior state for `Orders`. Whichever of
the two lifecycle functions we call, we end up writing the
same defensive code.

### If we call `create`

The first `yield*` hits `dynamodb.createTable(...)`. AWS
rejects it with `ResourceInUseException`. So we catch it.
Now we're inside the `create` body holding a table we may
or may not own, and we need to figure out which:

```typescript
yield* dynamodb.createTable({ ... }).pipe(
  Effect.catchTag("ResourceInUseException", () =>
    Effect.gen(function* () {
      // It already exists — is it ours?
      const liveTags = yield* dynamodb.listTagsOfResource({ ResourceArn });
      if (yield* hasAlchemyTags(id, liveTags)) {
        return; // ours — silent adopt, fall through to sync
      }
      // Foreign — gate on AdoptPolicy
      const allowed = yield* AdoptPolicy;
      if (!allowed) return yield* Effect.fail(new OwnedBySomeoneElse({ ... }));
    }),
  ),
);

// ...and now what? We passed `BillingMode`, `StreamSpecification`,
// `Tags`, GSIs — none of them got applied, because we didn't actually
// create the table. We have to read live state and diff every aspect
// against desired, applying deltas where they differ.
```

By the time we're done, `create` contains:

1. A creation attempt.
2. A conflict-recovery branch with an ownership check.
3. An `AdoptPolicy` gate.
4. A per-aspect sync against live cloud state.

Steps 2-4 are exactly what `update` would have done.

### If we call `update`

Wait — we *can* route here, sort of. The engine has a `read`
lifecycle op precisely for this: when there's no prior state
but `--adopt` is set, `read` fetches live attributes and
seeds `output` before any lifecycle call. So `output` is
populated.

But `olds` is still `undefined` — there are no "previous
props" for a table we just met. And `update`'s tag-sync
line was:

```typescript
const oldTags = yield* createTags(id, olds.tags); // 💥 olds is undefined
```

The fix is the same shape as in `create`: don't trust
`olds`. Read tags from the cloud, diff observed against
desired:

```typescript
const observedTags = yield* dynamodb.listTagsOfResource({ ResourceArn });
const { removed, upsert } = diffTags(observedTags, desiredTags);
```

And every other `if (news.X !== olds.X)` branch in
`update` has to be rewritten the same way: read the live
value from the cloud, diff observed against desired, fire
the delta API.

Compare that to step 4 of the `create` body above. It's
the same code. `create` ended up needing it because the
table already existed when it tried to make one; `update`
needs it because `olds` is gone. Different reasons,
identical implementation.

### The point

Both branches converge on the same shape because **both
need to assume nothing and observe everything.** You can't
trust `olds` (it may be missing on adoption, or stale after
drift). You can't trust that `createTable` will succeed
(it'll conflict on adoption). The only thing that's
authoritative is what the cloud says right now.

Once `create` and `update` have both grown an "observe live
state, then converge per-aspect" prefix, the split is
purely cosmetic. This is the actual reconciler in
[`AWS/DynamoDB/Table.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/AWS/DynamoDB/Table.ts),
which collapses both into one flow:

```typescript
let state = yield* readTableState(tableName);

if (state === undefined) {
  yield* dynamodb.createTable({ /* ...full props, tags inline... */ }).pipe(
    // Race: a peer reconciler created the table between our observe and create.
    Effect.catchTag("ResourceInUseException", () => adoptExistingTable(tableName)),
  );
  state = yield* readTableState(tableName);
}

// From here on, every aspect (tags, GSIs, PITR, TTL, stream) is synced
// against `state` — the OBSERVED cloud state — not against `olds`.
```

`create` is now just one step inside the flow ("if it
doesn't exist yet, make it"). The rest is sync. Adoption
just means `state` was already populated when the function
started — no separate code path.

## Break #2 — partial creates

A Cloudflare `Worker` is more than a script. It's a script,
plus a workers.dev subdomain toggle, plus any custom
domains, plus the binding/migration metadata for Durable
Objects. The `create` body has to:

1. `PUT` the script (`putWorker`)
2. Toggle the `workers.dev` subdomain on or off
3. Attach each custom domain via `putDomain`
4. Persist returned IDs (domain IDs, zone IDs) into state

Now imagine the process gets `SIGKILL`'d between step 1 and
step 3 — laptop lid closes, CI runner gets evicted, network
times out. The script is uploaded. The domain isn't. State
hasn't been persisted, because we crashed before returning.

Next deploy, the engine still has no prior state, so it
routes to `create` again. `putWorker` runs and succeeds
(it's an upsert). Then `putDomain` runs and tries to attach
the hostname — except now Cloudflare may already know
about it from the partial run, or it may not, or it may be
attached to a *different* Worker because someone retried
elsewhere. The `create` body wasn't written for any of those
cases; it was written assuming a clean account.

The textbook fix is "make `create` idempotent." But the
moment you do that — catch `WorkerAlreadyExists`, query the
domain table to see what's attached, conditionally PUT —
your `create` body is *already* a reconciler. It's reading
observed state and applying deltas. It just happens to be
named `create`.

[`Cloudflare/Workers/Worker.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/Worker.ts)
makes the reconciler explicit. `putWorker` is a true upsert;
`reconcileDomains` queries the live domain list and computes
attach/detach deltas. There's no "first time" path. Crash
anywhere, re-run, converge.

## Break #3 — drift

Same Worker, fully deployed, state persisted, everyone
happy. Between deploys, a teammate opens the Cloudflare
dashboard and detaches `api.example.com` because they
were debugging something.

Next deploy, the engine has prior state, so it routes to
`update`. `update` compares `news.domain` to `olds.domain`,
sees no diff, and skips the domain logic. The cloud is
wrong, but `update` thinks everything is fine because
**`olds` is not the cloud — it's our cached belief about
the cloud.**

The fix, again, is to query live state instead of trusting
`olds`. From the real reconciler:

```typescript
// Always query the live state of domains attached to *this*
// Worker rather than trusting `_previous` from local state.
// State may have been wiped, populated by another machine, or
// simply be out of date. Without this we PUT domains that are
// already registered to this same Worker and Cloudflare
// returns a confusing "hostname already in use" error.
const liveAll = yield* listDomains({ accountId, service: scriptName });
```

Once you're querying live state and diffing against it,
`olds` has no role left to play. It's at best a hint to skip
a no-op API call, never the source of truth.

## The split was always a state machine

In all three breaks, the underlying problem is the same:
`create` and `update` form a two-state machine where
`update` assumes `create`'s postcondition holds. The cloud
doesn't honor that assumption. Adoption skips `create`
entirely. Partial creates leave the postcondition unmet.
Drift invalidates the postcondition after the fact.

By the time you've handled all three, `create` reads
observed state before doing anything, and `update` reads
observed state before doing anything. The two functions
have converged on the same shape — just under different
names, with different sets of edge cases papered over.

## The new shape

The provider surface is now three operations:

```typescript
{
  diff,       // replace? update? skip?
  read,       // load actual cloud state into the store
  reconcile,  // converge cloud → desired
  delete: ...,
}
```

`read` is called first whenever there's no prior state. If
it finds a resource, the engine checks the
[`AdoptPolicy`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/AdoptPolicy.ts)
— set globally with `--adopt`, or per-scope with
`.pipe(adopt(true))`. If adoption is allowed (or the
resource carries our ownership tags), the engine seeds state
from `read`'s output and proceeds. If not, it fails with
`OwnedBySomeoneElse` and tells the user how to opt in.

Then `reconcile` runs. Its contract is one sentence:

> Given desired state and current state, make the current
> state match.

It receives `output: Attributes | undefined` and
`olds: Props | undefined`. All three combinations are valid:

| `output`    | `olds`      | meaning                          |
| ----------- | ----------- | -------------------------------- |
| `undefined` | `undefined` | greenfield create                |
| defined     | defined     | routine update                   |
| defined     | `undefined` | adoption — first time we own it  |

The body must work for all three. It's written as one flow:

```
1. Observe — derive the physical id; read live cloud state
2. Ensure  — if missing, create it; tolerate AlreadyExists races
3. Sync    — for each mutable aspect:
             • read OBSERVED cloud state
             • compute desired state
             • diff observed vs. desired
             • apply the delta (skip the API on no-op)
```

The forbidden pattern is `if (output === undefined) {
/* create body */ } else { /* update body */ }`. That's
rename-and-branch — it brings back every false assumption
we just deleted.

## Plan didn't change

This is important: the *plan* still talks about create and
update. Open [`Plan.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Plan.ts)
and you'll find an `action` field on every node, with the
same values as before:

```typescript
type Action = "create" | "update" | "replace" | "delete" | "noop";
```

The planner still computes a diff and decides, per resource,
which of those actions applies. The terraform-style preview
you see in your terminal still says "Plan: 4 to create,
2 to update, 1 to replace, 0 to destroy."

What changed is what happens at *apply* time. Both `create`
and `update` actions now route into the same provider
function — `reconcile`. The distinction lives in the plan
(because users want to know "is this a fresh resource or a
modification?"), but it doesn't live in the provider. The
provider's job is identical either way: read live state,
converge it toward desired.

In other words, the create/update split was useful as a
*user-facing concept* — "tell me what's about to change" —
but harmful as a *provider-authoring concept*. We kept the
former and deleted the latter.

## Where to go next

This is part 1 of two. Part 2 covers how we actually
migrated all 50+ providers from `create` + `update` to
`reconcile`: we used a single AI prompt run in parallel
across the codebase, with the existing per-resource tests as
the ground truth, and the apply/plan integration tests as
the safety net for the engine changes themselves.

- [Part 2 — Migrating 50+ providers in an afternoon](/blog/2026-05-06-reconcile-ai-migration)
- [`AdoptPolicy`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/AdoptPolicy.ts)
  — the engine-side spec for `read` → `Unowned` → adopt/fail routing.
- Canonical reconcilers:
  [`AWS/S3/Bucket.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/AWS/S3/Bucket.ts),
  [`AWS/Kinesis/Stream.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/AWS/Kinesis/Stream.ts),
  [`AWS/DynamoDB/Table.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/AWS/DynamoDB/Table.ts).
- [PR #179](https://github.com/alchemy-run/alchemy-effect/issues/179)
  — the migration itself, every provider in one diff.
