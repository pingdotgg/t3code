# alchemy

Alchemy Effect is an Infrastructure-as-Effects (IaE) framework that extends Infrastructure-as-Code (IaC) by combining business logic and infrastructure config into a single, type-safe program expressed as Effects.

It includes a core IaC engine built with Effect. Effect provides the foundation for type-safe, composable, and testable infrastructure programs. It brings errors into the type-system and provides declarative/composable retry logic that ensure proper and reliable handling of failures.

# Concepts

- **Cloud Provider** - a cloud provider that offers a set of Services, e.g. AWS, Azure, GCP, Cloudflare, Stripe, Planetscale, Neon, etc.
- **Service** - a collection of Resources, Functions, and Bindings offered by a Cloud Provider.
- **Resource** - a named entity that is configuted with "Input Properties" and produces "Output Attributes". May or may not have Binding Contract.
- **Input Properties** - the properties passed as input to configure a Resource. Otherwise known as the "desired state" of the Resource.
- **Output Attributes** - the attributes produced by a Resource. Otherwise known as the "current state" of the Resource.
- **Stable Properties** - properties that are not affected by an Update, e.g. the ID or ARN of a Resource.
- **Function** (aka. **Runtime**) - a special kind of Resource that includes a runtime implementation expressed as a Function producing an `Effect<A, Err, Req>`. The `Req` type captures runtime dependencies, from which Infrastructure Dependencies are inferred.
- **Resource Provider** (see [Provider](./packages/alchemy/src/Provider.ts))

A Resource Provider implements the following Lifecycle Operations:

- **Diff** - compares new props with old props and determines if the Resource needs to be updated or replaced. For updates, it can also specify a list of Stable Properties that will not be changed by the update.
- **Read** - reads the current state of a Resource and returns the current Output Attributes. May return `Unowned(attrs)` to signal an existing-but-foreign resource that the engine should refuse to take over unless `--adopt` is set.
- **Pre-Create** - an optional operation that creates a stub of a Resource before reconcile runs. Used to resolve circular dependencies — e.g. Function A and B depend on each other, so we create a stub of Function A first and then `reconcile` later wires up the real dependency.
- **Reconcile** - converges a Resource's actual cloud state to the desired state described by the new Input Properties. Called for both first-time provisioning and subsequent updates. The provider receives `output` (current Attributes) and `olds` (previous Props) which may both be `undefined` on a greenfield create, both defined on an update, or `output !== undefined && olds === undefined` on an adoption. See the **Reconciler doctrine** section below for the required shape.
- **Delete** - deletes an existing Resource. It must be designed as idempotent because it is always possible for state persistence to fail after the delete operation is called. If the resource doesn't exist during deletion, it should not be considered an error.
- **Capability** - a runtime requirement of a Function (e.g. require read access to an `R2Bucket`, or `SQS.SendMessage` on a `SQS.Queue`). A Capability is modeled as one or more `Binding.Service`s. Where the underlying API distinguishes access levels, split it into `Read` / `Write` / `ReadWrite` services (see the **Read/Write/ReadWrite binding convention** below); otherwise a single service suffices. Each service typically ships two interchangeable implementations: a native **binding** (`*Binding`) and a token-scoped **HTTP** client (`*Http`).
- **Binding.Service** - an Effect Service that exposes a `.bind(resource)` method returning a typed runtime client. Its outer (init) Effect resolves the host Function/Worker and its environment, then registers the deploy-time binding — environment variables, IAM policy statements (AWS), or a native Cloudflare binding — by calling ``host.bind`${resource}`(data)``, guarded by `!globalThis.__ALCHEMY_RUNTIME__` so it is a no-op once running inside the deployed Function/Worker. Provided as a Layer on the **Function/Worker** Effect so it gets bundled into the Lambda/Worker. See [Binding](./packages/alchemy/src/Binding.ts).
- **Binding** - data attached to a target Function/Worker via ``host.bind`${resource}`(data)`` from inside a `Binding.Service`. The binding data is collected on the Stack during plan/deploy. Bindings enable circular references between Resources — e.g. a capability binds `{ policyStatements: [...] }` (AWS) or `{ bindings: [...] }` (Cloudflare) onto the host. The Resource Provider then receives the resolved binding data in its `reconcile` lifecycle operation via the `bindings` parameter.
- **Binding Contract** - the shape of data a Resource accepts from Bindings. For example, a Lambda Function accepts `{ env?: Record<string, any>, policyStatements?: PolicyStatement[] }` because it needs environment variables and IAM policies. A Cloudflare Worker accepts `{ bindings: Worker.Binding[] }` for its native binding system. The Binding Contract is declared as the fourth type parameter on the `Resource` interface. See [Lambda Function](./packages/alchemy/src/AWS/Lambda/Function.ts) and [Cloudflare Worker](./packages/alchemy/src/Cloudflare/Workers/Worker.ts).
- **Dependency** - Resources depend on other Resources through two mechanisms:
  - Output Properties of one Resource passed as Input Properties to another Resource (non-circular, directed acyclic graph)
  - Bindings that attach data (IAM policies, env vars, Cloudflare bindings) from one Resource to another, enabling circular references between Resources.
- **Output** - a reference to (or derived from) a Resource's "Output Attributes". E.g. Bucket.bucketArn
- **Stack** - a collection of Resources, Functions, and Bindings that are deployed together.
- **Stack Name** - the name of a Stack, e.g. `my-stack`
- **Stage** - the stage of a Stack, e.g. `dev`, `prod`, `dev-sam`
- **Stack Instance** - a deployed instance of a Stack+Stage
- **Resource Type** - the type of a Resource, e.g. `Bucket`, `Instance`
- **Physical Name** - a unique name for a Resource, e.g. `my-bucket-1234567890`. It is usually best to generate them using the built-in createPhysicalName utility function which generates
- **Logical ID** - the logical ID identifying a resource within a Stack, e.g. `my-bucket`. It is stable across creates, updates, deletes and replaces.
- **Instance ID** - a unique identifier for an instance of a Resource. It is stable across creates, updates and deletes. It changes when a resource is replaced. It is truncated and used as the suffix of the Physical Name.
- **Event Source** - a special kind of Binding between a Function and a Resource that produces events that invoke the Function, e.g. `SQS.QueueEventSource`. Implemented as a `Binding.Service` whose init Effect both registers the runtime event listener on the host and, at deploy time, yields the event-source mapping resource (or calls the cloud provider API to create/update it).
- **Replacement** - the process of replacing a Resource with a new one. A new one is created, downstream dependencies are updated with the new reference, and then the old one is deleted. Or, the old one is deleted first and then the new one is created.
- **Dependency Violation** - an error that some APIs call when an operation cannot be performed because a dependency is not met. E.g. you cannot delete an EIP until the NAT Gateway it is attached to is deleted. Lifecycle operations typically retry Dependency Violations.
- **Eventual Consistency** - create/update/delete operations can be eventually consistent leading to a variety of failure modes. For example, a Resource may be created but not yet available for use, or a Resource may be deleted but still appear in the console. Errors caused by eventual consistency should be retried, and lifecycle operations/tests should be carefully designed to wait for consistency before proceeding.
- **Retryable Error** - an error that can be retried. E.g. a Dependency Violation, Eventual Consistency Error, Transient Failure, etc.
- **Non-Retryable Error** - an error that cannot be retried. E.g. a Validation Error, Authorization Error, etc.
- **Retry Policy** - a policy for retrying errors. E.g. a fixed delay, exponential backoff, max retries, while some condition is true, or until some condition is true/false, etc.

# File System Conventions

Each Service's Resources follow the same pattern. Resource contract and provider are co-located in the same file. Each Capability lives in its own file(s) named after the capability and access level (`Binding.Service` contract + the `*Binding` / `*Http` implementations).

```sh
# source files
packages/alchemy/src/{Cloud}/{Service}/index.ts         # re-exports resources, capability contracts, and impl layers
packages/alchemy/src/{Cloud}/{Service}/{Resource}.ts    # resource contract + resource provider
packages/alchemy/src/{Cloud}/{Service}/{Capability}.ts  # Binding.Service contract + runtime client interface
# test files
packages/alchemy/test/{Cloud}/{Service}/{Resource}.test.ts
# docs (auto-generated from source-code JSDoc - DO NOT manually edit)
website/src/content/docs/providers/{Cloud}/{Resource}.md  # API reference, generated by `bun generate:api-reference`
```

A capability that exposes distinct access levels is split into a contract per level plus interchangeable native-binding and HTTP implementations, with shared scaffolding kept in *un-exported* helper files (see the **Read/Write/ReadWrite binding convention** below). For example, the Cloudflare R2 bucket capability:

```sh
packages/alchemy/src/Cloudflare/R2/BucketTypes.ts          # shared types + error (exported)
packages/alchemy/src/Cloudflare/R2/BucketRead.ts           # BucketRead Binding.Service + ReadBucketClient (exported)
packages/alchemy/src/Cloudflare/R2/BucketWrite.ts          # BucketWrite Binding.Service + WriteBucketClient (exported)
packages/alchemy/src/Cloudflare/R2/BucketReadWrite.ts      # BucketReadWrite Binding.Service + ReadWriteBucketClient (exported)
packages/alchemy/src/Cloudflare/R2/BucketBinding.ts        # shared worker-binding scaffolding (NOT exported from index)
packages/alchemy/src/Cloudflare/R2/BucketReadBinding.ts    # ReadBucketBinding layer + makeRead (exported)
packages/alchemy/src/Cloudflare/R2/BucketWriteBinding.ts   # WriteBucketBinding layer + makeWrite (exported)
packages/alchemy/src/Cloudflare/R2/BucketReadWriteBinding.ts # ReadWriteBucketBinding layer (exported)
packages/alchemy/src/Cloudflare/R2/BucketHttp.ts           # shared HTTP/token scaffolding (NOT exported from index)
packages/alchemy/src/Cloudflare/R2/BucketReadHttp.ts       # ReadBucketHttp layer (exported)
packages/alchemy/src/Cloudflare/R2/BucketWriteHttp.ts      # WriteBucketHttp layer (exported)
packages/alchemy/src/Cloudflare/R2/BucketReadWriteHttp.ts  # ReadWriteBucketHttp layer (exported)
```

