# RFC: Git Building Blocks

## Current implementation

Git contributes native Effect route and storage layers. Applications own their
API schema and server. The public `Git.ApiLive` is composed beside application
routes; `Git.InternalApiLive` is mounted separately from user authentication.

```ts
const PublicRoutes = Layer.mergeAll(AppApiLive, Git.ApiLive).pipe(
  Layer.provide(Authentication.layer),
);
const Routes = Layer.mergeAll(PublicRoutes, Git.InternalApiLive).pipe(
  Layer.provide(Git.ApiHandlersLive),
  // repository, registry, hasher, blob, and platform layers
);
const fetch = yield* HttpRouter.toHttpEffect(Routes);
```

Applications can also build every group against their own `AppApi`, including
native `HttpApiMiddleware` that provides a typed user. Raw protocol handlers use
`alchemy/Git/Http` to decode streaming requests and encode Git responses, and
`Git.Engine` for repository operations. `preparePush` stages and validates objects;
application effects authorize refs and inspect content; `commitPush` advances refs.
Ref writes and merges have scoped preparation methods too. No policy callback
service is installed. See [DESIGN.md §8](./DESIGN.md#8-auth-model-nothing-inside-the-engine)
and [Engine operations](https://alchemy.run/git/blocks/engine).

## Historical proposal

The original proposal below is retained as design history. Its `Git.Server`,
`Git.ServerLive`, and Git-specific authentication services were removed; those
examples are superseded by the composition above. The storage design discussion
remains useful, but the historical API names are not current exports.

**On an AWS-native assembly (the DynamoDB question):** a `RefStore` on
DynamoDB pay-per-request is *conditionally* feasible — conditional writes
give ref CAS directly, and `TransactWriteItems` (100-item atomic cap)
covers `commitPush` **only if** staged-object visibility moves from
per-row flips to a push-epoch marker (commit = one item flip; membership
checks join against committed pushes). That redesign is the honest
price. But a RefStore alone is not AWS parity: the protocol engine,
ObjectStore index, commit-graph walks, alarms (compaction/bundles/GC),
and the push serialization point all live in the DO today — an AWS
assembly means Lambda-hosted planes, DynamoDB-backed stores with
optimistic transactions replacing `transactionSync`, and EventBridge/SQS
replacing alarms. Feasible, PPR-friendly on cost, and exactly what the
storage-agnostic contracts of §3.3 point at — but it is a Phase-D-scale
port, not a store swap. Until then `BlobStoreS3` serves the real hybrid:
Cloudflare compute, S3 bytes.

Re-thinks distribution of `alchemy/Git`. Today users import a finished
appliance:

```ts
const git = yield* GitService(); // one worker, one bucket, our routes, our auth
```

The proposal: distribute **git building blocks** — Effect `Context.Service`
contracts with swappable `Layer` implementations — that users assemble into
*their own* Worker. The package ships **no Worker and no `GitService()`**:
the top-level block is `Git.Server`, a `Context.Service` exposing `fetch`.
Users construct the `Cloudflare.Worker` themselves, build one layer graph,
and wire `fetch` in.

```ts
import * as Git from "alchemy/Git";
import * as BetterAuth from "@alchemy.run/better-auth";

// One layer graph, one Effect.provide. Every block is swappable.
const GitLive = Git.ServerLive.pipe(
  Layer.provide(Git.ReposDurableObject),     // refs + objects in Durable Objects
  Layer.provide(Git.RegistryDurableObject),
  Layer.provide(Git.PullStoreDurableObject), // pull requests
  Layer.provide(Git.BlobStoreR2(Bucket)),    // packs & clone bundles in R2
  Layer.provide(
    Git.AuthBetterAuth({
      // your rules, in git's vocabulary — this line is branch protection
      authorize: ({ user, repo, action }) =>
        action._tag === "Fetch"
          ? repo.public || user != null
          : action._tag === "Push"
            ? action.updates.every((u) =>
                u.ref === "refs/heads/main"
                  ? user?.id === repo.owner
                  : user != null,
              )
            : user?.id === repo.owner,
    }),
  ),
  Layer.provide(BetterAuth.CloudflareD1(Database)),
);

export default class GitHost extends Cloudflare.Worker<GitHost>()(
  "git",
  { main: import.meta.url },
  Effect.gen(function* () {
    const git = yield* Git.Server;
    return { fetch: git.fetch };
  }).pipe(Effect.provide(GitLive)),
) {}
```

---

## 1. Why

1. **Swappability.** R2 is an implementation detail that currently leaks
   through six modules (`ObjectStore` exposes the raw
   `ReadWriteBucketClient`; `PackSource`, `IncomingBody`, `Compact`,
   `Bundle`, `Purge` all import the R2 client type; the Worker binds the
   bucket directly for the bundle splice). Nothing about pack storage is
   R2-specific — it needs ranged reads, streaming multipart writes, and
   delete. S3 satisfies that through alchemy's *existing* AWS S3
   capabilities.
2. **Partial adoption.** Some users want only the wire plane behind their
   own auth; some want the REST plane inside an existing HttpApi; some want
   the GitHub facade and nothing else. Today it's all-or-nothing.
3. **Auth is the sharpest customization demand.** DESIGN §8 already calls
   the `Credentials` service "the v2 identity seam". Making `Auth` a
   first-class swappable service is how OAuth/JWT/SSO happens without
   forking the package.
4. It's the alchemy thesis applied to ourselves: infrastructure as
   composable, typed Effect programs — not appliances.

## 2. One layer graph, two runtime contexts

A git repo needs one serialization point: refs CAS, push staging, pull
numbering. On Cloudflare that is a Durable Object, and code that needs
`transactionSync` must run *inside* it. But — and this is the load-bearing
simplification — that is a **runtime** fact, not an **authorship** fact.
The DO classes live in the same script as the Worker, so the user authors
ONE layer graph; alchemy's DurableObject machinery captures the composed
layers and constructs the DO-internal sub-graph per instance on first
event (exactly how `GitRepoLive.pipe(Layer.provide(R2Binding))` works
today).

```
              ONE authored layer graph (the user's GitLive)
                              │
        ┌─────────────────────┴──────────────────────┐
   Worker runtime                             Repo DO runtime
   Wire/Rest/GitHubCompat routes              protocol engine
   Registry resolution · Auth                 ObjectStore · RefStore
   BlobStore (bundle splice reads)            PullStore · TokenStore
                                              jobs · BlobStore (packs/spill)
```

Consequences:

- Providing `Git.BlobStoreS3(bucket)` **once** satisfies every consumer on
  both sides. There is no per-DO `layer:` option, no DO subclassing, and
  no manual class re-export: providing `Git.ReposDurableObject` /
  `Git.RegistryDurableObject` pulls the DO classes into the bundle through
  the layer graph, and alchemy's generated worker entry exports them for
  workerd (verify during Phase C that the generated-entry path covers
  package-shipped DO classes; if not, that is a Phase C work item in
  alchemy core, not user ceremony).
- The two runtime contexts still construct *separate instances* of a
  layer's service (a Worker-side BlobStore client and a DO-side one).
  That is invisible to the author but matters for layer implementors:
  construction must be cheap and context-free (the isolate-scope rules
  from AGENTS.md apply on both sides).
- Swappable-per-repo storage is out of scope: one graph means one
  configuration per deployment, which is the sane default anyway.

## 3. Service taxonomy

**Naming convention: one flat `Git` namespace, no nesting.** Contracts are
bare names (`Git.BlobStore`, `Git.Auth`, `Git.Server`);
implementations are `{Contract}{Impl}` (`Git.BlobStoreR2`,
`Git.BlobStoreS3`, `Git.AuthTokens`, `Git.ReposDurableObject`,
`Git.RegistryDurableObject`, `Git.PullStoreDurableObject`,
`Git.ServerLive` — all plain layers in one graph). Mirrors the package-level
flat-export convention (`ReadBucketBinding`, `GitAuthLive`) rather than
the `Cloudflare.KV.*` sub-namespacing.

### 3.1 `BlobStore` — the R2 ↔ S3 seam (the headline)

Immutable, content-addressed bulk bytes. Everything the pack plane needs
and nothing more:

```ts
export class BlobStore extends Context.Service<BlobStore, {
  /** Ranged read; `undefined` = whole object. `null` = missing. */
  readonly get: (
    key: string,
    range?: { readonly offset: number; readonly length: number },
  ) => Effect.Effect<BlobBody | null, BlobStoreError, RuntimeContext>;
  /** Whole-object write with known length (streams allowed). */
  readonly put: (
    key: string,
    body: Uint8Array | Stream.Stream<Uint8Array, BlobStoreError>,
    options: { readonly contentLength: number },
  ) => Effect.Effect<void, BlobStoreError, RuntimeContext>;
  /** Streaming write of unknown length (push-body spill). */
  readonly multipart: (
    key: string,
  ) => Effect.Effect<BlobMultipart, BlobStoreError, RuntimeContext>;
  readonly delete: (
    keys: string | ReadonlyArray<string>,
  ) => Effect.Effect<void, BlobStoreError, RuntimeContext>;
  /** Prefix listing — purge/GC only, never on a serving path. */
  readonly list: (
    prefix: string,
  ) => Stream.Stream<BlobMeta, BlobStoreError, RuntimeContext>;
}>()("alchemy/Git/BlobStore") {}

export interface BlobBody {
  readonly size: number;
  readonly bytes: Effect.Effect<Uint8Array, BlobStoreError>;
  readonly stream: Stream.Stream<Uint8Array, BlobStoreError>;
}

export interface BlobMultipart {
  readonly uploadPart: (n: number, part: Uint8Array) =>
    Effect.Effect<void, BlobStoreError>;
  readonly complete: Effect.Effect<void, BlobStoreError>;
  readonly abort: Effect.Effect<void, BlobStoreError>;
}
```

Implementations shipped:

| Layer | Rides on | Notes |
|---|---|---|
| `Git.BlobStoreR2(bucket)` | `Cloudflare.R2.ReadWriteBucket` | today's behavior, extracted |
| `Git.BlobStoreS3(bucket)` | `AWS.S3` capabilities (`GetObject`/`PutObject`/multipart) | already exist as alchemy bindings |
| `Git.BlobStoreMemory()` | Map | tests; kills the R2-shaped mocks |

Uniform-part-size and part-count limits differ per store (R2: uniform
parts, 10k max; S3: 5 MiB min, 10k max) — the contract mandates the
*intersection* (uniform parts ≥ 5 MiB except last), which `IncomingBody`
already satisfies.

Consumers refactored onto it: `ObjectStore` (stops leaking `bucket`),
`PackSource` (`r2RandomAccess` → `blobRandomAccess`), `IncomingBody`,
`Jobs/Compact`, `Jobs/Bundle`, `Jobs/Purge`, the Worker's bundle splice.

### 3.2 `Auth` — authentication + domain-specific authorization

**Why not "AuthPolicy" or "AuthStore"?** The contract *decides* and stores
nothing: token secrets live behind `TokenStore`, sessions live in the auth
system's own database.

**The contract is domain-specific — no imposed role ladder.** An earlier
draft had users return `"read" | "write" | "admin"` scopes; that imposes
*our default token implementation's* vocabulary on everyone. Instead, the
engine asks questions in the domain's own terms and the user answers
yes/no. The engine is the only party that knows what is actually being
attempted — actions are protocol facts (a receive-pack's parsed ref
commands, a merge's PR number), which is also why auth cannot live in a
fronting middleware:

```ts
/** What the caller is attempting — the engine's vocabulary, not ours. */
export type GitAction =
  | { readonly _tag: "Fetch" }                       // clone/fetch, REST reads
  | { readonly _tag: "Push";                          // receive-pack, ref writes
      readonly updates: ReadonlyArray<RefUpdate> }    //   (per-branch rules!)
  | { readonly _tag: "CreatePull"; readonly base: string; readonly head: string }
  | { readonly _tag: "UpdatePull"; readonly number: number }
  | { readonly _tag: "MergePull"; readonly number: number }
  | { readonly _tag: "ReadRepo" }
  | { readonly _tag: "UpdateRepo" }                   // visibility, default branch
  | { readonly _tag: "DeleteRepo" }
  | { readonly _tag: "CreateRepo"; readonly owner: string }
  | { readonly _tag: "ManageTokens" };

export class Auth extends Context.Service<Auth, {
  /** AUTHENTICATION: who is calling? (never fails closed on anonymous) */
  readonly authenticate: (
    headers: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<Actor, GitAuthError, RuntimeContext>;
  /** AUTHORIZATION: may this actor perform this action on this repo? */
  readonly authorize: (input: {
    readonly actor: Actor;
    /** Repo state the engine supplies (visibility, owner) — `null` for
     *  repo-less actions like CreateRepo. */
    readonly repo: RepoContext | null;
    readonly action: GitAction;
  }) => Effect.Effect<boolean, GitAuthError, RuntimeContext>;
}>()("alchemy/Git/Auth") {}
```

Users express *their* model in *their* vocabulary — org roles, per-branch
protection, PR-only workflows — because the action carries the facts:

```ts
const MyAuth = Git.AuthBetterAuth({
  authorize: ({ user, repo, action }) => {
    switch (action._tag) {
      case "Fetch":
      case "ReadRepo":
        return repo?.public || user != null;
      case "Push":
        // protected main: only the repo owner may update it directly
        return action.updates.every((u) =>
          u.ref === "refs/heads/main" ? user?.id === repo.owner : user != null,
        );
      case "MergePull":
        return user?.id === repo.owner;
      default:
        return user?.id === repo.owner;
    }
  },
});
```

**Worked backwards from `packages/better-auth`** (the exercise that shaped
this): issuance and auth UX stay *outside* the blocks — the user mounts
`auth.fetch` at `/api/auth/*` next to `git.fetch` in their worker. Per-
request decisions happen *inside* via this contract: the adapter
authenticates browser sessions with `auth.getSession(headers)` and git-CLI
Basic-auth PATs with the Better Auth API-key plugin (git cannot do cookies
or redirects — the password field carries the key), then runs the user's
`authorize` with the resolved user.

**Where the old scope ladder went**: inside `Git.AuthTokens`. The default
implementation stores `read|write|admin` on its tokens and implements
`authorize` by mapping each `GitAction` to a required scope internally —
its business, invisible to the contract. Public-repo anonymous reads are
likewise just the default `authorize` behavior (`Fetch`/`ReadRepo` on
`repo.public`), no longer a special engine rule; `readOnly` write
rejection stays in the DO because it is repo state independent of the
caller.

**Enforcement across the runtime boundary** (as implemented): the
Worker runs `authenticate` once per request and forwards the resulting
`Actor` to the DO over the trusted internal channel — the DO trusts
identity, never re-derives it, and the wire path keeps the
`ADMIN_HEADER` discipline (worker strips inbound forgeries, mints the
header only after its own timing-safe verify; pinned by a forged-header
401 test). `authorize` runs at the site that owns the action's facts:
the Worker for registry-level actions (`CreateRepo`, `ListRepos`, with
`repo: null`), the Repo DO for everything per-repo — including
`git-receive-pack`, which authorizes twice: once at entry with
`Push { updates: [] }` ("may this caller push at all?", cheap rejection
before the pack streams) and again after command parsing with the real
`updates`, which is where per-branch policies bite. The DO enriches
`token` actors from its tokens table before asking (identity is the
engine's job; the scope's *meaning* is `AuthTokens`'s). Both runtime
contexts resolve the same `Auth` layer from the one graph (§2), so
`authorize` must be a fast, pure decision — it sits on the DO hot path.

**Why have `Auth` at all, instead of "write your own auth over the top"?**
A fronting middleware can only allow or deny whole requests. It cannot see
the actions — which ref a push updates, which PR a merge targets — without
reimplementing the protocol, and it cannot stamp identity into domain
objects without smuggling it through headers, which is an auth seam
anyway, just untyped. `Auth` IS auth-over-the-top in its minimal typed
form: two functions. Implementing it from scratch is a page of code;
`Git.AuthTokens` makes fresh deploys secure by default;
`Git.AuthBetterAuth` is optional sugar. Coarse gating (rate limits, IP
allowlists) still composes by wrapping `git.fetch`.

### 3.3 Storage services — defined by domain semantics, not SQL

The repo's storage services are **storage-agnostic domain contracts**.
There is no shared `SqlClient`/`RepoSql` service and no SQL anywhere in a
contract — SQLite-in-the-DO is an implementation detail of the *default
layers*, invisible to consumers and to alternative implementations.

- **`ObjectStore`** — content-addressed object index + hot bytes:
  `getMeta(Batch)` / `readContent` / `insertStagedBatch` /
  `missingObjects` / `promoteStaged` / compaction bookkeeping. (Bulk cold
  bytes already live behind `BlobStore`.)
- **`RefStore`** — ref reads, HEAD, and the repo's **atomic commit
  points** expressed as domain operations, not exposed transactions:

  ```ts
  /** Atomically: verify CAS expectations, flip staged objects live,
   *  apply ref updates, run registered stamps (e.g. mark a pull
   *  merged). Implementations MUST make this a single atomic unit. */
  readonly commitPush: (input: CommitPushInput) =>
    Effect.Effect<CommitPushResult, RefConflict | ..., RuntimeContext>;
  ```

  Atomicity is a *documented obligation of the contract* — the default
  layer discharges it with the DO's `transactionSync`; a hypothetical
  FoundationDB/Postgres layer would use its own transactions. Cross-
  service atomicity (refs + staged objects + pull stamping) is handled by
  making the composite operation itself the contract surface — never by
  leaking a transaction handle across services.
- **`PullStore`** — pull rows + per-repo numbering (`create` allocates
  the next number atomically; how is the layer's business).
- **`TokenStore`** — mint/verify/revoke (storage behind the default
  `Git.AuthTokens`).

Default layers ship as flat `Git.{Service}DurableObject` implementations,
all provided in the user's single layer graph. The near-term win is honesty and
testability (contracts mockable without SQL fixtures; each default layer
unit-tested in isolation); the long-term win is that "swap the metadata
store" is now a layer, not a fork.

### 3.4 Worker-site services

- **`Registry`** — `owner/name → repoId` resolution + listing (contract
  over the Registry DO; a single-tenant "static registry" layer becomes
  possible for users who want exactly one repo and no registry DO).
- **HTTP groups** — `Git.Protocol`, `Git.Repos`, `Git.Refs`, `Git.Objects`,
  `Git.Pulls`, and `Git.GitHub`. Each is independently mountable in an
  Effect `HttpApi`. `Git.Handlers` exposes the corresponding handler
  objects; `Git.ApiHandlersLive` builds them over `RegistryStore`,
  `RepoStore`, `BlobStore`, and `Hasher`.

## 4. `Git.Server` — the top-level block

There is no `GitService()` and no shipped Worker. The package's largest
unit is a service:

```ts
// Open default: all six groups, with the shared handler implementation.
const GitLive = Git.ServerLive.pipe(
  Layer.provide(Git.ReposDurableObject),
  Layer.provide(Git.RegistryDurableObject),
  Layer.provide(Git.HasherInline),
  Layer.provide(Git.BlobStoreR2(GitObjects)),
);

// A custom management API: select a group, attach middleware, and implement it.
class ManagementApi extends HttpApi.make("git-management")
  .add(Git.Repos)
  .middleware(Authenticated) {}

const ManagementLive = HttpApiBuilder.group(ManagementApi, "repos", (h) =>
  Effect.map(Git.Handlers, (git) => h.handleAll(git.repos)),
);

const ManagementServer = Git.Server.layer(ManagementApi, ManagementLive).pipe(
  Layer.provide(Git.ApiHandlersLive),
  Layer.provide(AuthenticatedLive),
  // provide the storage and hasher layers as above
);
```

`Git.Server` exposes `fetch`, so users can mount it whole, nest it under
another router, or register the exported API groups directly.
`Server.layer` mounts `Git.InternalApi` separately from application
middleware. A host that builds its own router can pair `InternalApi`
with `Git.InternalLive`. Users own the `Cloudflare.Worker`, its bindings,
domains, assets, and Durable Object exports.

Consequences accepted: this is a **breaking change** — `GitService()` and
the internal `GitWorker` class are deleted, and the example app becomes
the reference assembly (its own Worker + `Git.ServerLive` + default
layers + its one-origin SPA front door).

## 5. Migration phases

Each phase lands green on the full suite before the next starts.

- **Phase A — `BlobStore`.** Define the contract + `R2`/`Memory` layers;
  refactor the six consumers and the Worker splice onto it; delete the
  `bucket` leak from `ObjectStore`. Pure refactor, no behavior change.
  Then add `Git.BlobStoreS3` + a live S3-flavored test (deploys the DO with
  the S3 layer against a real bucket).
- **Phase B — `Auth` + DO-site services.** Extract `RefStore` /
  `PullStore` / `TokenStore` / `ObjectStore`-as-service; `RepoObject`
  becomes choreography. `Auth` replaces the scattered
  `parseBasicOrBearer`/`verifyAdminKey` call sites.
- **Phase C — plane split + `Git.Server`.** Native HTTP groups exported
  individually; `Git.Server` service + `Git.ServerLive`/`Git.Server.layer(api, groups)`;
  DO classes re-exported by users (no subclass factory); **`GitService()`
  and the shipped `GitWorker` deleted**; the example app rewritten as the reference
  assembly; tests re-pointed at a fixture assembly; docs (`@layer` pages
  per block, assembly guide). All documentation and examples compose with
  `Layer.mergeAll`/`Layer.provide` into a single layer handed to one
  `Effect.provide` — chained `Effect.provide` calls are a lint-level
  error in this package.

## 6. AWS-native assembly (no Durable Objects) — parity analysis

> **Status: DEFERRED.** Lambda cannot accept streaming/large request
> bodies (6 MB sync-invoke cap, base64 overhead → ~4.5 MB effective), so
> there is no serverless answer for `receive-pack` on AWS today. The
> practical AWS path is Durable Objects hosted on ECS (Atypus), which is
> separate ongoing work. This section is kept as the design record; the
> project focus is Cloudflare-native assemblies.

What the Repo DO actually provides, and the AWS-native replacement for
each. The pure `Protocol/` codec layer, `BlobStore` (S3 layer shipped), and
the HTTP planes (Effect `HttpApi`/`HttpRouter` — portable to alchemy's
Lambda hosts) need **no** work. The rest:

| DO capability | AWS-native replacement | difficulty |
|---|---|---|
| refs CAS | DynamoDB conditional writes | easy |
| `commitPush` atomicity (refs + staged flip + pull stamp) | `TransactWriteItems` (100-item cap) — **requires the push-epoch redesign** | medium |
| push semaphore | mostly unnecessary: staging is content-addressed and idempotent; losers fail at the commit CAS. Optional lease lock for resource hygiene | easy |
| object index + hot bytes (SQLite rows) | metadata items in DynamoDB (`BatchGetItem` ×100 for `missingObjects`/`getMetaBatch`); bytes in S3 from day one (DynamoDB's 400 KB item cap rules out the 1 MiB inline tier) | medium |
| commit graph + merge-base walks (10k sub-ms SELECTs) | batched-frontier BFS over `BatchGetItem`; acceptable for PR-sized divergence, painful for deep walks — **reachability bitmaps get promoted from optimization to prerequisite** | hard |
| wire-plane hosting (streaming HTTP both directions) | **the real blocker, and it is not DynamoDB**: Function URLs stream *responses* (up to 200 MB, bandwidth-capped past 6 MB) but **not requests** — the request body is buffered into the invocation event under the 6 MB sync-invoke cap (binary is base64-encoded into that JSON, so ~4.5 MB effective), which breaks any non-trivial `git push`. Options: (a) Fargate/App Runner container for the wire plane (no caps, long-lived), (b) a two-phase push (presign → S3 → commit) which stock git clients cannot speak, or (c) accept a push cap. Clones are fine — response streaming covers upload-pack, and presigned S3 bundle URLs make the serving plane *better* than the DO splice (zero compute) | hard |
| alarms (compact / bundle / gc / purge) | SQS delayed messages or EventBridge Scheduler one-shots enqueued at the commit point | easy |
| Registry DO | DynamoDB table, conditional create | easy |
| tokens / pulls tables | DynamoDB tables (PPR) | easy |

**Single-table design is mandatory.** The DynamoDB stores above are one
table, not five: everything keys as `PK = REPO#<repoId>` with typed sort
keys (`REF#refs/heads/main`, `OBJ#<oid>`, `PUSH#<pushId>`,
`PULL#<n>`, `META`), plus `OWNER#<owner>` / `NAME#<name>` items for the
registry and `TOKEN#<hash>` for tokens. This is not a style preference:
`TransactWriteItems` spans items freely but the whole `commitPush`
transaction (ref CAS + push flip + pull stamp) staying in one table keeps
capacity, backup, and IAM surface singular, and the per-repo partition
key gives every store the same locality the DO gave for free. The
storage-agnostic contracts (§3.3) never see any of this — key schema is
an implementation detail of the `*Dynamo` layers, exactly as SQL never
appears in the contracts today.

**The push-epoch redesign** (the load-bearing prerequisite): today a
commit flips thousands of staged object rows live inside one SQLite
transaction — impossible under a 100-item transaction cap. Instead,
objects reference their `pushId` permanently and visibility is a single
`pushes` item flipping to `committed`; membership checks join against
committed pushes. One item flip = fits any transaction budget. Notably
this would *also* speed up the DO implementation (no bulk row flip), so
it is worth doing in Phase B regardless of AWS plans.

**Sequencing if AWS parity becomes real:** Phase B store extraction
(the prerequisite for everything — the contracts must exist before
Dynamo layers can implement them) → push-epoch redesign (benefits both
backends) → `RefStore`/`ObjectStore`/`PullStore`/`TokenStore`/`Registry`
Dynamo layers → Lambda-hosted REST + GitHub-compat planes (no size
issues, lands early) → reachability bitmaps → the wire-plane hosting
decision (Fargate container vs. capped Lambda) last, because it is the
only piece with no clean serverless answer.

Cost shape under pay-per-request: a 44k-object push ≈ 44k WCUs ≈ $0.05;
metadata reads are cheap; the closure-walk read amplification is the
number to watch, and bitmaps are what contain it.

## 7. Open questions (want your calls)

1. **S3 priority**: is `Git.BlobStoreS3` a Phase-A deliverable (proves the
   seam immediately) or is the seam + `Memory` enough until someone asks?
2. ~~Namespace~~ **Resolved**: one flat `Git` namespace —
   `Git.BlobStoreS3`, `Git.ReposDurableObject`, `Git.ServerLive`; no
   nested sub-namespaces.
3. **Registry optionality**: is the single-tenant/no-registry layer worth
   designing for now, or YAGNI?
4. **How far to shrink `RepoObject`**: Phase B as scoped keeps the wire
   protocol choreography inline. Extracting a `Protocol` service too is
   possible but touches the most battle-tested code for the least
   swappability value — I'd leave it.
5. ~~Does `Auth` absorb the identity feature?~~ **Resolved by the
   better-auth exercise**: yes — `identify()` + the `grant` variant carry
   identity, and PR authorship/merge attribution consume it in Phase B.
