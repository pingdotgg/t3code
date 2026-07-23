# AWS Service Bring-Up Process

This document describes the process for going from zero to full Alchemy coverage for a single AWS service:

- all canonical resources
- all bindings
- all event sources
- all ergonomic helpers
- deterministic audit and test coverage checks

Use this process whenever adding a brand new AWS service or finishing an incomplete one.

## Goal

For a given AWS service, the end state should include:

1. Every canonical Alchemy resource for that service.
2. Every important AWS API operation represented either as:
   - a binding,
   - a resource lifecycle provider,
   - an event source surface,
   - or an intentional helper abstraction.
3. Runtime-specific event-source implementations where applicable.
4. End-to-end tests covering the implemented binding and event-source surface.
5. Deterministic audit checks that report what is still missing.

## Source Of Truth

Start from the distilled spec in:

- `.vendor/distilled/@distilled.cloud/aws/src/services/<service>.ts`

Never start from ad-hoc memory of the AWS service. The distilled spec is the source of truth for operations.

## Core Concepts

Every distilled operation must be classified into one of these buckets:

### 1. Binding

Use a binding when the operation is a runtime capability.

Examples:

- `GetItem(table)`
- `PutItem(table)`
- `ListTables()`
- `DescribeTable(table)`

Bindings are:

- one file per operation
- `Binding.Service` + `Binding.Policy`
- usually named `alchemy/src/AWS/<Service>/<Operation>.ts`

### 2. Resource

Use a resource when the operation set implies lifecycle ownership of infrastructure.

Examples:

- `createTable` / `updateTable` / `deleteTable` -> `Table`
- `createBucket` / `deleteBucket` -> `Bucket`

Resources are:

- canonical Alchemy infrastructure entities
- implemented as `Resource` contract + provider in a single file

### 3. Event Source

Use an event source when the service can push records/events into a runtime.

This always has two layers:

1. Service-level abstraction in `alchemy/src/AWS/<Service>/...`
2. Runtime-specific implementation in places like:
   - `alchemy/src/AWS/Lambda/...`
   - `alchemy/src/Process/...`

Examples:

- `notifications(bucket)`
- `messages(queue)`
- `changes(table)` for DynamoDB-style change streams

### 4. Helper

Use a helper when multiple raw operations should collapse into a more ergonomic surface.

Examples:

- `notifications(bucket)`
- `messages(queue)`
- batch or transaction wrappers

Helpers should not hide missing low-level primitives. Implement the primitives first.

## Resource Arity

Classify each binding by resource arity:

- `0`: service/account scoped
  - example: `ListTables`
- `1`: one resource
  - example: `GetItem(table)`
- `2+`: multiple resources
  - example: `RestoreTableToPointInTime(fromTable, toTable)`
  - example: copy, batch, or transaction style operations

This classification helps decide:

- binding shape
- helper shape
- policy shape
- whether the operation belongs on a resource or service surface

Arity should be modeled in terms of canonical resources whenever possible.

- good: a `2`-arity binding accepts `<From extends Table, To extends Table>`
- bad: a `2`-resource operation accepts one `Table` plus a raw `string` target name
- only fall back to raw identifiers when there is no real canonical resource to bind against
- when there's a missing canonical resource, that might suggest we need to add one

### Case Study: `ExecuteTransaction`

Use `ExecuteTransaction` as the reference pattern for bindings that touch `1..*` canonical resources.

The ambiguity we want to avoid is:

- bad: `ExecuteTransaction.bind()` with IAM `Resource: ["*"]`
- bad: `ExecuteTransaction.bind(tableNames: string[])`
- bad: a SID like `AWS.DynamoDB.ExecuteTransaction(2 table(s))` that hides which resources were bound

The required pattern is:

- good: `ExecuteTransaction.bind(tableA, tableB, ...)`
- good: the binding type requires at least one table
- good: the policy enumerates exactly those table ARNs
- good: the SID is deterministic and names the participating resources

Runbook for any `1..*` resource-bound binding:

1. Model the binding arguments as a non-empty tuple of canonical resources.
2. Call `.bind(resourceA, resourceB, ...)`, never `.bind()` with hidden resource discovery.
3. Before constructing the SID, sort the resources by `LogicalId` so equivalent calls produce the same binding identity.
4. Pass the sorted resource array into the `host.bind` template so the SID renders each resource name explicitly, for example `AWS.DynamoDB.ExecuteTransaction(TableA, TableB)`.
5. Build IAM `Resource` from those same sorted resources, for example `sortedTables.map((table) => table.tableArn)`.
6. Only use `Resource: ["*"]` if the operation is truly service-scoped or AWS IAM does not support resource-level scoping for that API.

Reference shape:

```ts
type ExecuteTransactionTables = [Table, ...Table[]];

const sortedTables = [...tables].sort((a, b) =>
  a.LogicalId.localeCompare(b.LogicalId),
);

yield *
  host.bind`Allow(${host}, AWS.DynamoDB.ExecuteTransaction(${sortedTables}))`({
    policyStatements: [
      {
        Effect: "Allow",
        Action: [
          "dynamodb:PartiQLSelect",
          "dynamodb:PartiQLInsert",
          "dynamodb:PartiQLUpdate",
          "dynamodb:PartiQLDelete",
        ],
        Resource: sortedTables.map((table) => table.tableArn),
      },
    ],
  });
```

## Full Bring-Up Loop

Follow this loop until audit is clean or only intentionally deferred items remain.

### Step 1: Run Audit

Run:

```bash
bun audit:service dynamodb
```

The audit should report:

- implemented bindings
- missing bindings
- resource lifecycle ops
- event source ops
- helper candidates
- registration gaps
- missing binding tests

### Step 2: Build The Service Model

Before coding, explicitly answer:

1. What are the canonical resources?
2. What bindings belong to each resource?
3. What service-scoped bindings exist?
4. What event-source surfaces exist?
5. What helpers should exist?
6. Which items are intentionally deferred?

For DynamoDB, for example:

- canonical resource: `Table`
- folded table-owned surface: local/global secondary indexes live on `Table`, not a standalone `SecondaryIndex` resource
- bindings: item/table/admin operations
- event source: Kinesis streaming destination / change stream surface
- helper: `streams(table)`

### Step 3: Implement Missing Bindings

Implement the smallest coherent slice first.

Good order:

1. read/admin bindings
2. write/update bindings
3. transaction/batch bindings
4. restore or special-case bindings

Binding conventions:

- one file per operation
- no auto-marshalling
- user passes raw AWS SDK/distilled types
- the binding should mostly inject resource identifiers like `TableName`
- policies should be explicit and minimal
- if an operation is `2+`-arity, the binding should capture all participating resources so the policy can stay least-privilege
- never use `Resource: ["*"]` for a resource-bound binding if it can be avoided by passing canonical resources to `.bind(...)`
- if an operation touches `1..*` canonical resources, model the binding to accept those resources explicitly so the policy can enumerate only those ARNs
- `Resource: ["*"]` is only acceptable when the operation is truly service-scoped or AWS does not support narrower resource-level IAM for that API
- do not add IAM `Sid` fields in `Binding.Policy` statements unless there is a demonstrated AWS requirement for one

Example:

- good: `GetItemRequest extends Omit<GetItemInput, "TableName">`
- bad: replacing AWS input types with custom marshalled `Record<string, any>`

### Step 4: Register Everything

After each binding/resource implementation, update:

1. `alchemy/src/AWS/<Service>/index.ts`
2. `alchemy/src/AWS/Providers.ts`

If registration is missing, audit should flag it.

### Step 5: Add Binding Tests Immediately

Every implemented binding should have a corresponding `describe("<BindingName>")` block in:

- `alchemy/test/AWS/<Service>/Bindings.test.ts`

Examples:

```ts
describe("GetItem", () => {
  test("gets an existing item", ...);
  test("returns undefined for missing item", ...);
});
```

```ts
describe("PutItem", () => {
  test("puts an item into the table", ...);
});
```

Deterministic rule:

- if a binding exists, audit should warn if the matching `describe("<BindingName>")` block is missing

### Step 6: Use A Real Lambda Fixture

Use a real Lambda fixture in:

- `alchemy/test/AWS/<Service>/handler.ts`

Pattern:

1. create resource(s)
2. bind operations
3. expose HTTP endpoints for each tested operation
4. use those endpoints from the E2E test

This keeps tests end-to-end while still giving fine-grained per-binding coverage.

Layer provisioning rule:

- when a Lambda fixture provides both composite layers and foundational binding layers, do not put them all in one flat `Layer.mergeAll(...)`
- composite layers include event sources, sinks, and higher-level helpers that themselves depend on lower-level bindings
- foundational layers include the binding/capability implementations such as `GetItemLive`, `PutObjectLive`, `PublishLive`, `PublishBatchLive`, and similar
- use `Effect.provide(Layer.provideMerge(...))` so the foundational layer group is provided to the composite layer group
- otherwise `Layer.mergeAll(...)` only unions outputs and requirements, and sibling layers do not satisfy each other's requirements

Required shape:

```ts
Effect.provide(
  Layer.provideMerge(
    Layer
      .mergeAll
      // composite services: event sources, sinks, helpers
      (),
    Layer
      .mergeAll
      // foundational bindings/capabilities they depend on
      (),
  ),
);
```

Example failure mode:

- `TopicSinkLive` depends on `PublishBatch`
- if `TopicSinkLive` and `PublishBatchLive` are only siblings in the same `Layer.mergeAll(...)`, the final Lambda effect still requires `PublishBatch`
- grouping them with `Layer.provideMerge(...)` removes that leaked requirement

### Step 7: Make Setup Observable

Fixture setup must log clearly:

- destroying previous resources
- deploying fixture
- function URL
- readiness probe URL
- readiness retries
- readiness success

If setup is confusing, add logs before adding retries.

