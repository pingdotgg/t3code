---
name: alchemy-provider
description: Bring up a new Alchemy cloud provider (its own `@alchemy.run/<provider>` package under packages/<provider>) end to end — credentials, a distilled SDK, resources, bindings, live tests, and the patch loop that feeds live-test failures back into distilled — or extend an existing provider with a new service, or bring an existing provider up to the bar (gap audit, then waves). Use for "add a <X> provider", "create an alchemy provider for <X>", "port <X> to alchemy", "add <service> to the <X> provider", "bring the <X> provider up to par", or any work that needs a distilled SDK plus Alchemy resources tested against a live API.
---

# Building an Alchemy provider

A provider is built on a flywheel. Each turn of it makes both the SDK and
the provider more correct:

```
 1. distilled SDK ──> 2. alchemy resources ──> 3. live tests
        ^                                          │
        └──── 4. distilled patches <── wrong error / wrong schema
```

The live API is the only authority. A resource is done when its test
passes against the real provider, and every mismatch that test surfaced is
fixed in distilled rather than worked around in alchemy.

**The target is the whole provider.** "Create a provider for X" means every
resource in every service the distilled SDK covers is either implemented
and live-tested, or listed as out of scope with a reason from step 2. A
handful of foundation resources is the first wave, never the deliverable.
Cost is not a scoping reason: expensive resources are implemented like any
other (see step 6 for running their tests). The user narrows scope; the
agent does not.

**Coverage is 1:1 with the API, operation by operation.** Every
operation in every in-scope service ends up as exactly one of: part of a
resource's lifecycle, a binding, an event source, or an `internal` row
with a reason. A service with resources but no bindings is half done.
AWS is the bar: 2,846 binding services across 205 of its 212 services.
GCP reached 57 of 161 services and Azure 4 of 160; both were reported as
done. Every call goes through distilled. When distilled is missing an
operation, patch distilled (step 1); never work around it in alchemy.

The whole provider also means its non-resource deliverables: a binding
for every data-plane operation (step 5), every runtime in both forms, event
sources, and a workflow engine when the cloud runs code, framework websites on the cloud's CDN and functions (step 7, when the
cloud hosts websites), examples, the docs hub, and generated docs
(step 10). They are rows in the same index as resources, with the same
statuses. Never write "a later phase" into an agent contract without
adding those rows: on Azure, the contract said "bindings are a later
phase — do not build them", the phase never came, and 1,193 resources
shipped with zero bindings, no runtime, no examples, and docs for 4
services.

`AGENTS.md` owns the doctrines this skill relies on; read these sections
before writing code and follow them as written:

- **Package boundaries** — every provider is its own workspace package;
  core never imports it, and it reaches core only through `alchemy/*`.
- **Reconciler doctrine** — the observe → ensure → sync shape of `reconcile`.
- **Typed Error Doctrine (distilled)** — every error alchemy handles is a
  typed tag in the SDK.
- **Speed doctrine: never wait on a hang** — bounded retries, `timeout` on
  every test run, the three-iteration budget.
- **Read/Write/ReadWrite binding convention**, **Runtime-only methods**,
  and **Isolate scope vs request scope** — bindings and runtimes.
- **Documentation Generation** — JSDoc is the only docs source.
- **The Resource Factory Process** — how to fan the work out to agents.

Those rules existed while the GCP provider was built, and its first review
still found the same violations in hundreds of files. Reading the rules is
not enough: [review.md](review.md) turns each of them into a check with a
command and an expected result. Run that review at every wave boundary and
before step 10; a provider with unexplained hits is not done.

## Bringing an existing provider up to the bar

When the provider already exists (a PR in progress, or a package on
`main`), start with a gap audit instead of step 0:

1. Merge `origin/main` into the branch and type-check the package (see
   **Branch, checkpoints, and PRs**).
2. Run every check in [review.md](review.md) against the code as it is,
   and port `scripts/audit-service.ts` (step 2) to get per-service
   operation coverage.
3. Rebuild `INDEX.md` from the results: one row per missing resource,
   binding, runtime form, event source, workflow engine, website
   rework, example, docs page, and JSDoc gap, plus one per review hit
   that needs a fix (hand-written HTTP, `host.bind`, a container
   website). Existing rows keep their status only when review.md passes
   them.
4. Do the distilled work first. Missing data-plane modules, credentials
   providers, and manual specs block the bindings that depend on them.
5. Then run the waves from step 4 onward, with the same contracts as a
   new provider.

Report the audit to the user before the first wave: counts per category
and the planned waves.

## Orchestration

Fan-out work (the gap audit, the catalog in step 2, implementation waves,
fix rounds in step 8, the review gate in step 9) runs as a **workflow**
when the harness has one: Claude Code's `Workflow` tool (load its
`workflow-authoring` skill before writing the script), Grok's `workflow`
tool (its `create-workflow` skill), or the equivalent elsewhere. Run a
workflow only when the user asked for one, since it spends many agents. A workflow runs the whole wave as one
script with bounded parallelism, enforces an agent budget, and journals
every finished agent's result, so a crash costs only the agents still
running. When no workflow tool exists, launch each agent as a detached
top-level thread (`t3_thread_launch` with `workspaceStrategy: "worktree"`
in T3 Code), never a `delegate_task` subagent thread; the coordinator reads
each thread's result with `t3_thread_read`. Either way,
each agent gets the task contract from **What every agent task prompt must
include** in `AGENTS.md`, owns one distilled service, and returns the
structured result the coordinator turns into index statuses.

Coordinator duties during a long run:

- **Size agents to finish within an hour.** A service with more than about
  25 resources runs as a chain of agents over resource batches. Agents that
  run for hours hit the model's idle timeout and lose their context.
- **Read the workflow state, not only file activity.** Each status check
  counts agents by state and reads the error of every failed or cancelled
  one. A model-API outage (`auth_unavailable`, idle timeouts) looks like a
  quiet period from the file system; on Azure it went unnoticed for three
  hours. Relaunch only the rows still `missing`, with an assess-first
  contract, once the cause is gone.
- **Offer periodic status updates** when the run will take more than an
  hour, and include the index counts in each.

## Branch, checkpoints, and PRs

- Work in a fresh worktree on a branch from `origin/main`, with
  `submodules/distilled` at the commit alchemy pins plus your distilled
  branch. Never start from whatever branch the worktree happens to be on.
