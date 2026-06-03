---
title: Resource Lifecycle
description: How alchemy plans, applies, replaces, and destroys resources — and how to think about idempotency and recovery.
sidebar:
  order: 3
---

import Terminal from "../../../components/Terminal.astro";
import DAG from "../../../components/DAG.astro";

Every [Resource](/concepts/resource) goes through the same lifecycle:
**plan → reconcile → (replace) → delete**. The plan classifies each
resource as create, update, replace, delete, or no-op, but the
provider implements a single `reconcile` function that converges the
cloud's actual state to what's declared — whether that's the first
provisioning, a routine update, or an adoption takeover. This page
walks through each step, what triggers it, and how alchemy recovers
when things go wrong. For the CLI flags that drive these operations,
see the [CLI reference](/guides/cli).

## The lifecycle, end-to-end

<DAG
  nodes={[
    { id: "Plan", tone: "accent" },
    { id: "Reconcile (create)" },
    { id: "Reconcile (update)" },
    { id: "Replace", tone: "warn" },
    { id: "Delete", tone: "danger" },
    { id: "Noop" },
  ]}
  edges={[
    { from: "Plan", to: "Reconcile (create)", label: "new" },
    { from: "Plan", to: "Reconcile (update)", label: "changed" },
    { from: "Plan", to: "Replace", label: "breaking" },
    { from: "Plan", to: "Delete", label: "removed" },
    { from: "Plan", to: "Noop", label: "unchanged" },
    { from: "Replace", to: "Delete", dashed: true },
  ]}
/>

Both create and update intents resolve to the provider's single
`reconcile` function. Replace runs `reconcile` against a fresh
instance id and then deletes the old generation. The same engine
drives `alchemy deploy`, `alchemy destroy`, and `alchemy dev`.

## Plan

When you run `alchemy deploy`, alchemy first **plans** the change.
It compares the desired state (what your code declares) against the
last persisted state and classifies each resource:

- **Create** (`+`) — declared in code, not in state
- **Update** (`~`) — declared and persisted, but properties differ
- **Replace** (`±`) — change requires destroy-and-recreate
- **Delete** (`-`) — persisted but no longer declared
- **No-op** (`•`) — unchanged

<Terminal content={`[u]Plan[/u]: [g]1 to create[/g], [y]1 to update[/y]

[g]+[/g] [b]Queue[/b] [d](AWS.SQS.Queue)[/d]
[y]~[/y] [b]Worker[/b] [d](Cloudflare.Worker)[/d]
[d]•[/d] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d]`} />

The classification comes from each provider's `diff` function. See
[Provider › diff](/concepts/provider#diff) for how providers decide
between in-place updates and replacements.

Use `alchemy plan` (or `alchemy deploy --dry-run`) to see the plan
without applying it.

## Reconcile

Whether a resource is being created for the first time, updated in
place, or adopted from existing infrastructure, alchemy calls a
single function: `provider.reconcile`.

Reconcile must be **convergent**: given the desired state in `news`,
it brings the cloud to that state regardless of starting point. It
receives:

- `news` — desired props
- `output` — current attributes (`undefined` on greenfield, defined
  after a prior reconcile or after adoption)
- `olds` — previous props (`undefined` on greenfield AND on adoption;
  defined only on routine updates)
- `bindings` — resolved binding payload from upstream policies

A reconciler is shaped like **observe → ensure → sync → return**:
read live cloud state via `getX`/`describeX`, create the resource if
missing (catching `AlreadyExists`-style errors as races), then for
each mutable aspect diff observed cloud state against desired and
apply only the delta.

Because each step is independently idempotent, a partial reconcile
that crashed midway resumes correctly on the next run. Physical
names are deterministic from `stack/stage/logical-id`, so the
"observe" step finds the previous reconcile's output even if state
persistence failed.

A second pass — **convergence** — re-runs `reconcile` for any
resource whose inputs changed because an upstream output changed
mid-deploy.

## Replace

Some property changes can't be applied in place — for example,
changing a DynamoDB table's partition key. The provider's `diff`
returns `{ action: "replace" }`, and alchemy:

1. Creates a new resource with a new instance ID
2. Updates downstream resources to reference the new resource
3. Deletes the old resource

Because new and old coexist briefly, dependents get a clean cutover
without downtime.

## Delete

`provider.delete` is called when a resource disappears from your
code, when a replacement supersedes it, or when you run
`alchemy destroy`. Like create, delete must be **idempotent**:
deleting an already-gone resource is a success, not an error.

`alchemy destroy` is just a plan where every persisted resource is
marked for deletion. Resources are removed in **reverse dependency
order** — dependents go first.

<Terminal content={`[u]Plan[/u]: [r]2 to delete[/r]

[r]-[/r] [b]Worker[/b] [d](Cloudflare.Worker)[/d]
[r]-[/r] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d]

Proceed?
◉ Yes ○ No
[r]✗[/r] [b]Worker[/b] [d](Cloudflare.Worker)[/d] [r]deleted[/r]
[r]✗[/r] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d] [r]deleted[/r]`} />

## Idempotency and recovery

State persistence can fail after the cloud operation succeeds — the
network drops between "bucket created" and "state saved". Alchemy
handles this by requiring `reconcile` and `delete` to be safe to
retry:

- **Reconcile**: deterministic physical names plus the observe-step
  mean a retry finds the existing resource instead of creating a
  duplicate, and re-syncs any aspect that drifted.
- **Delete**: a missing resource is treated as already deleted.
- **Read**: providers can implement `read` so alchemy can recover
  state from the live cloud when persistence fails partway, and to
  detect adoptable resources on a fresh state store.

## Adoption

When planning a resource that has no prior state, the engine calls
`provider.read` (if the provider implements it). This serves two
overlapping purposes:

- **State recovery** — the resource was created on a previous
  deploy, but state was lost between the cloud op succeeding and the
  store persisting. `read` finds the live resource and the engine
  rebuilds `created` state from its attributes.
- **Adoption** — you're deploying against existing infrastructure
  you didn't manage with Alchemy yet (or you wiped state
  intentionally). `read` recognizes the resource and the engine
  imports it into the new state.

Providers signal "this is mine" vs. "this exists but isn't mine" via
the `Unowned(attrs)` brand. The engine routes:

| `read` returns      | `--adopt` off             | `--adopt` on          |
| ------------------- | ------------------------- | --------------------- |
| `undefined`         | create                    | create                |
| owned (plain attrs) | silent adopt              | silent adopt          |
| `Unowned(attrs)`    | fail `OwnedBySomeoneElse` | take over (silently)  |

See [Provider › read](/concepts/provider#read) for the implementation
contract and [CLI › Adoption](/guides/cli#adoption) for the CLI flag.

## Errors

- **Retryable errors** (eventual consistency, dependency races) are
  retried automatically with backoff.
- **Non-retryable errors** (validation, authorization) fail
  immediately and surface in the plan output.
- **Partial failures** are safe to re-run thanks to idempotency.

## Driving the lifecycle from the CLI

The same engine powers all of these commands:

| Command            | What it does                                  |
| ------------------ | --------------------------------------------- |
| `alchemy plan`     | Run plan, print diff, exit                    |
| `alchemy deploy`   | Plan, prompt for approval, apply              |
| `alchemy destroy`  | Plan with everything marked deleted, apply    |
| `alchemy dev`      | Plan + apply continuously on file changes     |

See the [CLI reference](/guides/cli) for the full set of flags
(`--yes`, `--force`, `--dry-run`, `--stage`, `--profile`, ...).