Examples of actual paths:

```sh
packages/alchemy/src/AWS/S3/Bucket.ts          # S3 Bucket resource + provider
packages/alchemy/src/AWS/S3/GetObject.ts       # S3 GetObject capability (Binding.Service)
packages/alchemy/src/AWS/S3/PutObject.ts       # S3 PutObject capability (Binding.Service)
packages/alchemy/src/AWS/SQS/Queue.ts          # SQS Queue resource + provider
packages/alchemy/src/AWS/SQS/SendMessage.ts    # SQS SendMessage capability
packages/alchemy/src/AWS/Kinesis/Stream.ts     # Kinesis Stream resource + provider
packages/alchemy/src/AWS/Kinesis/PutRecord.ts  # Kinesis PutRecord capability
packages/alchemy/src/AWS/Lambda/Function.ts    # Lambda Function resource + provider
packages/alchemy/src/AWS/DynamoDB/Table.ts     # DynamoDB Table resource + provider
packages/alchemy/src/AWS/DynamoDB/GetItem.ts   # DynamoDB GetItem capability
packages/alchemy/src/AWS/EC2/Vpc.ts            # VPC resource + provider
packages/alchemy/src/AWS/EC2/Subnet.ts         # Subnet resource + provider
```

# The Resource Factory Process

Alchemy resource coverage is produced as a **software factory**: fleets of agents implement and live-test IaC resources in waves, and every API mismatch the tests surface is fed back as a patch to distilled. The factory was used to take Cloudflare from 36 to 239 cataloged resources (250 test files / 600+ test cases, 1000+ patched operations) and is the template for every future provider.

## The flywheel

```
 catalog ──> implement ──> live test ──> unmatched error / wrong schema?
    ^                                          │
    │                                          v
 update statuses <── regenerate service <── patch distilled
```

1. **Catalog** — fan out research agents over the provider's distilled service modules (one batch per thematic group). Each agent reads the generated SDK (`distilled/packages/{cloud}/src/services/{service}.ts`), cross-references the vendor API docs, and writes a self-contained design spec to `processes/{Cloud}/catalog/{service}.md`: resources, namespaces, props/attrs with replacement rules, lifecycle-to-operation mapping, scope (account/zone), testability, priority. The coordinator aggregates a machine-readable `summary.json` + human `INDEX.md` that tracks `implemented | partial | missing` per resource — this is the factory's order book.
2. **Implement + test** in waves (below). Tests run against the real cloud (`bun run test --profile testing`); zone-scoped tests use the standing test zone (`alchemy-test-2.us` via `findZoneByName`).
3. **Patch the SDK, never the consumer** — every `UnknownCloudflareError`, out-of-union status error, or wrong request/response schema found by a test becomes a patch under `distilled/packages/{cloud}/patches/{service}/{op}.json` (see the Typed Error Doctrine section). Regenerate only that service. The typed union improves for every future consumer of the SDK — that is the flywheel's output.
4. **Update the catalog** statuses after each wave and pick the next batch from the order book. Repeat until everything left is documented as out of scope (deprecated APIs, billing/data-only endpoints, closed-beta, needs-external-systems).

## Orchestration rules (the coordinator)

- **One workflow at a time**, ~12 concurrent agents (cap ≈ CPU cores − 2). Two parallel workflows double throughput but also double crash blast-radius — only do it when the machine and budget clearly allow.
- **One agent per distilled service.** Service ownership is the unit of isolation: only the owner may touch `patches/{service}/` and regenerate `src/services/{service}.ts`, so generator runs never race. An agent may own several resources of its service; a very large same-service backlog (e.g. zero-trust) runs as a **sequential chain** of agents inside the workflow, in parallel with all other services.
- **Shared-file discipline.** `Providers.ts` and the provider barrel `index.ts` are edited by every agent: single minimal insertions only, re-read and retry on edit conflict, never rewrite wholesale.
- **`Layer.mergeAll` ceiling.** Keep `Providers.ts`'s provider layers in *nested* `Layer.mergeAll` groups (~90 entries each). A flat ~200-argument call exceeds tsc's variadic inference and **silently drops the tail layers** from the inferred union, producing baffling `Provider<X> is not assignable to StackServices` cascades across every test file.
- **Crash resilience.** Word every task as *assess-first*: "partial work may exist from an interrupted run — list your dirs, read existing files, check registration, FINISH rather than rewrite." Completed agent results are banked in the workflow journal even if the workflow dies; the coordinator recovers them from `journal.jsonl` and re-dispatches only the lost tasks.
- **The coordinator (not agents) does**: the authoritative type-check, distilled lib rebuilds, combined verification runs, catalog/index updates, cross-cutting fixes (shared-file restructures, Effect-version API migrations), and deterministic mass transforms (mechanical codemods are scripted centrally, not fanned out).
- **Monitor for stalls**: an agent transcript that hasn't been written for ~5 minutes with no child test process is stalled — kill and re-dispatch; don't wait.

## Resource budget: one type-checker for the whole factory

`tsc -b` over the workspace is expensive; dozens of agents running it concurrently thrashes the machine (and concurrent `tsbuildinfo` writes race). Instead:

- **Agents are banned** from running `tsc` or `bun run build` (root or distilled) in any form. The coordinator owns type-checking and runs a one-shot `bun tsc -b` at wave boundaries.
- **The test runner resolves distilled from `src/*.ts` directly, NOT the built `lib/`** (`alchemy-test` runs in plain bun, which resolves the `bun` export condition natively). So a regenerated service is **immediately test-visible** the moment `bun scripts/generate.ts --service {service}` (+ oxlint/oxfmt) finishes — there is nothing to rebuild and **nothing to wait for**. Do NOT sleep and do NOT gate a test re-run on a build after regenerating. This applies to response-schema patches as well as error-tag-only patches.

## Speed doctrine: never wait on a hang