- Open **draft** PRs in alchemy and distilled after the first wave that
  passes live, and push a checkpoint at every wave boundary. The
  description carries the current index counts.
- Each checkpoint: rebase onto `origin/main` (distilled onto the pin
  `main` uses), type-check, push, and confirm the PR's checks actually ran.
  A PR with merge conflicts runs no `pull_request` workflows, so a stale
  green check means nothing. Dependency bumps on `main` (Effect, Node
  types) break new code; catch them at the checkpoint.
- When a rebase or pull brings in a newer version of this skill, re-read
  the whole skill and review.md before the next wave. Add an index row for
  every new deliverable, then build those rows and run review.md with a
  fresh reviewer.
- `pnpm exec tsrs -b` reads distilled's built declarations (`lib/`), while
  the test runner reads its `src/`. After distilled patches or a pin bump,
  rebuild that package before the type check, or new error types show up
  as false type errors.
- After merging `main`, type-check the provider package on its own first
  (`cd packages/<provider> && pnpm exec tsrs -b`), then the workspace. A
  newer distilled pin is the usual break: a shape that became open
  (`[key: string]: unknown`) or a renamed error tag.
- Commit with the repo's hooks. If signing or a hook hangs, ask the user;
  if they approve skipping it, run `pnpm exec oxfmt` yourself and say the
  commits are unsigned.

## Step 0 — get credentials first

**Always ask the user for credentials for the upstream provider before
anything else**, even when the request does not mention testing. Live tests
are the whole point of the loop, and a provider built without them is
unverified. Ask in one message, and name exactly what is needed:

- the auth method the provider supports (API token, service account key,
  OAuth app, access key pair) and the minimum scopes or roles the test
  resources need;
- a dedicated test account, project, or organization — never a production
  one, because tests create and nuke resources;
- account identifiers the API needs (org id, project id, default region);
- known limits of that account (plan tier, quotas, features that need an
  upgrade), so gated tests can be planned up front.

Store what the user gives you in an Alchemy profile, never in the repo:
`alchemy profile edit --profile testing --add <Provider>` (use the profile
name the user asks for). Tests select it with `--profile <name>`. Never
print a secret, write it to a tracked file, or put it in a PR, commit, or
log. If the user has no credentials, give them the exact steps to create
them (console path or CLI commands, roles to grant), offer to do it in the
browser if they allow it, and keep working on the catalog and code
meanwhile. Until credentials arrive, mark every live test as blocked in
your report; do not claim anything is tested.

## Step 1 — the distilled SDK

Every provider talks to its API through a distilled SDK
(`@distilled.cloud/<pkg>` in `submodules/distilled/packages/<pkg>`). Alchemy
never calls the API with a hand-written HTTP client.

- **No SDK yet:** follow the `distilled-sdk` skill in the submodule
  (`submodules/distilled/.agents/skills/distilled-sdk/SKILL.md`). It covers
  sourcing the spec, the mirror, convert/generate, the README, and the
  distilled PR.
- **SDK exists but is wrong** (missing typed error, nullable field, wrong
  response schema, unmarked secret): follow the `distilled-sdk-patch`
  skill (`submodules/distilled/.agents/skills/distilled-sdk-patch/SKILL.md`).
- **SDK is behind its spec:** follow `distilled-sdk-update`.

**That includes the data plane.** Bindings call the cloud's data APIs
(put a blob, send a message, read a secret), and those go through
distilled exactly like the management API that creates the resources.
AWS is the model: `sqs.sendMessage`, `s3.putObject` and
`dynamodb.getItem` are distilled operations, and AWS bindings hold no
HTTP code. Check data-plane coverage when you check the SDK. If the SDK
covers only the management API, extend it before writing a binding:

- **The spec has a data-plane model** (Azure's
  `specification/<service>/data-plane/`, GCP's data APIs in discovery
  docs): extend the converter to include it, as its own service module
  (`storage-queue`, `keyvault-secrets`).
- **The API has no published spec** (Kudu zip deploy, a CLI-only
  endpoint): write the model by hand in the package's `manual-specs/`.
- **The protocol isn't HTTP-shaped** (XML bodies, SAS signing, a token
  audience per data plane): add it to the distilled protocol, not to
  alchemy.
- **Credentials from the runtime's identity endpoint** (managed identity,
  metadata server, container credentials) are a distilled credentials
  provider, like AWS's `fromContainerMetadata`. A binding never fetches
  its own token.

On Azure, the converter skips `data-plane/` (`scripts/convert.ts`), so
the agent hand-wrote XML request builders for Storage queues and blobs,
Key Vault secrets, Service Bus, Event Hubs, a static-website uploader, and
a managed-identity token cache: 22 raw request sites, with no typed
errors and no tests against a spec. Don't repeat it. Stop and extend
distilled.

Raw `HttpClient` calls are allowed only for:

- URLs the API hands back to you to use as-is (a presigned or SAS upload
  URL, a signed download URL);
- the user's own deployed endpoints (calling a Worker, Function, or
  service the stack deployed).

Each one carries a comment saying which case it is.

If a skill file is missing at the pinned submodule commit, read it from
distilled `main`: `git -C submodules/distilled fetch origin main && git -C
submodules/distilled show origin/main:.agents/skills/<skill>/SKILL.md`.

Distilled changes land as their own PR in `alchemy-run/distilled`. After
it merges, move the submodule pin in alchemy to the merged commit
(`git -C submodules/distilled checkout <sha>` then commit the gitlink) and
run `pnpm install` so the workspace links the package.

## Step 2 — catalog and scope

Catalog **every** service module in the SDK
(`ls submodules/distilled/packages/<pkg>/src/services`) before writing
resources; for a large SDK, fan the catalog out as a workflow (see Orchestration). Each service gets
`processes/<Provider>/catalog/<service>.md` in that section's format:
resources, props with replacement rules, attributes,
lifecycle-to-operation mapping, bindings, testability, and priority.
`processes/` is gitignored, so the catalog is the local order book; the
committed record of scope is the overview page below.

Each catalog file also lists **every operation** in the service module,
classified the way `scripts/audit-service.ts` classifies AWS:

| Category | Meaning | Becomes |
| --- | --- | --- |
| `resource-lifecycle` | create/get/update/delete/list of the resource itself | a resource's `reconcile`/`read`/`delete`/`list` |
| `binding` | data-plane work on or inside a resource (put an object, send a message, query a table, read a secret, invoke a function) | a `Binding.Service` + `<Op>Http.ts` |
| `event-source` | the resource triggers runtimes (notifications, streams, subscriptions) | an event source |
| `internal` | not useful from user code (long-running-operation polling, deprecated aliases) | nothing, with a reason |

Read operations a user calls at runtime (get an item, list objects,
describe a queue's depth) are bindings even when a lifecycle uses them
too. Port `scripts/audit-service.ts` to the provider before the first
wave (it reads the distilled module and the package and prints the gaps),
and run it per service at every wave boundary.

`processes/<Provider>/catalog/INDEX.md` has one row per resource and one per binding with a
status of `missing`, `implemented`, `tested`, `blocked` (with the exact
error), or `out-of-scope` (with the reason). Build waves from it and repeat
until no row is `missing` or `implemented`. Every progress report and the
final report quote its counts per status; "done" while any in-scope row is
`missing` is a false claim.

The first line of `INDEX.md` records the skill version it was built
against: `Skill: <sha>`, from `git log -1 --format=%H --
.agents/skills/alchemy-provider`. Update it after re-reading a newer skill.

Decide scope per resource and record the out-of-scope list in the
provider's website overview under an "Out of scope" section:

- **In scope:** infrastructure the user configures and owns (databases,
  buckets, queues, networks, keys, functions, DNS).
- **Out of scope** (the only valid reasons): end-user data APIs (mail, calendar, documents, videos),
  APIs that need end-user OAuth scopes, deprecated or retired APIs,
  billing/subscription objects, closed-beta endpoints, and duplicates of
  another service.

Fix public names now; renaming after release is a breaking change.
Service namespaces are PascalCase (`AccessContextManager`), and resource
names are correct English singulars (`Index`, not `Indexe`; `Process`, not
`Processe`). Audit generated names by eye before the first PR.

## Step 3 — the provider package

A provider is its own workspace package, `@alchemy.run/<provider>` in
`packages/<provider>`, following **Package boundaries** in `AGENTS.md`.
Copy the closest small package: `packages/axiom` (token auth, flat
resources) or `packages/hetzner` (labels, `list`, nuke ordering, bindings,
a hosted runtime, websites). A package holds:

| File | Purpose |
| --- | --- |
| `package.json` | name, shared alchemy version, publish metadata, `exports`/`publishConfig` (generated, below), `alchemy.contributes`, dependencies |
| `tsconfig.json` | composite project; references the distilled package, `distilled/core`, and `../alchemy` |
| `scripts/build.ts` | copied verbatim from a sibling package |
| `src/Contributions.ts` | `Contributions.make({ name, auth, … })` — what the CLI, the Alchemist API, and the test harness load without the user's stack |
| `src/AuthProvider.ts` | `makeStoredAuthProvider` fields, CI env vars, `<Provider>Auth` layer |
| `src/Credentials.ts` | `fromAuthProvider()` = `lazyCredentials<Resolved, ConfigError>()(...)` → the distilled `Credentials` layer |
| `src/Providers.ts` | `ProviderCollection` + `providers()` layer (provider layers, credentials, `FetchHttpClient`, auth, profile and credential stores) |
| `src/<Provider>Bindings.ts` | how bindings reach the cloud from any host (step 5) |
| `src/globals.d.ts` | `import type {} from "alchemy/Phase";` so `globalThis.__ALCHEMY_RUNTIME__` type-checks |
| `src/index.ts` | re-exports every resource, binding, and layer; `export * as <Service> from "./<Service>/index.ts"` |
| `src/Labels.ts` / tags helper | ownership labels, if the API supports labels or tags |
| `src/Bootstrap.ts` | process entry for a hosted runtime, if the cloud runs code (source-only export) |
| `README.md` | npm readme: short intro, install line, one complete type-checked example, absolute `https://alchemy.run` links |

`Contributions.ts` is imported on every CLI start, so it holds metadata and
`Contributions.lazy(() => import(...), pick)` fields only. Contribute `auth`
always; add `stateStores`, `cli`, `testServices`, and `devEnv` when the
provider has them (`packages/aws/src/Contributions.ts` uses all of them).
Declare it in `package.json`:

```json
"alchemy": { "contributes": ["@alchemy.run/<provider>/Contributions"] }
```

Never hand-edit `exports`. Run `pnpm exports:sync` after adding or
removing a service directory; CI runs `pnpm exports:check`. Modules other
packages must not import are named `internal.ts` or live under
`internal/`. Dependencies: `@distilled.cloud/<pkg>` and
`@distilled.cloud/core` are `dependencies`; `alchemy` and `effect` are
peer + dev dependencies; another `@alchemy.run/*` package is a dependency
only when every user needs it, otherwise an optional peer.

Register the package everywhere the repo enumerates providers. Find the
full list by grepping for an existing package (`git grep -il hetzner --
':!packages/hetzner' ':!submodules' ':!examples'`); at the time of
writing it is:

- `package.json` — the `build:pkg` filter list and a root
  `@alchemy.run/<provider>` devDependency (the CLI finds `Contributions`
  through the project's dependencies);
- `tsconfig.json` — project references to the package and its distilled
  package;
- `packages/integration-tests/package.json` and `tsconfig.json` — the
  package, its distilled package, and the project reference;
- `.github/workflows/pkg.yml` — the `@alchemy.run[Collapsed]` group;
- `.gitignore` — `!packages/<provider>/src/globals.d.ts`;
- `stacks/nuke.ts` — `<Provider>.providers()`;
- `scripts/with-fake-profiles.sh` — fake CI credentials;
- `scripts/generate-api-reference.ts` and `scripts/fix-api-jsdocs.ts` —
  the package's `src` root and provider prefix;
- `packages/integration-tests/test/Bundle/ProviderBootstraps.test.ts` —
  every `Bootstrap` the package ships;
- `website/astro.config.ts`, `website/src/components/ProviderDirectory.astro`,
  `website/scripts/generate-llms-txt.ts`, and
  `website/src/content/docs/<provider>/` (`index.mdx`, `setup.mdx`) —
  sidebar, directory card, llms.txt, overview, and setup page.

Core (`packages/alchemy`) never changes to add a provider. If a provider
seems to need a core change (a new auth registry entry, a CLI command, a
state store), it is a `Contributions` field instead.

Configuration such as region, project, or account comes from the
credential/profile or from a layer the user provides (the AWS
`AWS.Region(...)` pattern). Do not invent environment variables for it;
env vars exist only for CI credentials and for values the runtime platform
itself sets.

If `providers()` wires hundreds of resources, memoize it
(`let cached; export const providers = () => (cached ??= make())`) and keep
nested `Layer.mergeAll` groups of about 90; an unmemoized collection
rebuilds every layer per call and runs the test process out of memory.
`pnpm lint:providers` fails when a `providers()` layer leaks an `unknown`
requirement.

## Step 4 — resources

Implement each resource per **Reconciler doctrine**, co-locating the
contract and provider in `packages/<provider>/src/<Service>/<Resource>.ts`. These
are the mistakes that most often slip through review (each has a check in
[review.md](review.md)):

- **Block until ready.** `reconcile` returns only after the API reports the
  resource usable: poll the long-running operation to completion and then
  read the ready state. Use one shared operation waiter per provider with a
  per-resource time budget that matches reality (minutes for databases and
  clusters). Post-ready propagation delay is acceptable; returning early is
  not.
- **Identity changes replace.** If a user-chosen name or id is part of the
  resource's identity, `diff` returns `replace` when it changes; otherwise
  the old resource leaks.
- **Missing is not forbidden.** Only a typed not-found tag means "gone".
  A permission error treated as not-found drops the row from state and
  leaks the resource. If the API returns 403 for missing resources, patch
  distilled with a specific tag for that case.
- **Lists fail loudly and paginate.** A `list` that swallows errors reports
  "nothing here" to nuke and hides leaks. Use the SDK's paginated
  `.items(...)` stream.
- **Ownership markers go in labels or tags.** When the API has neither,
  document the fallback marker in the resource JSDoc; never put markers in
  fields users see or that change behaviour.
- **Shared helpers live once per provider** (operation waiter, not-found
  helper, label diffing). Copies per service drift apart.
- **Enable what the account needs.** Clouds that require a service to be
  switched on per account (Azure resource provider registration, GCP API
  enablement) get an idempotent enable step inside `reconcile`, so a fresh
  account deploys without manual setup.
- **Clean up after a failed create.** `read` and `delete` work when `olds`
  or parts of `output` are missing, so the next run's opening `destroy`
  removes whatever a crashed run left behind. Prove it once by interrupting
  a create.
- **SQL databases take `migrations`.** Every resource that hosts a SQL
  schema applies migrations on deploy through `@alchemy.run/sql/Migrations`;
  the provider only writes the cloud-specific call, built on its executor
  helpers (`withPgExecutor`, `makeStatementExecutor`, `splitSqlScript`). Prefer the
  cloud's HTTPS data API, then a direct or connector connection, then an
  in-network runner, and take credentials from the platform before asking
  for `migrationsUser` / `migrationsPassword`. Follow **SQL database
  migrations** in `AGENTS.md`; a SQL database shipped without migrations is
  incomplete.
- **Implement `list`** filtered to Alchemy-owned resources, and declare
  `nuke: { dependsOn: [...] }` where delete order matters, so
  `alchemy unsafe nuke` can clean the test account.

## Step 5 — bindings and runtimes

Follow the binding sections of `AGENTS.md`, then copy the AWS and GCP
packages: they are the reference for how bindings reach their host, and
most questions are answered by reading the closest existing binding. The
pattern was set by these PRs; read their descriptions when a case isn't
obvious from the code:

| PR | What it settled |
| --- | --- |
| #2260 | bindings state what they need; a `<P>Bindings` module decides how the host gets it (`packages/aws/src/AWSBindings.ts`) |
| #2347 | `Bind` / `withCredentials` effectful constructors, identity from real resources, `__ALCHEMY_HOST_IDENTITY__` bundle fold (`packages/gcp/src/GCPBindings.ts`) |
| #2267 | deploy-only services read behind the runtime guard; `*Http` bindings on local resources fail with a typed error (`packages/cloudflare/src/HttpBindingDev.ts`) |
| #2244, #2315 | no branching on another provider's host type; reach the host through `RuntimeContext` and core host services (`alchemy/WebhookHost`) |

**Cover every `binding` operation** in the catalog. Follow the AWS
shape: one `Binding.Service` per operation (`SQS.SendMessage`,
`DynamoDB.GetItem`), each with an `<Op>Http.ts` layer built on the
distilled operation, which injects the bound resource's identifier and
grants only that operation on that resource. Where the API has clear
access levels (object storage, key-value stores), also ship the
Read/Write/ReadWrite services from `AGENTS.md` on top of the per-operation ones.

Least privilege depends on the cloud's permission model:

- **Per-action permissions** (AWS IAM): grant the operation's actions on
  the resource ARN, as `scripts/audit-service.ts` checks.
- **Role-based** (GCP IAM, Azure RBAC): grant the smallest predefined
  role that covers the operation, on the resource, never the project or
  subscription. If the smallest predefined role covers much more than the
  operation, create a custom role with exactly the permissions or data
  actions it needs, and reuse it across hosts.

Every binding is a distilled call: the `<Op>Http.ts` layer wraps
`<service>.<operation>` from `@distilled.cloud/<pkg>`. If the operation
isn't in distilled (the data plane is missing, or the operation isn't
modelled), patch distilled first (step 1).

**Declare** each capability as an interface plus factory:

```ts
export interface SendMessage extends Binding.Service<
  SendMessage,
  "AWS.SQS.SendMessage",
  (queue: Queue) => Effect.Effect<(request: SendMessageRequest) => Effect.Effect<…>>
> {}
export const SendMessage = Binding.Service<SendMessage>("AWS.SQS.SendMessage");
```

**Reach any host.** A binding works on the provider's own compute and on
every other cloud's: a Lambda can bind a GCP topic, a Cloudflare Worker
an SQS queue. `src/<Provider>Bindings.ts` owns the decision and exports:

- `HostBinding` — what a binding attaches: grants (IAM statements, role
  bindings, role assignments) plus `env`.
- `Bind` — yields a tagged-template `bind`. On a host that runs as the
  cloud's own identity (`runsAsRole`, `runsAsServiceAccount`; an Azure
  managed identity) the grants go on that identity. Any other host gets an
  identity built from the provider's own resources (IAM `User` +
  `AccessKey` + `Role` on AWS, `ServiceAccount` + `ServiceAccountKey` on
  GCP), the grants go on it, and its key goes into the host's env through
  `CurrentRuntimeContext`. With no host (a script, plan-time `execute`) it
  does nothing. In a host bundle it is a no-op, so the identity resources
  drop out.
