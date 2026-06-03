---
title: How we migrated 50+ providers to reconcile in an afternoon
date: 2026-05-06
draft: true
excerpt: One prompt, fifty resources, run in parallel. Tests were the ground truth. The engine got the same treatment.
---

[Part 1](/blog/2026-05-04-reconcile) covered why we replaced
`create` and `update` with a single `reconcile` function.
This post is about the part that surprised us: how
unreasonably fast it was to actually do the migration.

Alchemy has 50+ provider files in [`packages/alchemy/src/`](https://github.com/alchemy-run/alchemy-effect/tree/main/packages/alchemy/src).
The old shape was two functions per resource — `create` and
`update` — both written defensively against each other's
edge cases. The new shape is one function. Rewriting every
provider by hand would have been a multi-week slog.

It took one afternoon, with a single AI prompt fanned out
across the codebase in parallel. The existing tests were
the ground truth.

## Why `reconcile` is easier to *generate* than `create` + `update`

The reason this worked isn't that the model got smarter. It's
that `reconcile` is a strictly easier function to write
correctly — for a human or an AI — than the pair it
replaced.

To write `create` correctly you need to hold in your head:

- What happens if the resource half-exists from a prior
  crash? (probably need to catch `AlreadyExists` and read
  what's there)
- What happens if it fully exists and we're adopting? (need
  an ownership check)
- What does `update` assume `create` left behind? (because
  if `create` skips a step, `update` will silently skip it
  too)

To write `update` correctly you need to hold in your head:

- What if `olds` is stale because someone clicked in the
  console? (need to query live state instead of trusting it)
- What if a previous `update` half-completed? (need every
  step to be independently idempotent)
- What did `create` guarantee about the starting state?
  (because every assumption you make has to match)

`reconcile` collapses both into one mental model:
**read live state, compute the delta, apply the delta.**
There's no other function whose behavior you have to
predict. There's no postcondition to maintain across calls.
Each sync step is independently idempotent — crash, re-run,
converge.

The AI doesn't have to reason about which function it's in
or what the other one already did. There is no other one.

## Tests were the ground truth

Every provider already had test coverage:
[`test/AWS/S3/Bucket.test.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/test/AWS/S3/Bucket.test.ts),
[`test/AWS/DynamoDB/Table.test.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/test/AWS/DynamoDB/Table.test.ts),
and so on. These weren't unit tests with mocked SDKs — they
hit the real cloud, run through the full apply path, and
assert on the actual state of the resource.

That made them perfect as a migration substrate. The AI's
contract for each provider was:

1. Fold `create` and `update` into one `reconcile` function.
2. The existing tests must still pass.

Behavior changes that survived the tests were fine.
Behavior changes that broke them were rejected and retried.
We weren't reviewing the AI's prose about what it intended
to do — we were running its output against scenarios that
already encoded "the bucket must have these tags after step
3," "this update must not replace the resource," "adoption
of a tagged bucket must be silent."

For aspects that weren't yet covered, we added tests
*first*, then asked the AI to migrate. The new tests acted
as an executable spec for the gap.

## The engine got the same treatment

The provider-side change was the visible half. The other
half was inside the engine — [`Plan.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Plan.ts)
and [`Apply.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Apply.ts) —
which decide *which* provider function to call and route
the lifecycle.

`Plan.ts` kept its `"create" | "update" | "replace"` action
shape (see part 1 for why). `Apply.ts` is what changed:
both `create` and `update` actions now dispatch into the
same provider function, with the action distinction
preserved only for telemetry, terminal output, and `read`
gating.

The engine has its own integration tests — apply/plan
fixtures that simulate the full lifecycle including
adoption, drift, partial failures, retries. Those tests
became the ground truth for the engine rewrite, the same
way per-resource tests were the ground truth for providers.
The AI modified `Plan.ts` and `Apply.ts` against that test
surface; what passed shipped.

## What you get out of this

The headline number — 50 providers in an afternoon — is a
function of two things, not one.

The first is that AI is unreasonably good at translating
between two function shapes when both are well-specified
and the translation is mechanical. That's table stakes for
the model now.

The second is that **the target shape was simpler than what
it replaced.** That's the part you can engineer for. If the
migration had been the other direction — splitting one
function into two, with the AI having to invent the
boundary — it would have been slow and fragile and full of
incorrect assumptions about who owns what postcondition.
Going the other way, toward less structure and more
observation, was a downhill walk.

The other measurable outcome: providers got shorter. A
typical file lost 30-40% of its lifecycle code. The
DynamoDB `Table` provider, which had the gnarliest split
(GSIs, PITR, TTL, tags, stream config — each with its own
update API), dropped about 200 lines and got *more* correct
in the process. There's a generalizable lesson there:
**framework changes that make code easier to AI-generate
tend to make code easier to read and maintain too**, because
both are downstream of the same thing — fewer hidden
assumptions, fewer postconditions, fewer state machines in
your head.

## Where to go next

- [Part 1 — One reconcile, no create vs. update](/blog/2026-05-04-reconcile)
- [PR #179](https://github.com/alchemy-run/alchemy-effect/issues/179)
  — the migration in one diff.
- Per-resource test conventions:
  [`test/AWS/DynamoDB/Table.test.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/test/AWS/DynamoDB/Table.test.ts),
  [`test/Cloudflare/Workers/Worker.test.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/test/Cloudflare/Workers/Worker.test.ts).