- Run tests with `bun run test` (works from the repo root or `packages/alchemy`; suite paths are relative to `packages/alchemy`, e.g. `test/Cloudflare/...`). Wrap **every** test invocation in a hard kill: `timeout 240 bun run test <suite> --profile testing`. Hitting the wall **is** the failure — read the partial output (and the run's log under `.alchemy/log/test/`), find the hang (unbounded retry, infinite pagination, the engine deadlock below), fix the root cause. Never just re-run hoping. The runner also prints the currently-running tests whenever nothing finishes for 10s — use that list to identify the hang.
- Per-test timeout ≤ 90–120s (`{ timeout: ... }` on the test, or `--timeout` for the whole run). A suite needing more than ~3–5 minutes total is a bug.
- Every `Effect.retry`/`Effect.repeat` is bounded: `times ≤ 8–10`, total backoff under ~45–60s. Never poll for asynchronous provisioning slower than ~90s — skipIf-gate instead.
- **Known engine bug**: a deploy that *replaces* a resource while simultaneously *removing* its old dependency deadlocks. Keep both dependencies deployed across replacement steps in tests (see `test/Cloudflare/R2/BucketEventNotification.test.ts`).
- **Three-iteration budget**: if a suite is not green after ~3 fix iterations and the blocker is platform behavior (entitlement, slow async provisioning, beta API), implement fully, skipIf-gate with the typed tag and exact error, verify a skip-clean run, and report honestly. Do not burn an hour on one resource.

## Entitlement gating pattern

Most enterprise/plan-gated resources are still fully implementable; only the live lifecycle is gated:

1. **Probe once** against the real API to capture the exact rejection (code + message). If it surfaces as an untyped catch-all, patch distilled first so the entitlement error is a typed tag (e.g. `MagicTransitNotOnboarded` code 1012, `SaasQuotaNotAllocated` code 1404, `AdvancedCertificateManagerRequired` code 1450).
2. Keep an **ungated probe test** that asserts the typed tag is returned — this proves both the patch and the gating are correct, forever, at near-zero cost.
3. skipIf-gate the full lifecycle behind an env var (`CLOUDFLARE_TEST_MAGIC_TRANSIT=1`, `CLOUDFLARE_TEST_DLP=1`, …) so an entitled account can run it unchanged.
4. Record the testability verdict (`yes | limited | no`) and the exact error in the catalog notes.

Deprecated APIs (superseded by Rulesets etc.), billing/subscription objects, pure data-APIs, and closed-beta endpoints are *documented as out of scope* in `INDEX.md` rather than implemented.

## What every agent task prompt must include

A wave task prompt is a contract. Include, every time:

1. The **distilled service the agent owns** and the resources to build (with namespace + directory).
2. **Assess-first** instruction (finish partial work, don't rewrite).
3. The reading list: this file's Reconciler doctrine + Typed Error Doctrine, the catalog spec, the distilled service module + existing patches, current exemplar resources/tests (account-level CRUD, zone singleton capture-and-restore, observe-before-delete), and the registration files.
4. The **type-check/build ban** (above) — agents never run `tsc`/`bun run build`; the coordinator owns type-checking.
5. The **speed doctrine** (above) verbatim — agents rediscover unbounded waits otherwise.
6. The **Typed Error Doctrine** hard rule with the patch-regenerate command for *their* service only.
7. Registration discipline for the shared files, including the nested-mergeAll note.
8. Test requirements: `test.provider`, start **and** end with `stack.destroy()`, deterministic names (engine default or constant), out-of-band verification via distilled, typed wait-until-gone, replacement coverage where applicable.
9. Known footguns: `diff` receives `Input<Props>` — narrow with `isResolved(news)` before property access; never `Input<T>` in declared Props; Effect 4 APIs (`Effect.result` + `Result.isSuccess/isFailure`, not `Effect.either`/`effect/Either`); request-schema patch keys are camelCase, response keys are wire snake_case; fixtures (CSRs, PEMs, JWKS) are generated once and checked in as constants, never at test time.
10. A **structured result schema**: `{ service, resources, testsPassed, testCommand, files, patches (with reasons), skippedTests (with exact errors), notes }` — the coordinator aggregates these into the catalog.

# Documentation Generation

**Source of truth:** The source code is the single source of truth for all API documentation. JSDoc comments in `packages/alchemy/src/**/*.ts` are extracted and used to generate the public API reference markdown.

:::warning
**Never edit the generated markdown files** under `website/src/content/docs/providers/{Cloud}/`. They are overwritten on every regeneration.

To "update the docs", edit the JSDoc on the source `.ts` file (resource-level JSDoc on the exported `const`, plus field-level JSDoc on each prop/attribute) and re-run the generator. There is no separate doc file to update.
:::

**How to generate docs:**

```sh
bun generate:api-reference   # -> website/src/content/docs/providers/{Cloud}/{Resource}.md
```

This is the only doc generator that produces user-facing output. ([scripts/generate-api-reference.ts](./scripts/generate-api-reference.ts)) does the following:

1. Discovers resource files in `packages/alchemy/src/{Cloud}/{Service}/`
2. Parses TypeScript with `ts-morph`
3. Extracts the resource-level summary plus `@section` / `@example` blocks from JSDoc
4. Writes one markdown file per resource at `website/src/content/docs/providers/{Cloud}/{Resource}.md`

After editing JSDoc on a resource, run `bun generate:api-reference` to refresh the website docs.

**Writing good documentation:** When adding or updating a resource, ensure all Props and Attrs have JSDoc comments:

```typescript
export interface BucketProps {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * Must be lowercase and between 3-63 characters.
   */
  bucketName?: string;

  /**
   * Whether to delete all objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
}
```

The `@default` tag is used to document default values and will appear in the generated documentation.

### Examples and Sections (IMPORTANT)

**Examples are critical for documentation.** Every resource should have examples demonstrating common use cases. Use `@section` and `@example` JSDoc tags on the main Resource export to organize examples into a navigable table of contents.

**Format:**

- `@section <Section Title>` - Creates a heading in the Examples section and adds an entry to the Quick Reference table of contents
- `@example <Example Title>` - Creates a subheading for a specific code example (must follow a `@section`)
- Code blocks inside examples use standard markdown fenced code blocks (` `)

**Example:**

````typescript
/**
 * An S3 bucket for storing objects.
 *
 * @section Creating a Bucket
 * @example Basic Bucket
 * ```typescript
 * const bucket = yield* Bucket("my-bucket", {});
 * ```
 *
 * @example Bucket with Force Destroy
 * ```typescript
 * const bucket = yield* Bucket("my-bucket", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * @section Reading Objects
 * @example Get Object from Bucket
 * ```typescript
 * const response = yield* getObject(bucket, { key: "my-key" });
 * const body = yield* Effect.tryPromise(() => response.Body?.transformToString());
 * ```
 *
 * @section Writing Objects
 * @example Put Object to Bucket
 * ```typescript
 * yield* putObject(bucket, {
 *   key: "hello.txt",
 *   body: "Hello, World!",
 *   contentType: "text/plain",
 * });
 * ```
 */
export const Bucket = Resource<...>("AWS.S3.Bucket");
````

This generates:

1. A "Quick Reference" section with links to each `@section`
2. An "Examples" section with organized code examples under each section heading

**Best practices for examples:**

- Start with the simplest use case and progress to more complex ones
- Include examples for all major capabilities (GetObject, PutObject, etc.)
- Show real-world patterns like error handling, combining with other resources
- Use descriptive titles that explain what the example demonstrates

# Workflow (per-service inner loop)

This is the inner loop that each factory agent (see **The Resource Factory Process** above) executes for the service it owns — it applies equally when a single engineer brings up one service by hand.

Development of Alchemy-Effect Resources is heavily pattern based. Each Service has many Resources that each have 0 or more Capabilities and Event Sources. When working on a new Service, the following steps should be followed.

1. Research the AWS Service and identify its Resources, Identifier Types, Structs, Capabilities, and Event Sources. Refer to the corresponding Terraform Provider, Pulumi Provider, and CloudFormation docs for that service (use the provided tools specifically for searching these docs for services and resources).

Example (abbreviated):

Service: S3

Resources:

- Bucket
- BucketPolicy
- etc.

Bucket Capabilities:

- GetObject
- PutObject
- DeleteObject

Identifier Types:

- Bucket Name
- Bucket ARN

Structs:

- CorsRule
- LifecycleConfiguration

2. Document each of the Resource interfaces

Include the following information:

- ResourceName, e.g. Bucket, Instance, Queue
- Input Properties (for each property: Name, Type, Description, Default Value, Required, Constraints, Replaces: true/false)
- Output Attributes (for each attribute: Name, Type, Description)

3. Document each of the Capabilities and Bindings

Include the following information:

- Capability Name, e.g. `GetObject`, `PutObject` (it maps 1:1 with an AWS API)
- Constraints (e.g. `Key`)
- IAM Policies (how the capability maps to an IAM Policy, e.g. Effect: Allow, Action: s3:GetObject, Resource: `arn:aws:s3:::${bucketName}/${Key}`)
- Environment Variables (what environment variables should be added to a Lambda Function so that it can access the capability, e.g. `BUCKET_NAME`, `BUCKET_ARN`, `QUEUE_URL`, `QUEUE_ARN`, etc.)

4. Research and design each of the Lifecycle Operations

- **Diff** - identify which properties are always stable across any update, which properties change conditionally depending on new and old values, which properties trigger a replacement. This is usually just a distinct list, but can sometimes require if-this-then-that logic. Document it explicitly and exhaustively. Cross-reference with AWS CloudFormation, Terraform Provider and Pulumi Provider docs.

:::warning
You should almost never use `no-op` in the Diff. No-op should be explicitly designed as a way to say "i know this property changed, but i don't want it to trigger an update". This is an edge-case and not the norm. Usually you want diff to return `undefined` or `void` to let the engine apply the default update logic. Diff is usually just use as an optimization or to identify replacement instead of update.
:::

- **Read** - determine which API calls are required to read the Output Attributes of a Resource from the Cloud Provider state (otherwise known as refresh or synchronize resource state). This is usually a single Get{Resource} API call, but can be a complex set of calls depending on the Service. Read can also be called without the current Output Attributes because of past state persistence failures. These cases are handled by computing the deterministic Physical Name and looking it up or by searching for Resources using tags (if the Cloud Provider supports it). Read may return `Unowned(attrs)` when the resource exists but lacks our ownership tags, signalling the engine to gate adoption behind `--adopt` or `adopt(true)`.
- **Pre-Create** - determine if the Resource needs a pre-create operation. This is usually only the case for the special Function/Runtime Resources like AWS Lambda Functions. If it is required, then document which API call(s) should be called and what the empty (unit) input properties are. E.g. a Lambda Function takes a simple script that exports a no-op handler function.
- **Reconcile** - determine the API calls needed to converge the cloud's actual state to the desired state described by the new Input Properties. Reconcile must be a single flow that works whether the resource is missing (greenfield create), pre-existing under our ownership (update), or freshly adopted (`output` defined but `olds` absent). See the **Reconciler doctrine** section below.
- **Delete** - determine which APIs should be called and in what order to delete an existing Resource. Delete should be idempotent so that if the resource has already been deleted, it is not considered an error. It is common for deletions to fail because of Dependency Violations or Eventual Consistency Errors. These are not always called Dependency Violations in the API docs, so attention should be paid to investigating each API's possible error codes and how they should be handled by the Delete operation. Should we retry for a period of time, indefinitely, or fail immediately?

# Reconciler doctrine

The provider's `reconcile` function replaces the legacy `create` + `update` pair. It runs every time the engine wants to make the cloud match the desired state — whether that's the first time the resource is being provisioned, a routine update, or a takeover after `read` returned an existing cloud resource.

It receives `output: Attributes | undefined` and `olds: Props | undefined`:

| `output`     | `olds`       | Meaning                                           |
| ------------ | ------------ | ------------------------------------------------- |
| `undefined`  | `undefined`  | Greenfield — no prior physical resource           |
| defined      | defined      | Routine update — engine-owned resource            |
| defined      | `undefined`  | Adoption — engine adopted via `read`              |

A reconciler MUST work correctly for all three combinations. It MUST NOT branch the body on `output === undefined` and run different code paths for "create" vs "update". That pattern is just rename-and-branch and re-introduces every assumption the old `create`/`update` split made. Instead, write one flow:

```
1. Observe   — derive the physical identifier; read live cloud state via getX/describeX
2. Ensure    — if the resource is missing, call createX. Catch AlreadyExists/ConflictException
                as a race and continue. Wait for active state if applicable.
3. Sync      — for each mutable aspect (settings, sub-resources, tags, policy):
                 - read OBSERVED cloud state (not olds)
                 - compute desired state from news + bindings
                 - diff observed against desired
                 - apply only the delta API call (skip the API entirely on no-op)
4. Return    — re-read final state if needed; return the fresh Attributes shape
```

Key invariants:

- **Observation > assumption.** Cloud state is authoritative. `olds` is at most a hint to skip a no-op API call; it is never the source of truth for what's actually deployed.
- **Each sync step is independently idempotent.** Crash mid-reconcile, re-run, you converge.
- **`output` is treated as a cache** for stable identifiers (physical name, ARN, immutable id). It is NOT a guarantee that the resource still exists. If it doesn't, observation falls through to "missing" and ensure recreates.
- **`AlreadyExists`/`NotFoundException`/`ResourceInUseException`-style errors are caught**, not propagated — they're races or eventual-consistency, not failures.
- **Tags use observed cloud tags as the diff baseline**, not `olds.tags` or `output.tags`. Adoption may bring you a resource with foreign tags that need to be reconciled.

:::warning
**Do not write `if (output === undefined) { /* create body */ } else { /* update body */ }`.** That is rename-and-branch, not reconciliation. The reconciler's body is one observe-ensure-sync flow that produces correct cloud state regardless of starting point.
:::

The canonical reference reconcilers cover the common shapes:

- [S3 Bucket](./packages/alchemy/src/AWS/S3/Bucket.ts) — uses `ensureBucketExists` + `syncBucketTags` + `syncBucketPolicy` helpers; each helper is itself a tiny reconciler.
- [SQS Queue](./packages/alchemy/src/AWS/SQS/Queue.ts) — observe via `getQueueUrl`, ensure via `createQueue` (tolerates `QueueNameExists` race), sync attributes by diffing `getQueueAttributes` against desired, sync tags.
- [Kinesis Stream](./packages/alchemy/src/AWS/Kinesis/Stream.ts) — many mutable aspects (mode, shards, retention, encryption, metrics), each its own observed-vs-desired sync block.
- [DynamoDB Table](./packages/alchemy/src/AWS/DynamoDB/Table.ts) — multi-API observation (table + tags + PITR + TTL), per-aspect diffing, GSI delta application.
- [EC2 Vpc](./packages/alchemy/src/AWS/EC2/Vpc.ts) — auto-assigned id, observe via `describeVpcs([output.vpcId])` with NotFound fallback to create, sync DNS attrs by reading `describeVpcAttribute`, sync tags from observed `vpc.Tags`.
- [Lambda Function](./packages/alchemy/src/AWS/Lambda/Function.ts) — uses `createOrUpdateFunction` / `createOrUpdateFunctionUrl` / `attachBindings` helpers, each idempotent.
- [Cloudflare Worker](./packages/alchemy/src/Cloudflare/Workers/Worker.ts) — non-AWS API; the underlying `putWorker` is a true upsert, so reconcile observes existing settings and delegates.

Existence-only resources (Lambda Permission, EC2 Route, EC2 RouteTableAssociation, IAM AccessKey, etc.) have nothing mutable beyond their identity. Their reconciler is just observe → if missing, create. There is no sync step.

5. Research and design the test cases for each resource. Test cases can be single or multi-step. Single-step test cases are just testing a single create success or failure mode. Multi-step cases are testing a sequence of operations, starting with create and then updating or replacing the resource multiple times. Test cases should be designed to be exhaustive and cover all possible success and failure modes, starting from simple happy paths to long, complicated aggregate (including other resources) smoke tests.
6. Implement the Resource contract and Provider in `packages/alchemy/src/{Cloud}/{Service}/{Resource}.ts`.

The Resource contract (Props, Attributes, Binding Contract) and the Resource Provider (lifecycle operations) are co-located in the same file.

Read through the established examples to understand the pattern:

- [S3 Bucket](./packages/alchemy/src/AWS/S3/Bucket.ts)
- [SQS Queue](./packages/alchemy/src/AWS/SQS/Queue.ts)
- [DynamoDB Table](./packages/alchemy/src/AWS/DynamoDB/Table.ts)
- [Kinesis Stream](./packages/alchemy/src/AWS/Kinesis/Stream.ts)
- [Lambda Function](./packages/alchemy/src/AWS/Lambda/Function.ts)
- [VPC](./packages/alchemy/src/AWS/EC2/Vpc.ts)
- [Subnet](./packages/alchemy/src/AWS/EC2/Subnet.ts)

The Resource interface takes four type parameters: `Resource<Type, Props, Attributes, BindingContract>`.

```ts
export interface Stream extends Resource<
  "AWS.Kinesis.Stream",
  StreamProps,
  {
    streamName: string;
    streamArn: string;
    streamStatus: StreamStatus;
  }
> {}

export const Stream = Resource<Stream>("AWS.Kinesis.Stream");
```

For Resources that accept Bindings (like Lambda Function), include a fourth type parameter for the Binding Contract:

```ts
export interface Function extends Resource<
  "AWS.Lambda.Function",
  FunctionProps,
  {
    functionArn: string;
    functionName: string;
    functionUrl: string | undefined;
    roleName: string;
    roleArn: string;
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  }
> {}
```

:::warning
**Never use `Input<T>` in declared Props interfaces.** Declare plain types (`zoneId: string`, `ips?: string[]`, nested structs with plain fields). The `Resource` machinery applies `Input` automatically — and `Input<T>` is deep (it recursively distributes over arrays and object fields), so even nested references like `memberships: [{ identifier: zone.zoneId }]` accept `Output<string>` without any explicit annotation. Writing `Input<string>` in a Props interface produces a redundant double-wrap.

```ts
// ❌ wrong
export interface LoadBalancerProps {
  zoneId: Input<string>;
}

// ✅ right — the engine wraps automatically and deeply
export interface LoadBalancerProps {
  zoneId: string;
}
```

`Input<T>` in a *function signature* is still legitimate when the function genuinely receives unresolved values at runtime (e.g. helpers that resolve tag maps, or `DurableObjectNamespace.from(scriptName: Input<string>)`).
:::

7. Implement each Capability as a `Binding.Service` in `packages/alchemy/src/{Cloud}/{Service}/{Capability}.ts`.

A single `Binding.Service` does both halves of a capability in one Effect:

- **Init (outer) Effect** — resolves the host Function/Worker and its environment, then registers the deploy-time binding by calling ``host.bind`${resource}`(data)`` (environment variables + IAM policy statements for AWS, native bindings for Cloudflare), guarded by `!globalThis.__ALCHEMY_RUNTIME__` so it becomes a no-op once running inside the deployed Function/Worker.
- **Runtime (inner) callable** — the typed client returned to the caller; its methods require `Alchemy.RuntimeContext` (see below).

There is no separate deploy-time policy object and nothing to register in `providers()` — the implementation layer is provided directly on the Function/Worker Effect.

Read through the established capabilities to understand the pattern:

- [S3 GetObject](./packages/alchemy/src/AWS/S3/GetObject.ts), [S3 PutObject](./packages/alchemy/src/AWS/S3/PutObject.ts)
- [SQS SendMessage](./packages/alchemy/src/AWS/SQS/SendMessage.ts), [DynamoDB GetItem](./packages/alchemy/src/AWS/DynamoDB/GetItem.ts)
- [Kinesis PutRecord](./packages/alchemy/src/AWS/Kinesis/PutRecord.ts), [Lambda InvokeFunction](./packages/alchemy/src/AWS/Lambda/InvokeFunction.ts)
- Access-split Cloudflare capabilities: [R2 Bucket](./packages/alchemy/src/Cloudflare/R2/), [KV Namespace](./packages/alchemy/src/Cloudflare/KV/), [Queue](./packages/alchemy/src/Cloudflare/Queue/)

For Event Sources, see:

- [SQS QueueEventSource](./packages/alchemy/src/AWS/SQS/QueueEventSource.ts)
- [S3 BucketEventSource](./packages/alchemy/src/AWS/S3/BucketEventSource.ts)

Each capability exports its contract plus one or more implementation layers:

```ts
// 1. The Binding.Service class (the contract) + a bind alias for ergonomic use
export class PutRecord extends Binding.Service<...>()("AWS.Kinesis.PutRecord") {}
export const putRecord = PutRecord.bind;

// 2. The implementation layer — resolves the host + environment, registers the
//    binding inline (guarded by __ALCHEMY_RUNTIME__), and returns the runtime client.
export const PutRecordLive = Layer.effect(
  PutRecord,
  Effect.gen(function* () {
    const host = yield* Worker; // or the AWS Function host
    const env = yield* WorkerEnvironment; // or Lambda.FunctionEnvironment
    return Effect.fn(function* (stream: Stream) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // AWS: { policyStatements: [...] }   Cloudflare: { bindings: [...] }
        yield* host.bind`${stream}`({ policyStatements: [...] });
      }
      return /* typed runtime client closing over `env` */;
    });
  }),
);
```

Provide the implementation layer on the **Function/Worker** Effect (`Effect.provide(PutRecordLive)`).

### Read/Write/ReadWrite binding convention

When a capability's API distinguishes access levels (R2 `head`/`get`/`list` vs `put`/`delete`; KV `get`/`getWithMetadata`/`list` vs `put`/`delete`), split it into three `Binding.Service`s so consumers can request least privilege, each with two interchangeable implementations:

- **`{Cap}Read.ts` / `{Cap}Write.ts` / `{Cap}ReadWrite.ts`** — the `Binding.Service` class + runtime client interface + a `bind` alias (e.g. `ReadBucket = BucketRead.bind`). `ReadWrite`'s client interface `extends` both the `Read` and `Write` client interfaces.
- **`{Cap}Binding.ts`** — *shared* worker-binding scaffolding: a `make{Cap}Binding({ makeClient })` that resolves `WorkerEnvironment` + host `Worker`, registers the native binding via ``host.bind`${resource}`(...)`` (guarded by `__ALCHEMY_RUNTIME__`), plus a `make{Cap}Helpers` returning the low-level `raw`/`use`/`tryPromise` primitives. **Do NOT export this file from `index.ts`.**
- **`{Cap}ReadBinding.ts` / `{Cap}WriteBinding.ts` / `{Cap}ReadWriteBinding.ts`** — `Layer.effect` implementations over the native binding (`ReadBucketBinding`, …) plus the `makeRead`/`makeWrite` client builders. `ReadWrite` composes the read + write builders.
- **`{Cap}Http.ts`** — *shared* HTTP/token scaffolding: a `makeHttp{Cap}Binding({ permissionGroups, makeClient })` that mints a scoped `AccountApiToken` with the right permission groups, binds the token's `value`/`accountId` into the Worker, and resolves the per-operation scope. **Do NOT export this file from `index.ts`.**
- **`{Cap}ReadHttp.ts` / `{Cap}WriteHttp.ts` / `{Cap}ReadWriteHttp.ts`** — `Layer.effect` implementations over the cloud's HTTP API (`ReadBucketHttp`, …). Operations the HTTP API can't support `Effect.die` with a typed error.

Rules:

- **Keep shared scaffolding internal.** Re-export only the contracts, the per-level layers, and the client builders from `index.ts`. Exporting `{Cap}Binding.ts`/`{Cap}Http.ts` leaks generic helper names into the flat `Cloudflare`/`AWS` namespace and collides across services.
- **Use service-unique helper names.** Avoid generic `makeHelpers`/`makeWrite`; prefix with the capability (`makeQueueHelpers`, `makeWriteQueueClient`) so re-exported builders never clash.
- **Namespace the public surface.** Export the service both flatly and as a namespace (`export * as KV from "./KV/index.ts"`) so callers write `Cloudflare.KV.ReadWriteNamespace(ns)`. The bind-alias callables drop the redundant service prefix (`ReadWriteNamespace`, not `ReadWriteKVNamespace`); the underlying classes/interfaces keep it (`KVNamespaceReadWrite`, `ReadWriteKVNamespaceClient`).
- **No resource-level `bind`.** The Resource is plain `Resource<T>("Cloud.Type")` with no `bind:` field; callers bind via the namespaced capability, not `resource.bind`.
- **Single-mode capabilities stay single.** A producer-only capability (e.g. Cloudflare Queue's send-only producer, which has no runtime read) ships just the `Write` service — don't invent a `Read` the runtime can't satisfy. The HTTP impl can still cover both directions where the API does.

Reference: [Cloudflare R2 Bucket](./packages/alchemy/src/Cloudflare/R2/), [KV Namespace](./packages/alchemy/src/Cloudflare/KV/), [Queue](./packages/alchemy/src/Cloudflare/Queue/).

### Runtime-only methods: color with `Alchemy.RuntimeContext`

The runtime callable returned by a `Binding.Service` (the inner Effect inside `.bind(resource)`'s return) **must** declare `Alchemy.RuntimeContext` as a requirement. This is how Alchemy models "this code can only run inside a deployed Function/Worker" at the type level — analogous to a colored function.

```ts
import type { RuntimeContext } from "../../RuntimeContext.ts";

export class GetItem extends Binding.Service<
  GetItem,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: GetItemRequest,
    ) => Effect.Effect<
      DynamoDB.GetItemOutput,
      DynamoDB.GetItemError,
      RuntimeContext // ← runtime-only
    >
  >
>()("AWS.DynamoDB.GetItem") {}
```

Rules:

- **Outer Effect** (the `bind(resource)` setup) runs at the Function's init phase. It does NOT require `RuntimeContext`.
- **Inner Effect** (the actual SDK invocation) only makes sense inside a running Function. It MUST require `RuntimeContext`.
- Resolve cloud-environment services (`WorkerEnvironment`, AWS SDK clients, etc.) once during Layer construction and close over them. Do NOT leak `WorkerEnvironment` / `Lambda.FunctionEnvironment` onto the runtime callable — that couples downstream service code to a specific cloud and breaks Layer encapsulation. The Function/Worker runtime satisfies `RuntimeContext` automatically.
- The implementation can return `Effect.Effect<A, E>` without explicitly providing `RuntimeContext` (it's contravariant in `R`); just declare it on the interface.

Why this matters: consumers can build cloud-agnostic services on top of bindings using `Layer.effect(Tag, ...)` without polluting their service interface with `WorkerEnvironment`. See [Layers concept](./website/src/content/docs/concepts/layers.mdx).

After implementing, re-export the contract and implementation layers from the service's `index.ts` (but keep the shared `{Cap}Binding.ts`/`{Cap}Http.ts` scaffolding un-exported).

### Isolate scope vs request scope (runtime bridges)

**Layer construction is isolate-scoped; the effects built services expose are request-scoped.**

- **At layer build / Worker init (instance scope)** a layer MAY resolve services and env/config, register listeners and `bind` declarations, assemble `Effect.fn` clients, and perform one-shot I/O that produces a plain cached value (e.g. fetch a secret and cache it for a client). It MUST NOT acquire **disposable** resources — connections, pools, streams, anything with a finalizer (`Layer.scoped` / `Effect.acquireRelease` / init-level `Effect.addFinalizer`) — or retain I/O-backed *objects* or promises across events (workerd pins them to the creating request's IoContext). The runtime bridges (Worker event, Durable Object call, Workflow run, Lambda invoke) build the layer stack **once per instance** on the first event. Instance finalizers run at instance shutdown at best: **never on workerd** (no teardown hook), and in a **best-effort 500 ms SIGTERM window on Lambda** (the generated entry registers an internal extension to obtain it and closes the instance scope on SIGTERM; not delivered on hard failures). Server processes (Containers, ECS Tasks) close their root scope on graceful exit.
- **At request scope**, anything needing I/O or cleanup is an effect requiring `Scope.Scope`, acquired lazily per call. Every bridge provides a fresh `Scope` per event; `Effect.addFinalizer` in a handler attaches to it and runs after the response (registered with `ctx.waitUntil` on workerd; settled inline on Lambda). Per-request memoization keys on the scope object (`yield* Effect.scope`) — see [Drizzle/Postgres.ts](./packages/alchemy/src/Drizzle/Postgres.ts) for the canonical WeakMap pattern. One pool/socket per event is the law on workerd (sockets are IoContext-pinned); Hyperdrive is the cross-request pooler.

:::tip
If you need to know what AWS region or account ID the resource is being created/updated in, you can use this inside any of the lifecycle operations.

```ts
const region = yield * Region;
const account = yield * Account;
```

:::

:::warning
You should favor getting the region/account INSIDE the lifecycle operations instead of inside the Layer effect like this because then it's scoped to the resource isntead of the resource provider:

```ts
reconcile: Effect.fn(function* ({ id, news, output, session }) {
  const { accountId, region } = yield* AWSEnvironment.current;
});
```

:::

:::warning
Do not use `Effect.orDie` in the lifecycle operations since this will crash the whole IaC engine.
:::

:::warning
**Never use `async`/`await`, raw `Promise`, `node:fs/promises`, `node:fs`, `node:os`, or `pathe` directly in resource code.** Always use the Effect platform services so that effects remain composable, traceable, retryable, and testable:

| Don't                                                | Do                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `import fs from "node:fs/promises"`                  | `const fs = yield* FileSystem.FileSystem`                   |
| `await fs.readFile(p, "utf8")`                       | `yield* fs.readFileString(p)`                               |
| `await fs.mkdtemp(...)`                              | `yield* fs.makeTempDirectory({ prefix: ... })`              |
| `import path from "pathe"` / `node:path`             | `const path = yield* Path.Path`                             |
| `await fetch(...)`                                   | `yield* HttpClient.HttpClient` + `HttpClientRequest`        |
| `Effect.promise(() => listSqlFiles(dir))`            | Make `listSqlFiles` itself return `Effect` and `yield*` it |
| `new Promise((res) => setTimeout(res, ms))`          | `yield* Effect.sleep(Duration.millis(ms))`                  |

Sync, CPU-only Node APIs (e.g. `crypto.createHash().update().digest()`, `process.cwd()`, `Buffer`, `TextEncoder`) must still be wrapped in `Effect.sync(() => ...)` (or `Effect.try` if they can throw) so the call participates in the Effect runtime — tracing, interruption, and error channels. Don't call them as bare expressions inside `Effect.gen`.

```ts
const hash = yield* Effect.sync(() =>
  crypto.createHash("sha256").update(input).digest("hex"),
);
const cwd = yield* Effect.sync(() => process.cwd());
```

This applies to **lifecycle operations, helpers, AND tests**. Tests must use `FileSystem.FileSystem`/`Path.Path` for any file/path access (see [Database.test.ts](./packages/alchemy/test/Cloudflare/D1/Database.test.ts) for the pattern).
:::

:::tip
If a Resource supports tags, you should always include the internal Alchemy tags to brand the resource with the app, stage and logical ID so that we can "know" that we created it and are responsible for it.

```ts
reconcile: Effect.fn(function* ({ id, news, output, session }) {
  const internalTags = yield* createInternalTags(id);
  const userTags = news.tags ?? {};
  const allTags = { ...internalTags, ...userTags };
});
```

:::

:::warning
Do not roll your own tag diffing logic, always use `diffTags` from [Tags.ts](./packages/alchemy/src/Tags.ts), and diff against **observed cloud tags** (not `olds.tags` or `output.tags`). Adoption can hand you a resource whose tags don't match what we last persisted.

```ts
reconcile: Effect.fn(function* ({ id, news, output, session }) {
  const internalTags = yield* createInternalTags(id);
  const newTags = { ...news.tags, ...internalTags };
  // Read tags fresh from the cloud so adoption (where tags may not match
  // what we last persisted) converges correctly.
  const oldTags = yield* fetchObservedTags(/* … */);
  // Option 1. use `upsert` if the API expects you to create/update tags in one call
  const { removed, upsert } = diffTags(oldTags, newTags);
  // Option 2. use `added` and `updated` if the API expects you to create/update tags in separate calls
  const { removed, added, updated } = diffTags(oldTags, newTags);
  // Option 3. use `upsert` only if the API doesn't expect you to remove tags (only PUT/UPDATe)
  const { upsert } = diffTags(oldTags, newTags);
```

:::

9. Implement the test cases in `packages/alchemy/test/{Cloud}/{Service}/{Resource}.test.ts`.

Read through the established test cases before continuing so that you understand the pattern and structure of the test cases.

- [S3 Bucket Test Cases](./test/AWS/S3/Bucket.test.ts)
- [SQS Queue Test Cases](./test/AWS/SQS/Queue.test.ts)
- [Lambda Function Test Cases](./test/AWS/Lambda/Function.test.ts)
- [Kinesis Stream Test Cases](./test/AWS/Kinesis/Stream.test.ts)
- [DynamoDB Table Test Cases](./test/AWS/DynamoDB/Table.test.ts)
- [VPC Test Cases](./test/AWS/EC2/Vpc.test.ts)
- [Subnet Test Cases](./test/AWS/EC2/Subnet.test.ts)

:::warning
Never use `Date.now()` when constructing the physical name of a resource. You should either:

1. Do not proide a name and rely on the resource provider to generate a unique name for you from the app, stage and logical ID.
2. Construct a deterministic one unique to each test case. But it should be the same on each subsequent run of the test case.
   :::

3. Consider implementing an aggregate Smoke test that brings together multiple resources that are often used together.

See the [VPC Smoke Test](./test/AWS/EC2/Vpc.smoke.test.ts) for an example.

11. Add the resource-level JSDoc (`@section` + `@example` blocks) and field-level JSDoc on each prop/attribute on the source `.ts` file. Then run `bun generate:api-reference` to refresh `website/src/content/docs/providers/{Cloud}/{Resource}.md`. Do NOT manually edit the generated markdown.

# Typed Error Doctrine (distilled)

Every error a distilled operation can produce in practice MUST be a tagged error in that operation's **type-level** error union. The catch-all classes (`UnknownCloudflareError`, `CloudflareHttpError`, and the status-derived classes like `NotFound`/`BadRequest` that distilled leaves out of the typed union) exist only to *surface* gaps — they are never something alchemy code handles.

**When you hit an unmatched error** (an `UnknownCloudflareError`, or you find yourself wanting to check `CloudflareHttpError.status` or an out-of-union `NotFound`), the fix is ALWAYS a distilled patch, never a catch in alchemy:

1. Note the error's code / status / message from the failure output.
2. Add or extend `distilled/packages/cloudflare/patches/{service}/{operation}.json` with a **meaningful, resource-specific tag** (e.g. `WidgetNotFound`, not a bare `NotFound`):

   ```json
   { "errors": { "WidgetNotFound": [{ "code": 1234 }] } }
   ```

   Matchers may combine `code`, `status`, and `message` (`{ "includes": "..." }` / `{ "matches": "..." }`) — e.g. `[{ "status": 400, "message": { "includes": "snippet not found" } }]` when Cloudflare misuses 400 for a missing resource. Prefer matching the Cloudflare error `code` when one exists; fall back to `status` + `message` otherwise.

3. Regenerate ONLY that service: `cd distilled/packages/cloudflare && bun scripts/generate.ts --service {service}` (then `bun oxlint --fix src/services/{service}.ts && bun oxfmt --write src/services/{service}.ts`).
4. Handle the now-typed tag in alchemy code and re-run the tests.

**Forbidden patterns** — these defeat the type system and must never appear in alchemy code or tests:

```ts
// ❌ unknown-typed structural predicates
const isNotFoundError = (e: unknown): boolean =>
  Predicate.hasProperty(e, "_tag") && (e as { _tag: unknown })._tag === "NotFound";

// ❌ widening casts to duck-typed tags
Effect.retry({ while: (e) => (e as { _tag?: string })._tag === "Forbidden" })

// ❌ catching the catch-all HTTP error by status
Effect.catchIf((e) => e._tag === "CloudflareHttpError" && e.status === 404, ...)
```

**Required patterns** — fully inferred, no casts, no `unknown`:

```ts
// ✅ catch a typed tag
.pipe(Effect.catchTag("WidgetNotFound", () => Effect.void))

// ✅ retry while a typed tag is observed (e is the op's inferred error union)
Effect.retry({ while: (e) => e._tag === "WidgetNotFound", schedule, times })

// ✅ multiple tags
Effect.catchTag(["WidgetNotFound", "Gone"], () => Effect.succeed(undefined))
```

If `Effect.catchTag("SomeTag", ...)` fails to typecheck, that is the signal that distilled's union is missing the error — patch distilled (step 2 above); do not loosen the alchemy-side types.

# Test Fixtures for Effect-Native Workers / Functions

To test runtime behavior of an Effect-native Worker, Workflow, Lambda, etc., write a **fixture** that defines the Worker/Function with the bindings under test and exposes one HTTP route per behavior, then write a **test** that deploys the fixture once via `beforeAll` and drives it over HTTP.

## File system layout

Put fixtures in a `fixtures/` directory next to the test file. Each test suite owns its own fixtures — never reach across suites:

```sh
packages/alchemy/test/{Cloud}/{Service}/{Resource}.test.ts
packages/alchemy/test/{Cloud}/{Service}/fixtures/{worker|workflow|handler}.ts
```

## Fixture shape

Resolve the bindings, expose one route per behavior, default-export the class so the test can deploy it directly:

```ts
// fixtures/worker.ts
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Gateway } from "./gateway.ts";

export default class TestWorker extends Cloudflare.Worker<TestWorker>()(
  "TestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const aiGateway = yield* Cloudflare.AI.QueryGateway(Gateway);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/url")) {
          const url = yield* aiGateway.getUrl().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ url });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.AI.QueryGatewayBinding)),
) {}
```

## Test shape

Compose a `Stack` that deploys the fixture, share one deploy across the file with `beforeAll`/`afterAll`, drive it via `HttpClient`, and retry the first request through edge propagation:

```ts
// Service.test.ts
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TestWorker from "./fixtures/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "ServiceTestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* TestWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed worker exercises the binding",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client.get(`${url}/url`).pipe(
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 10 }),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { url: string };
    expect(body.url).toContain("gateway.ai.cloudflare.com");
  }),
  { timeout: 180_000 },
);
```

Notes:

- `Test.make({ providers: Cloudflare.providers() })` gives you `test`, `beforeAll`, `afterAll`, `deploy`, `destroy`.
- `beforeAll(deploy(Stack))` returns a handle (`stack` above) that every `test` body can `yield*` to get the stack outputs.
- `afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack))` is the standard cleanup — set `NO_DESTROY=1` locally to keep the deployment around between runs while iterating.
- Always retry the first request (`Schedule.exponential("500 millis")`) — fresh workers.dev URLs and Lambda function URLs take a few seconds to start serving 200s.
- For POST: use `client.post(url)` for empty bodies, or `HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)))` for typed bodies.
- **Never use `while (Date.now() < deadline)` loops to poll** for an async side effect (a workflow status, a cron fire, a queue drain, eventual-consistency read, etc.). Use `Effect.repeat` with a `Schedule` and an `until` predicate so the polling participates in the Effect runtime — tracing, interruption, and error propagation work correctly, and the intent is declarative. Cap iterations with `times: N` (or a bounded schedule) so the test fails fast instead of running until the test timeout:

  ```ts
  // good — declarative, bounded, interruption-safe
  const value = yield* fetchValue.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (v) => v.ready,
      times: 36,
    }),
  );

  // bad — opaque loop, ignores interruption, leaks into the test timeout
  let value: Value | undefined;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    value = yield* fetchValue;
    if (value.ready) break;
    yield* Effect.sleep("5 seconds");
  }
  ```

  See [CronEventSource.test.ts](./packages/alchemy/test/Cloudflare/Workers/CronEventSource.test.ts) for a real-world example (polling a DO via the worker's `/times` route until the cron handler fires).

## Reference implementations

- Cloudflare.AI.Gateway — [worker fixture](./packages/alchemy/test/Cloudflare/AI/fixtures/TestWorker.ts) + [test](./packages/alchemy/test/Cloudflare/AI/Gateway.test.ts) (the deploy+fetch case lives at the bottom of the file)
- Cloudflare D1Connection — [worker fixture](./packages/alchemy/test/Cloudflare/D1/d1-worker.ts) + [test](./packages/alchemy/test/Cloudflare/D1/D1Binding.test.ts)
- Cloudflare Workflow — [workflow fixture](./packages/alchemy/test/Cloudflare/Workers/fixtures/test-workflow.ts) + [worker fixture](./packages/alchemy/test/Cloudflare/Workers/fixtures/workflow-worker.ts) + [test](./packages/alchemy/test/Cloudflare/Workers/Workflow.test.ts)
- Cloudflare Cron Trigger — [worker + DO fixture](./packages/alchemy/test/Cloudflare/Workers/fixtures/cron-worker.ts) + [test](./packages/alchemy/test/Cloudflare/Workers/CronEventSource.test.ts) (cron handler writes to a DO; test polls a fetch route with `Effect.repeat` until the scheduled handler fires)
- Cloudflare Images — [effect fixture](./packages/alchemy/test/Cloudflare/Images/fixtures/effect-worker.ts) + [async fixture](./packages/alchemy/test/Cloudflare/Images/fixtures/async-worker.ts) + [test](./packages/alchemy/test/Cloudflare/Images/Images.test.ts)
- AWS Lambda (DynamoDB bindings) — [Lambda fixture](./packages/alchemy/test/AWS/DynamoDB/handler.ts) + [test](./packages/alchemy/test/AWS/DynamoDB/Bindings.test.ts) (one `describe("<BindingName>")` per binding, all driving the same deployed Lambda)

# Spec-Driven Service Bring-Up

Use @processes/AWS.md as the source of truth for bringing a single AWS service from zero to full coverage.

That process covers:

- deriving resources, bindings, event sources, and helpers from distilled
- the audit-driven implementation loop
- deterministic checks for registration and binding test coverage
- Lambda fixture testing conventions
- learned conventions like no auto-marshalling and one `describe("<BindingName>")` block per binding

Keep `AGENTS.md` high-level and update @processes/AWS.md when the process evolves.

When a canonical resource needs mutable event-source configuration and there is any chance of circularity, prefer a resource binding contract over a plain input prop. DynamoDB Streams is the reference case: `Table` owns the actual stream state, while `streams(table)` injects that state via bindings and the runtime-specific layer handles the subscription mechanics. See @processes/AWS.md for the DynamoDB Streams case study.

# Build and Type Checking

Always run type checking before committing changes:

```bash
bun tsc -b
```

This runs the TypeScript compiler in build mode, which checks all projects in the workspace (including the distilled packages, which are project references). This is critical because CI will fail if there are type errors.

## Running tests

`packages/alchemy/test` runs on **alchemy-test** (`packages/alchemy-test`), our own single-process, Effect-native test runner. The CLI is vitest/bun-test compatible: positional paths (files or directories) and `-t` work the same way.

There is exactly ONE entry point: `bun run test <options>`. It works identically from the repo root and from `packages/alchemy` (the root script just cds into `packages/alchemy`); suite paths are always relative to `packages/alchemy`. Compose the flags you need — there are no per-variant package scripts. NOTE: `bun run test`, not `bun test` — the latter invokes bun's own built-in test runner.

```bash
# a suite, against the real cloud
bun run test test/Cloudflare/{Service}/{Resource}.test.ts --profile testing

# a directory, filtered by test name
bun run test test/Cloudflare/Workers -t "cron" --profile testing

# positional args that aren't real paths are file-name substring filters
bun run test Bucket --profile testing   # every *Bucket* test file

# skip the slow tests (replaces the old FAST=1 env prefix)
bun run test --fast --profile testing

# interactive TUI (humans only — never in an agent shell)
bun run test --tui
```

(`examples/` still use plain `bun test`.)

### Cleaning leaked test resources

If an interrupted live-cloud test leaves resources behind, do **not** add
test-specific API cleanup helpers, adoption workarounds, or alternate names to
make the test pass. Clean the testing account with the account-wide teardown
command, then rerun the failing test:

```bash
bun nuke
bun clear:state --profile testing
```

Lifecycle tests should continue to validate normal stack ownership and cleanup;
they must not silently adopt or directly delete leaked resources from earlier
runs.

Additional flags beyond vitest:

| Flag              | Default | Purpose                                                       |
| ----------------- | ------- | ------------------------------------------------------------- |
| `-t <regex>`      | —       | Test-name pattern (regex, like bun/vitest) tested against the full nested title (`file > describes > name`), so any fragment matches regardless of nesting. An invalid regex degrades to a literal substring instead of erroring. Remember to escape regex metacharacters when filtering literally: `-t "create \(default\)"` |
| `--profile <name>` | —      | Sets `ALCHEMY_PROFILE` before any test module is imported. Use `--profile testing` for live-cloud suites instead of an `ALCHEMY_PROFILE=testing` env prefix |
| `--fast`          | off     | Sets `FAST=1` before imports — suites `skipIf(process.env.FAST)` their slow tests (long-provisioning resources, smoke tests). Replaces the `FAST=1` env prefix |
| `--timeout <ms>`  | 120000  | Default per-test timeout                                      |
| `--retry <n>`     | 2       | Re-runs of a failing test body (use `--retry 0` when debugging) |
| `--concurrency <n\|unbounded>` | 32 | Files running concurrently (one bun process, no forks). Bounded by default — unbounded saturates the event loop on large suites and produces spurious 0ms `beforeAll` timeouts |
| `--sequential`    | off     | Run tests within each file sequentially                       |
| `--tui`           | off     | Opt-in interactive TUI (default is line-per-test output)      |

Output behavior (plain mode, the default):

- The collection phase (importing every test file, ~45s for the full suite) reports `collecting N/TOTAL test files (elapsed) <current file>` — repainted in place on a TTY, printed every 5s otherwise. A run that appears stuck before any test starts is almost always just collecting; if it really is stuck, the line names the file whose import hangs.
- One line per test as it finishes, prefixed with a `[done/total]` progress counter so the remaining count is visible; a **failing test prints its error and captured output inline** immediately.
- Passing tests' output is swallowed on the console — but **every** test's output (passes included) is streamed to a per-run log at **`.alchemy/log/test/{timestamp}-pid{pid}.log`** (relative to the cwd), so concurrent runs in different terminals never trample each other. The absolute path (with line/KB counts) is printed at the end of every run (`Full log: …`) — read that file when you need the complete record, e.g. a passing test's deploy output or a hang's partial log. The file is appended live, so it's readable mid-run; logs older than a week are pruned automatically (by stat mtime).
- If nothing finishes for 10s, the runner prints the list of currently-running tests with elapsed times — the first place to look when a run seems hung.
- Exit code is non-zero if any test failed.

Runner semantics to know:

- Everything runs in ONE bun process: files run concurrently (respecting `describe.sequential`), imports of all test files happen up-front (they must be lazy and pure — registration only, no top-level side effects beyond `Test.make`/`describe`/`test`).
- Tests that mutate process-global state (e.g. `process.env.PATH`) must pass `{ exclusive: true }` in the test options to take the whole-process write lock.
- The harness (`alchemy-test` package) provides `describe`, `it`/`test` (incl. `it.effect`/`it.live`), hooks, `layer`, `expect`, and `assert` — the codemod `scripts/codemod-alchemy-test.ts` migrates vitest imports and is idempotent.
- The runner runs in plain bun, so distilled resolves from `src/*.ts` via the `bun` export condition — a regenerated service is test-visible immediately, no `lib/` rebuild required.

## The convergence loop: nuke → test → census → fix-fleet

Ironing out the AWS suite is an iterative loop, driven by a coordinator, that terminates only when the suite is green AND the account is clean for **two consecutive rounds**. "Green" alone is not the bar — a passing test that leaves cloud resources behind is a provider bug by definition.

Each iteration:

0. **Clean slate** — first run `aws sso login` (the alchemy `testing` profile and the raw `aws` CLI ride the same SSO session; an expired token mid-round breaks the pipeline with auth errors — only escalate to a human if the login doesn't complete automatically). Then `bun nuke --yes` (deletes every alchemy-tagged cloud resource; `scripts/nuke.sh` already spares state buckets, SSO roles, and AWS-managed singletons) then `bun alchemy state clear ./stacks/nuke.ts --profile testing --yes`. Never overlap nuke with a running suite. Plain `bun clear:state` lacks the profile and dies on expired Cloudflare OAuth; nuke without `--yes` hangs on an interactive confirm in non-interactive shells.
1. **Full suite, bounded** — `bun run test test/AWS --profile testing`. The runner defaults to `--concurrency 32`; NEVER override it to `unbounded` on a full-suite run: all ~775 files' `beforeAll` deploys start at once, the event loop saturates, and hundreds of fake 0ms `beforeAll TimeoutError` failures drown the real signal (heap is ~8.5 GB regardless of N — the constraint is CPU, not memory). Target ≤10 min wall-clock, hard cap 128; measured 32 → ~21 min clean. The saturation tell is `beforeAll` failures at 0ms; real failures fail slow. If the cap can't reach 10 min, the residual is individual slow files — skipIf-gate them per the speed doctrine.
2. **Leak census** — `bun nuke --dry-run` after the suite; diff against the pre-suite baseline. Worklist = **failed services ∪ leaking services** (a service can pass green and still leak). Leave the leaked resources LIVE as forensic evidence for the fix agents; carry-over holdouts that survive repeated nuke passes (stuck deletes) go on the worklist too — their delete path is the bug.
3. **Fix-fleet workflow** — one agent per service on the worklist (account-singleton services — CloudTrail, Config, SecurityHub, GuardDuty, ControlTower, IdentityCenter — run as a sequential chain; everything else fans out). Each agent gets its exact failures, its leak inventory, and this root-cause priority: **provider bug > distilled patch > test fix** — never paper over a provider leak in the test. Each agent runs ONLY its own suite (`timeout 240 bun run test test/AWS/{Service} --profile testing`), audits its tests for non-deterministic names (rely on PhysicalName auto-naming; random data in message payloads/idempotency tokens is fine), verifies zero orphans from its service via out-of-band distilled list/describe calls, and reports a structured result. Agents never run tsc/build and never run the account-wide nuke.
4. **Gate** — the coordinator runs the one-shot `bun tsc -b`, fixes cross-cutting fallout, commits the iteration (+ distilled submodule bump when patches were made), and loops back to 0. Terminate on two consecutive iterations of green-suite + census reduced to documented-undeletable residue (e.g. BackupSearch terminal records, Contributor-Insights rules with no delete API, keys in scheduled deletion).

## Multi-agent sessions: the coordinator owns type-checking

When many agents work concurrently (see **The Resource Factory Process**), do NOT let each agent run `bun tsc -b` — concurrent runs thrash the machine and race on `tsbuildinfo`. Agents never invoke the compiler; the coordinator runs a one-shot `bun tsc -b` at wave boundaries as the authoritative type check.

## Build Commands

| Command           | Description                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `bun tsc -b`      | Type check all projects (always run before committing)                                       |
| `bun run build`   | Clean, type check, and build the alchemy package                                             |
| `bun build:clean` | Full clean rebuild: cleans all artifacts, reinstalls dependencies, builds, and downloads env |

Use `bun build:clean` when you encounter stale build artifacts or dependency issues. It runs:

1. `bun clean .` - Removes all untracked files except .env
2. `bun i` - Reinstalls dependencies
3. `bun run build` - Builds the project
4. `bun download:env` - Downloads environment files

# Tutorial Documentation Standard

Tutorials under `website/src/content/docs/tutorial/` are **step-by-step and granular**: every code snippet introduces exactly **one** new thing, followed by a short prose explanation of just that thing. Each step gets its own `##` heading.

**Anti-pattern** — one snippet that adds multiple distinct changes, followed by a numbered list or bullet list explaining each:

````md
## Bind the DO to the Worker

```diff lang="typescript"
+import Counter from "./counter.ts";
+import { HttpServerRequest } from "...";

  Effect.gen(function* () {
+    const counters = yield* Counter;
    return {
      fetch: Effect.gen(function* () {
+        const request = yield* HttpServerRequest;
+        if (request.url.startsWith("/counter/") && ...) {
+          const next = yield* counters.getByName(name).increment();
+          return HttpServerResponse.text(String(next));
+        }
        return HttpServerResponse.text("Hello!");
      }),
    };
  })
```

Two things just happened:
1. `yield* Counter` registers the DO ...
2. `counters.getByName(name)` returns a typed stub ...
````

**Correct** — split into one heading per step, each with one snippet and one explanation:

````md
## Bind the DO to the Worker

```diff lang="typescript"
+import Counter from "./counter.ts";

  Effect.gen(function* () {
+    const counters = yield* Counter;
    ...
  })
```

`yield* Counter` registers the DO with the Worker (binding + class-migration metadata) and hands you the namespace.

## Call the DO from `fetch`

```diff lang="typescript"
+import { HttpServerRequest } from "...";

  fetch: Effect.gen(function* () {
+    const request = yield* HttpServerRequest;
+    if (request.url.startsWith("/counter/") && ...) {
+      const next = yield* counters.getByName(name).increment();
+      return HttpServerResponse.text(String(next));
+    }
    return HttpServerResponse.text("Hello!");
  })
```

`counters.getByName(name)` returns a typed stub — `increment()` and `get()` round-trip through Cloudflare's RPC machinery.
````

Rules of thumb:

- If you find yourself writing "Two/three things just happened", "A few things are happening here", or a numbered/bulleted list explaining separate parts of a single snippet — **split the snippet**.
- One concept ⇒ one heading ⇒ one diff snippet ⇒ one explanation paragraph (no bullets).
- Bullet/numbered lists are fine when they describe a recap, prerequisites, or genuinely list-shaped content (e.g. "the Worker now handles two routes: PUT and GET" at the end). They are **not** fine as a substitute for splitting a compound snippet.
- A single API call that internally does several things (e.g. `Cloudflare.upgrade()`) doesn't need splitting — describe its behavior in prose.
- Use `diff lang="typescript"` blocks so each step shows what's added on top of the previous step.

# Pull Request Conventions

When you automatically open a PR, it MUST follow this structure:

- **Title**: Use conventional commit format (e.g. `fix(website): mobile theme metas`, `feat(aws/s3): add bucket lifecycle rules`).
- **Description heading levels**: NEVER use `#` or `##` in the PR description. The smallest heading allowed is `###`. The PR description must NOT begin with its own title heading — GitHub already renders the PR title above it.
- **Content**: Aim for the minimal content needed to convey the idea.
  - Use simple sentences. If there are multiple discrete changes, use bullet points.
  - **Prefer code snippets over prose.** A short ` ```ts ` or ` ```diff ` block showing the new/changed shape is worth more than a paragraph explaining it. Reach for code first; only add prose to fill in the "why" the snippet can't show on its own.
  - Be direct and succinct. Cut adjectives, justifications, and anything that reads like marketing copy. If a sentence is restating what the diff already shows, delete it.
  - **Never include a "Test plan", "Testing", or checklist of TODOs.** PR descriptions document the change, not the verification process. If something needs manual verification, follow the draft-PR rule below.
  - Skip examples for trivial fixes, internal refactors, or doc-only changes.

Example PR description (good — code snippet does the talking):

````
Track which state-store backend each project uses by emitting a `state_store.init` span tagged with `alchemy.state_store.kind`.

```ts
// every Layer.effect(State, …) site now wraps construction:
makeLocalState().pipe(recordStateStoreInit("local"))
```

Dashboard groups projects by kind from these spans (Axiom can't APL-query metric datasets).
````
- **Outstanding work / testing / review needed**: If there are outstanding steps, manual testing required, or review items, DO NOT leave a comment on the PR and DO NOT include them in the PR description. Instead:
  1. Mark the PR as **draft**.
  2. Tell the user (in the chat that initiated the PR creation) what is outstanding.

:::warning
**Markdown content must reach GitHub verbatim** — un-escaped backticks, fenced code blocks, etc. The reliable shape is to write the description to a file and pass `--body-file <path>` to `gh pr create` / `gh pr edit`:

```sh
# write the body to a temp file (use Write tool, not echo/cat heredoc)
gh pr edit 179 --body-file /tmp/pr-body.md
```

Do **not** inline the body via `--body "$(cat <<'EOF' ... EOF)"`. Even with a single-quoted heredoc some shells / `gh` versions still mangle backticks and backslashes; the resulting PR body ends up with literal `\`` sequences instead of inline code spans. `--body-file` sidesteps shell quoting entirely.

If you need to update an already-created PR's body, prefer `gh pr edit --body-file ...`. If that silently no-ops (older `gh` versions), fall back to `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -F body=@/tmp/pr-body.md`.
:::

The summary goes at the very top of the description as plain prose — NO heading above it, no `### Summary`, nothing. The PR title already serves as the title; do not repeat or re-title it. Only add `###` subheadings further down if the description genuinely has multiple sections worth separating.

Example PR description (good):

```
Persist the user's selected theme across reloads and fix a hero scroll glitch on mobile.

- Read theme from `localStorage` on mount before first paint
- Add `<meta name="theme-color">` per theme so mobile chrome matches
```

Example PR description (BAD — do not do this):

```
## Theme persistence fix    ← no, the PR title already exists
### Summary                  ← no, summary needs no heading
Persist the user's theme...
```

# Blog / Release Notes Conventions

Release blog posts live in `website/src/content/docs/blog/` named
`YYYY-MM-DD-beta-NN.md` (date = the release date).

**Frontmatter `title` format:** `<version> - <short title>`, e.g.
`2.0.0-beta.45 - Config & RPC Workers`. The title renders in the
blog TOC sidebar, so the descriptive suffix must be short — a few
words that fit neatly on one line. Lead with the version so the
list stays sorted and scannable.

Writing style (match the existing beta posts, e.g.
[beta.41](./website/src/content/docs/blog/2026-05-20-beta-41.md),
[beta.44](./website/src/content/docs/blog/2026-05-22-beta-44.md)):

- **Lean, concise, zero-fluff.** Illustrate each new
  feature/fix and link to the relevant docs/tutorials/guides.
- Read each PR in the release's changelog to understand what
  actually changed before writing.
- Lead with the headline features (one `##` heading each, with a
  short code snippet or `diff`), then fold the long tail into an
  `## Also in this release` bullet list.
- Put breaking changes in a `:::caution` callout at the top.
- Cite PRs inline as `([#NNN](…/pull/NNN))` and credit external
  contributors by name.
- End with a `## Where to go next` list of doc links plus the
  CHANGELOG and compare links.