- `withCredentials(operation)` — resolves a distilled operation once when
  the layer is built: the host's ambient identity, the bound key read back
  from `RuntimeContext`, or the deployer's credentials.
- `<identity>HostBundle` — the rolldown option the provider's own host
  bundlers apply (`Lambda/FunctionBundle.ts`, `CloudFunctions/FunctionSource.ts`,
  the `ImageSource.ts` files). It sets `__ALCHEMY_HOST_IDENTITY__` (declared
  in core's `Phase.ts`) so the created-key path drops out of native bundles.

A binding layer then reads:

```ts
Effect.gen(function* () {
  const publish = yield* GCPBindings.withCredentials(pubsub.publishProjectsTopics);
  const bind = yield* GCPBindings.Bind;
  return Effect.fn(function* (topic: Topic) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* bind`GCP.PubSub.WriteTopic(${topic})`({ iam: [/* scoped to topic */] });
    }
    return (message) => publish({ topic: …, body: … });
  });
});
```

Rules the reference code follows:

- Never call `host.bind(...)` from a binding, and never allowlist the
  provider's own host types; both lose foreign hosts. The exceptions are
  host-only attachments that make no sense elsewhere, and they get their
  own helper (`AWSBindings.bindVpc`, the Cloud SQL socket mount in
  `GCP.SQL.Connect`).
- Never name another provider's resource type (`host.Type ===
  "Cloudflare.Worker"`). Write env through `RuntimeContext` (`runtime.set`
  at deploy, `runtime.get` at runtime; secrets stay `Redacted`), and use
  core host services such as `WebhookHost` for anything else a host must
  provide.
- Services that only exist at deploy (`<P>Environment.current`, the
  account or project id for a grant) are read inside the
  `!globalThis.__ALCHEMY_RUNTIME__` block. Read at layer build, they crash
  a foreign host at init.
- Per-service grant helpers are constructors too (`GrantOnQueue` in
  `packages/aws/src/SQS/BindingHttp.ts`), and shared scaffolding lives in
  an unexported `BindingHttp.ts` so each `<Op>Http.ts` is a one-line
  `Layer.effect(Cap, make…({ … }))`.
- A provider with local emulation fails an HTTP binding to a locally
  emulated resource with a typed error naming the native binding and
  `Alchemy.remote()` (`HttpBindingUnsupportedInDev`).

Document any grant broader than the bound resource (a condition on a
project-level grant, say) in the binding's JSDoc, with the reason.

### Runtimes

Find every **runtime** in the catalog: a resource that runs the user's
code (functions, containers, services, workers, jobs, VMs that run a
program). Mark each one `runtime` in `INDEX.md`. Each ships in two
forms from the same resource:

**Effectful** — a class built with core's `Platform` (`alchemy/Platform`).
`main: import.meta.url` makes the file both the bundle entry and the
program. Construction binds resources, and the returned handlers run per
request:

```ts
export default class Api extends GCP.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const db = yield* GCP.Firestore.ReadWriteDatabase(Links);
    return {
      fetch: Effect.gen(function* () {
        const doc = yield* db.get("links/home");
        return yield* HttpServerResponse.json(doc?.fields ?? {});
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GCP.Firestore.ReadWriteDatabaseHttp)),
) {}
```

**Async** — the same resource called as a plain function, with `main`
pointing at an ordinary handler file and no Effect. Alchemy bundles that
file as-is, with no Effect runtime in it. The `env` prop takes resources,
`Config` values, and literals, and `<Provider>.InferEnv<typeof Fn>`
types the handler's `env` argument:

```ts
// alchemy.run.ts
export const Ping = Railway.Function("Ping", {
  project: Site,
  main: "./src/ping.ts",
  env: { DATABASE_URL: db.connectionUri },
});
export type PingEnv = Railway.InferEnv<typeof Ping>;
```

```ts
// src/ping.ts
import type { PingEnv } from "../alchemy.run.ts";

export default {
  async fetch(_request: Request, env: PingEnv) {
    return new Response(env.DATABASE_URL ? "ok" : "missing");
  },
};
```

Copy both forms from the runtime closest to yours:

| Runtime | File | Notes |
| --- | --- | --- |
| Cloudflare Worker | `packages/cloudflare/src/Workers/Worker.ts`, `InferEnv.ts` | the full reference: `env` entries become native bindings |
| Railway Function | `packages/railway/src/Function.ts`, `InferEnv.ts` | bindings are env vars, so `InferEnv` maps to `string` |
| GCP Cloud Run, Hetzner Service | `packages/gcp/src/Run/Service.ts`, `packages/hetzner/src/Service.ts` | `Platform` over a container or process |
| AWS Lambda | `packages/aws/src/Lambda/Function.ts` | async form exists but has no `InferEnv`; don't copy that gap |

Every runtime needs:

- **Both forms**, each with its own JSDoc section (`### Effect …` and
  `### Async …`) showing the stack declaration and the handler file.