### Step 8: Keep Readiness Failure Fast

Do not wait minutes for a function to become ready.

Current convention:

- if the function is not ready in about 20 seconds, fail the setup

Use a short retry budget and log each failed readiness attempt.

### Step 9: Implement Missing Resource Surface

Once bindings are in good shape, fill missing resource-level gaps:

- missing resource providers
- placeholder resources
- resource update/delete gaps
- missing nested infrastructure surfaces such as indexes or replicas

Important:

- audit may only recognize canonical resources implied directly by lifecycle operations
- you must still inspect the service for real resource-shaped gaps not fully inferred by the script

Example:

- a placeholder like `SecondaryIndex.ts` still counts as incomplete coverage until it is either removed or folded into the canonical resource model

### Step 10: Implement Event Sources

For stream/notification services:

1. define a service-level abstraction
2. add runtime-specific implementation(s)
3. add helper surface
4. add tests

When the event source needs an intermediate canonical resource, the binding should
create that resource automatically instead of forcing user code to instantiate it.
SNS is the reference case:

- the public binding is `notifications(topic).subscribe(...)`
- the Lambda runtime policy creates the `Subscription` resource automatically
- any service-to-Lambda invoke permission stays in the runtime policy layer that
  wires the event source, not in user code
- the canonical resource still exists and can be used directly when needed; the
  helper just creates it on behalf of the user

For DynamoDB-style changes this likely means:

1. table-side stream/destination surface
2. Lambda runtime integration
3. `streams(table)` helper
4. E2E coverage

### Step 11: Implement Helpers

After low-level primitives exist, add ergonomic helpers for:

- stream subscriptions
- batch operations
- transactions

Helpers should feel native to Alchemy and match established service patterns.

### Case Study: DynamoDB Streams

DynamoDB Streams is the reference pattern for mutable event-source configuration that belongs to a canonical resource but still needs binding-based composition.

Required shape:

- the canonical resource remains `Table`
- `Table` keeps stream state in its attributes, but does not accept `streamSpecification` as a plain input prop
- stream enablement is requested through the table binding contract
- the public helper is `streams(table).process(...)`
- the service-level abstraction lives in `alchemy/src/AWS/DynamoDB/Stream.ts`
- the Lambda runtime implementation lives in `alchemy/src/AWS/Lambda/TableEventSource.ts`

Why this pattern exists:

- stream enablement mutates the table itself
- the consumer is another resource, usually a Lambda Function
- prop-driven stream configuration makes circular composition awkward
- bindings let the consumer request the mutation while `Table` stays the canonical owner of stream state

Implementation rules:

1. The helper attaches stream requirements to `Table` through bindings.
2. The `Table` provider derives the effective stream configuration from bindings during `create` and `update`.
3. Zero stream bindings means the table stream should be disabled.
4. Multiple bindings may coexist only when they request the same `StreamViewType`.
5. Conflicting `StreamViewType` requests must fail deterministically before AWS calls are made.
6. Runtime-specific layers handle IAM, host wiring, and event-source mapping resources; they do not move stream ownership out of `Table`.

Lambda-first slice:

- implement `streams(table).process(...)` first for Lambda
- the Lambda layer binds the table stream requirement, grants stream-read IAM, and creates `AWS.Lambda.EventSourceMapping`
- Process or other runtimes can be added later without changing `Table` back to a prop-driven stream model

### Step 12: Re-Run Tests And Audit

After every meaningful slice:

1. run the service-specific E2E tests
2. rerun `bun audit:service <service>`
3. use the updated output to choose the next slice

Repeat until:

- no important missing bindings remain
- resource surface is complete
- event-source surface is complete
- tests are in place

## Deterministic Checks We Want

The audit should help enforce:

1. Missing bindings from distilled operations.
2. Missing registration in `index.ts`.
3. Missing registration in `Providers.ts`.
4. Missing `describe("<BindingName>")` blocks in `Bindings.test.ts`.
5. Avoidable `Resource: ["*"]` usage in non-zero-arity bindings.

Over time it should also grow to flag:

6. placeholder resources with no provider
7. missing event-source surface for detected stream operations
8. missing helper surface for known event-source patterns

## AWS-Specific Conventions Learned

### No Auto-Marshalling

Bindings do not auto-marshall request/response payloads for DynamoDB-style operations.

User responsibility:

- pass raw AWS/distilled input types
- marshal/unmarshal attribute values themselves

### `Output.interpolate`

Only use `Output.interpolate` when actually composing a string.

Examples:

- good: `table.tableArn`
- good: `Output.interpolate\`${table.tableArn}/index/\*\``
- bad: `Output.interpolate\`${table.tableArn}\``

### `Effect.orDie`

For Lambda test fixtures, apply `Effect.orDie` once at the outer request handler layer, not repeatedly per route.

### Binding Test Structure

Use one `describe("<BindingName>")` block per binding.

Inside that block:

- happy path
- relevant unhappy paths

Do not lump all bindings into one large undifferentiated test block.