- **`InferEnv`** exported from the package, so async users get a typed
  `env` without writing the type by hand.
- **The `HostBinding` contract** on the resource, so effectful bindings
  from this and other providers can attach grants and env.
- **The host bundle option** (`<identity>HostBundle`) on the effectful
  bundle, and a source-only `Bootstrap` export for the process entry
  (`packages/hetzner/src/Bootstrap.ts`, `packages/aws/src/Bootstrap/`).
- **Event sources** for what the cloud triggers it with (queues, topics,
  storage events, schedules), shaped like AWS `SQS.QueueEventSource` and
  Cloudflare cron. Their contract lives in the source service and each
  runtime provides an implementation layer.
- **A Website target** when the runtime is how the cloud serves
  server-rendered pages (step 7).
- **Tests for both forms**: a fixture per form under
  `test/<Provider>/<Service>/fixtures/` (`effect-worker.ts` and
  `async-worker.ts` in `test/Cloudflare/Images/` are the pattern), each
  deployed and called over HTTP.

### Workflow engine

If the cloud has a durable execution engine, the provider ships an Effect
workflow engine on it, so `alchemy/Workflows` code runs there unchanged.
Follow **Effect workflow engines** in `AGENTS.md`: it covers the DX to
keep, the two engine shapes, the shared encoding module, and the eight
conformance cases.

| Cloud | Engine | Status |
| --- | --- | --- |
| Cloudflare | `Cloudflare.Workflows.NativeEngine` (Cloudflare Workflows), `DurableObjectEngine` | done, in-process |
| AWS | `AWS.Lambda.WorkflowFunction` + `DurableFunctionEngine` (Lambda durable functions) | done, host + remote |
| Azure | Durable Functions on the Durable Task Scheduler (`Azure.DurableTask.Scheduler` exists) | missing |
| GCP | no code-first durable runtime; Cloud Workflows is a YAML orchestrator | decide and record in the catalog before building |

Research the cloud's engine in step 2 and record it in the catalog: its
durable step, durable sleep, external-event or callback primitive, how a
run is interrupted, and its limits. Then decide the shape:

- **In-process** when the runtime that starts runs can also host the
  durable construct (Cloudflare). The engine is a Layer provided next to
  the workflow Layers.
- **Host + remote** when runs need a dedicated durable runtime (Lambda
  durable functions, and most likely Azure Durable Functions). Ship a
  `<Runtime>.WorkflowFunction`-style host that lists its workflows, and a
  `<Runtime>Engine(...hosts)` Layer that routes to it and grants access.

If the cloud has no durable engine, or only one that can't run code
steps, write `out-of-scope` with the reason on the engine's index row.
Don't build a database-backed engine of your own.

The engine counts as a runtime: it gets its own index row, the
conformance suite, an `examples/<provider>-effect-workflows` example, and
a `compute/effect-workflows.mdx` page in the docs hub.

## Step 6 — live tests

Tests live in `packages/integration-tests/test/<Provider>/` (paths below
are relative to `packages/integration-tests`). Write them per the test
sections of `AGENTS.md` (`test.provider`,
`stack.destroy()` at start and end, deterministic names, out-of-band
verification through distilled, typed wait-until-gone). Run with the
profile from step 0:

```sh
pnpm test:integration test/<Provider>/<Service>/<Resource>.test.ts --profile testing --retry 0
```

What a test must prove:

- **Every resource has its own test file**
  (`test/<Provider>/<Service>/<Resource>.test.ts`). Deploying a resource
  as a dependency inside another resource's test does not count, because
  its own update, replace, and delete paths never run.
- **Lifecycle runs by default.** Create, update, and (where applicable)
  replace against the real API. Slow lifecycles are gated behind one
  provider-wide flag with a realistic timeout; entitlement-bound ones keep
  an ungated probe that asserts the one specific typed tag the account
  returns.
- **Bindings run inside a deployed host** (a fixture Worker, Function, or
  container calling the binding over HTTP) so the IAM grant or native
  binding is exercised with the host's identity, not the deployer's. Test
  both paths of `Bind`: the provider's own host, and a foreign host using
  the created key in `test/<Provider>/ExternalHost/CloudflareWorker.test.ts`
  (copy `test/GCP/ExternalHost/`). If the provider hosts code, also add
  its host to the other providers' external-host suites
  (`test/Cloudflare/ExternalHost/Lambda.test.ts` is the pattern).
- **Every binding has a test.** One `describe("<BindingName>")` per
  binding, all driving the same deployed fixture host
  (`test/AWS/DynamoDB/Bindings.test.ts` + `handler.ts` is the pattern).
  A binding no test calls from a host is not done.
- **Assertions can fail.** No always-true checks, no lists of acceptable
  tags, no early `return` that skips the assertions.

**Expensive resources** (dedicated clusters, large VMs or databases,
reserved capacity, anything billed per hour at a noticeable rate) are
implemented and get full tests, but you do not run those tests on your own.
Gate them behind the provider-wide slow flag, mark them `blocked: cost` in
the index, and list them for the user with an estimate of what one run
costs. Run them only after the user says so.

Scarce account quotas (networks, clusters, IP addresses) are shared with a
semaphore in a test helper, or moved to less-used regions. The suite still
runs in one process: `pnpm test:integration test/<Provider> --profile testing`.

Unblock account prerequisites in the dedicated test account yourself as
soon as a test hits them. Request quota increases and register preview
features through the provider's API (anything that raises spend needs the
user's go-ahead from step 0 or step 6's cost rule),
and put any setup a fresh account would need again into the test helper.
Do one-time console work (free trials, free organizations, sign-ups) in the
browser with whatever browser-automation skill the harness has, and ask the user only to sign in.
A row stays `blocked` only when it needs payment, a vendor's approval,
hardware, or is skipped under the long-tail rule below; report each one
with the exact request that would unblock it.

Failure-path tests assert the typed error and finish in minutes. Give them
a short timeout and never let them wait out a slow provisioning or delete;
a single test case that runs for an hour is a bug in the test.

Stop chasing the long tail after the three-iteration budget from the
**Speed doctrine** in `AGENTS.md`, or as soon as the user says so. When the
remaining failures are slow provisioning, platform behavior, or test
infrastructure the cloud needs (a reachable endpoint, a custom image),
let the current run finish, then skip-gate each failing case with its
exact error, mark the row `blocked: skipped` in the index, and list those
rows in the next report so the user can reopen any. When the user sets a
deadline, cap test fixing at half of it and spend the rest on the other
deliverables (bindings, runtime, websites, examples, docs, PR). On Azure,
fix rounds on one-hour tests kept running after the user asked to skip
them, until the user set a one-hour deadline to wrap up.

## Step 7 — framework websites

**Skip this step when the provider can't host a website.** Most
providers can't: observability, payments, databases, and auth (Axiom,
Stripe, Turso, PlanetScale) have no web hosting, so they ship no
`Website` namespace and get no "N/A" rows in the index. This step is
for providers that serve HTTP or static files.

Those providers ship `<Provider>.Website.<Framework>` composites, so a
user deploys an Astro or Next.js app with one call:

```ts
const site = yield* AWS.Website.Astro("Site", { rootDir: "./web" });
```

### Use the cloud's web hosting, not a container

A website deploys onto the infrastructure the cloud built for websites:
static assets on a CDN, and server rendering on the cloud's serverless
functions behind that same CDN. Putting the whole build in a container
or an always-on VM, with no CDN, is the lazy default. It is not done,
even though it works for every framework on the first try.

Azure's first pass did exactly that. All 14 frameworks, the static-only
ones included, became a Docker image on Container Apps. A follow-up moved
static builds to a Storage static website and server builds to an
always-on App Service plan, with Front Door optional. That is still a
VM instead of functions, and no CDN by default. GCP's composites still
deploy a Node image to Cloud Run for every framework, `StaticSite`
included. Copy neither.

Pick the hosting per cloud before writing code, and record the choice
and its reason in the catalog:

| Kind of provider | Static assets | Server rendering | Reference |
| --- | --- | --- | --- |
| Hyperscaler with a CDN and functions | object storage behind the CDN | serverless functions as the CDN's dynamic origin | `packages/aws/src/Website/` (S3 + CloudFront + Lambda, `SsrSite.ts`) |
| Edge platform | the platform's asset hosting | the platform's functions | `packages/cloudflare/src/Website/` (Workers + static assets) |
| Platform with its own function runtime | the platform's asset hosting | its functions, through a framework target | `packages/neon/src/Website/` (`frontend-frameworks/<framework>/neon.ts`) |
| Containers or VMs only | served by the same Node server, behind the platform's CDN when it has one | the Node server | `packages/fly/src/Website/`, `packages/hetzner/src/Website/`, `packages/railway/src/Website/` (`Cdn.ts`) |

What that means for the clouds still to be built:

- **Azure:** Static Web Apps, or Blob static website behind Front Door,
  with server rendering on Azure Functions (Flex Consumption). Not
  Container Apps, not an App Service plan.
- **GCP:** a Cloud Storage bucket behind Cloud CDN on an external
  HTTPS load balancer, with Cloud Run or Cloud Functions as the
  serverless origin for server rendering. Assets-only sites
  never run a container.

Rules:

- An assets-only build (Vite, StaticSite, SPA output) never runs compute.
- The CDN is on by default, not behind a `cdn: true` flag. Assets are
  uploaded with content hashes and cache headers, and a deploy
  invalidates or purges what changed (`AssetDeployment.ts` +
  `CloudFront.Invalidation` on AWS).
- Server rendering runs on functions that scale to zero. A container or
  VM is acceptable only when the cloud has no function runtime, or when a
  framework needs a long-lived process. Document that framework's reason
  in its JSDoc.
- Functions need a framework target: a new
  `packages/frontend-frameworks/src/<framework>/<provider>.ts` next to
  `aws.ts`, `cloudflare.ts`, and `neon.ts`, producing a handler for the
  cloud's function runtime. Only container/VM providers use the Node
  target (`@alchemy.run/frontend-frameworks/<framework>/node`) through
  core's `alchemy/Website/Server`.
- Before choosing a container, check whether the cloud's docs have a
  hosting page for the framework (Azure Static Web Apps has one for
  Next.js, Nuxt, Astro, and SvelteKit). If they do, use what it uses.

### Layout

Ship the same framework set as the existing providers (`ls
packages/aws/src/Website` and `packages/hetzner/src/Website`: Astro,
Foldkit, Nextjs, Nuxt, Octane, ReactRouter, SolidStart, StaticSite,
SvelteKit, TanStackStart, Vinext, Vite, Vocs, Waku):

- `FrameworkSite.ts` owns `makeFrameworkSite`, which builds through the
  framework integration (`@alchemy.run/frontend-frameworks/<framework>`)
  and deploys the output onto the hosting above. Its shared props
  (`rootDir`, `memo`, `dev`, `env`, `assets`, `domain`, `tags`) keep the
  names and meaning the sibling providers use.
- One small file per framework that only sets the framework specifier, the
  deploy target, and the framework's own option block.
- `StaticSite.ts` for assets-only sites, and `index.ts` exported from the
  provider barrel as `export * as Website from "./Website/index.ts"`.

Each framework gets a live
`packages/integration-tests/test/<Provider>/Website/<Framework>.test.ts`
that asserts the response comes through the CDN (a cache header, or the
CDN hostname) and that a server-rendered route hits the function; a
`<Framework>.local.test.ts` for `alchemy dev`; and a shared
`PropSurface.test.ts`. It also gets an `examples/<provider>-website-<framework>`
example listed in `scripts/test-examples.ts`, and a page under
`website/src/content/docs/<provider>/frontend/`.

## Step 8 — close the loop

Every failure the live run exposes is classified before it is fixed, in
this order: **provider bug > distilled patch > test fix**.

| Symptom | Fix |
| --- | --- |
| `Unknown<Pkg>Error`, or a status/message you want to branch on | typed error patch (`distilled-sdk-patch`) |
| decode failure, field null or missing on the wire | nullable/optional patch |
| secret returned as a plain string | sensitive patch |
| resource leaks, returns before ready, wrong replace | provider fix in alchemy |
| test asserts something the API does not promise | test fix |

After a patch, regenerate only that package (`pnpm generate <pkg>` in the
submodule) and rerun the test immediately — the test runner reads distilled
from `src/`, so there is nothing to build. Collect the patches, prove each
with `pnpm patches:audit`, and ship them as a distilled PR, then bump the
pin (step 1).

After a full run, list what is still alive in the test account
(`pnpm nuke --dry-run --profile testing --include <Provider>.*` or the
provider's list calls). A green test that
leaves resources behind is a provider bug.

## Step 9 — review gate

Run every check in [review.md](review.md) with a fresh reviewer subagent
and fix what it finds. Report the result table to the user with the
counts, so they can see what was checked without re-reviewing by hand.

## Step 10 — docs, examples, and the PR

- JSDoc on every resource, prop, attribute, and binding, to the bar in
  [docs.md](docs.md#api-reference-jsdoc): runtimes as complete as
  `AWS.Lambda.Function`, fat-head resources as complete as S3 Bucket or
  R2 Bucket, and a creation example plus replacement cautions for the
  long tail. Then run `pnpm docs:check-jsdoc` and `pnpm docs:gen`.
- The hand-written hub at `website/src/content/docs/<provider>/`, built
  to [docs.md](docs.md): the AWS hub's structure (Overview, Setup, a
  five-part tutorial, sections by concern), code taken from tested
  examples, and the voice rules there. A hub of loose "guides" that walk
  the examples is not done; GCP's had to be rebuilt.
- The example set described under **Examples** below.
- Type-check with `pnpm exec tsrs -b`, run `pnpm exports:check` and
  `pnpm lint:providers`, and format with `pnpm exec oxfmt`.
- Open the alchemy PR per **Pull Request Conventions**, linking the
  distilled PRs it depends on. The description shows the provider's DX,
  not a list of what was built:
  - One or two lines on what the package is, then a few bullets of
    counts (services, resources, live test files, gated tests).
  - A `###` section for every runtime (each form), the event sources,
    and the websites.
  - A `###` section for each **fat-head** resource: the 10–20 that most
    apps on this cloud use (resource groups or projects, identity and
    roles, object storage, the main SQL and document databases, queues
    and topics, secrets, the container registry, networking and DNS,
    logs). Pick them from the cloud's own quickstarts, not from the
    catalog's order. Group a resource with the ones it's always used
    with (a namespace and its queue) and its bindings.
  - Each section is one or two sentences, then one snippet copied from
    that resource's JSDoc example, so the code is already checked.
  - One closing line names the long tail and points to the generated
    reference. Don't list it.

  Don't show a binding running in a host unless a test deploys it that
  way. On Azure, the description was going to show bindings inside
  `Azure.Functions.Function`, which isn't a registered binding host, so
  those bindings did nothing.

### Examples

Examples are how users learn the provider, and the docs hub copies its
code from them. Ship a comprehensive set, not one or two. Azure's first
pass shipped `azure-storage` (a Stack with no runtime) and one website;
AWS, Cloudflare, Fly, and Hetzner ship one example per framework plus one
per workload.

**Every web framework gets its own example**, for every provider that
hosts websites: `examples/<provider>-website-<framework>`, one per
`<Provider>.Website.<Framework>` composite (Astro, Foldkit, Nextjs, Nuxt,
Octane, ReactRouter, SolidStart, SvelteKit, TanStackStart, Vinext, Vite,
Vocs, Waku, plus `<provider>-static-site`). `ls examples | grep
hetzner-website-` is the complete set to match.

**Then one example per workload the cloud supports.** Go down this list
and add an example for every row the provider has, and skip the rest:

| Workload | Shows | AWS / GCP / Cloudflare reference |
| --- | --- | --- |
| Serverless function, effectful | an HTTP handler with a binding to storage or a database | `aws-lambda`, `gcp-cloud-function`, `cloudflare-worker` |
| Serverless function, async | the same with a plain handler and `InferEnv` | `cloudflare-worker-async` |
| HTTP API | Effect HTTP API or RPC on the default runtime | `aws-lambda-httpapi`, `aws-lambda-rpc`, `gcp-cloud-run-api` |
| Queue | a producer and a consumer through an event source | `gcp-pubsub-worker`, `gcp-pubsub-fanout` |
| Scheduled job | a cron trigger | `gcp-cron`, `gcp-scheduled-job` |
| Storage events | a function triggered by an upload | `gcp-storage-uploads`, `gcp-eventarc-firestore` |
| Durable workflows | `alchemy/Workflows` on the provider's engine (Step 5): start, signal, read a run | no example yet; copy the conformance fixtures in `packages/integration-tests/test/Cloudflare/Workers/fixtures/durable-workflow/` |
| Containers | a container service | `aws-ecs`, `fly-service` |
| Kubernetes | a Deployment on the cloud's managed cluster | `aws-eks`, `gcp-gke` |
| VMs | a VM running a program | `aws-ec2`, `hetzner-server` |
| SQL database | a database with migrations, from a runtime | `aws-rds`, `gcp-cloud-sql-drizzle` |
| Cache | Redis from a runtime | `gcp-memorystore-redis`, `fly-redis` |
| Secrets | a secret read by a runtime | `gcp-secrets-kms` |
| AI | the cloud's model service | `aws-bedrock-ai`, `gcp-vertex-ai` |
| Service to service | two runtimes calling each other | `gcp-service-to-service` |
| Local dev | the same app under `alchemy dev` | `aws-dev`, `cloudflare-dev` |

Name examples `<provider>-<workload>` in kebab case. Each one is a
workspace project with the layout of `examples/gcp-pubsub-worker`:

- `package.json` (private, `deploy` / `dev` / `destroy` / `test` scripts,
  `workspace:*` dependencies), `tsconfig.json` referencing
  `packages/alchemy` and the provider package, and a `README.md`.
- `alchemy.run.ts`, with the runtime and resources in `src/`.
- `test/integ.test.ts` with `@alchemy.run/test/Bun`: deploy in `beforeAll`,
  call the deployed app over HTTP, verify cloud state through distilled,
  destroy in `afterAll`. Websites and `dev`-capable apps also get
  `test/dev.test.ts`.

Register every example in the root `tsconfig.json` references and in
`scripts/test-examples.ts`, and run its test against the testing profile
before you call it done. Track examples as rows in `INDEX.md` like any
other deliverable.

A draft PR for an early wave is fine; its description states the index
counts and that the provider is incomplete.

A provider is done when:

- every SDK service is cataloged and every operation is classified;
- every in-scope resource has its own passing live test (or is
  `blocked: cost` / `blocked: skipped` and the user has the list);
- every `binding` operation is a least-privilege binding over distilled,
  goes through `<Provider>Bindings.Bind`, reaches foreign hosts, and is
  called from a deployed host in a test;
- no alchemy code makes a hand-written API call (review.md's
  "Hand-written HTTP" check is clean);
- every runtime ships both forms with `InferEnv`, its event sources, and
  tests for each form;
- the cloud's durable engine has an Effect workflow engine that passes
  the conformance cases, or is out of scope with a reason;
- the framework websites (if the cloud hosts websites) deploy to its CDN
  and functions;
- the example set (one per framework, one per workload) deploys and
  passes;
- JSDoc meets the bar in [docs.md](docs.md), the reference docs are
  generated, and the hub matches [docs.md](docs.md);
- the PR description shows the runtimes and the fat head;
- the review gate is clean, the test account is clean after a full run,
  and every SDK mismatch found along the way is a merged distilled patch.
