---
title: Effect Service Conventions
model: gpt-5-6-sol
effort: medium
input: full_diff
tools:
  - browse_code
  - modify_pr
include:
  - "apps/**/*.ts"
  - "packages/**/*.ts"
  - "infra/**/*.ts"
exclude:
  - "**/*.test.ts"
labels:
  - vouch:trusted
requires:
  - Check
maxBudgetPerPR: 25
maxBudgetPerRun: 5
conclusion: failure
showToolCalls: true
---

# Effect service review

Review changed TypeScript for the conventions below. They apply when a pull request creates, moves, refactors, or consumes an Effect service. Review only the lines the PR changed; older code in the same file that predates these conventions is not a finding. Do not demand repository-wide cleanup.

## Imports and module namespaces

- Import Effect modules from their subpaths as namespaces: `import * as Effect from "effect/Effect"`, `import * as Layer from "effect/Layer"`. Flag named imports from the bare `"effect"` package.
- At a service boundary, import the local service module as a namespace and use its public shape: `WorkspacePaths.WorkspacePaths`, `WorkspacePaths.make`, `WorkspacePaths.layer`. Flag aliases such as `import { layer as workspacePathsLayer }` that erase the namespace.
- Named imports stay correct for whole packages such as `@t3tools/contracts` and for modules used only for a pure helper, error, schema, config value, or type. Do not request `import type * as Contracts`.
- When a barrel exposes a whole service module, prefer `export * as TokenStore from "./tokenStore.ts"` over individually renamed `make` and `layer` exports.

## Service definition

- One canonical module per service in this order: imports, error and schema declarations, the `Context.Service` tag with its interface inline, `make`, then `layer`.
- Define the interface inline in `Context.Service`. Do not add a standalone `FooShape` interface; refer to the inferred type as `Foo["Service"]`.
- Export a real `make` when the module owns construction. Do not write `make = Effect.succeed(...)` only to force `Layer.effect`; use `Layer.succeed`, `Layer.scoped`, or whichever constructor matches.
- Use plain `make` and `layer` in a module named for its implementation (`BunPtyAdapter.ts`). Keep implementation-specific names when one abstract port module holds several implementations (`makeCloudflaredRelayClient`, `layerCloudflared` in `RelayClient.ts`). `infra/relay/src/db.ts` may keep its inline `Layer.succeed(RelayDb, db)`.
- When a service moves, delete the old files and update every consumer, including orchestration, MCP, tests, and integration harnesses. Do not leave compatibility re-export shims.

## Dependency acquisition and runtime boundaries

- Production service construction acquires its Effect dependencies from the environment with `yield* Foo.Foo`, and `make`/`layer` types expose those requirements. Flag a factory that takes `Foo["Service"]` (or an object of Effect-returning methods) as a parameter when that value is a service dependency. Passing service instances explicitly in tests is fine; passing pure configuration, immutable domain values, or deliberate callback strategies is not service injection.
- Do not hide dependencies in module globals, closures over singleton services, or a `Layer.succeed` whose implementation calls runtime-backed or imperative APIs.
- `ManagedRuntime.make`, `runPromise`, and `runPromiseExit` belong at application or framework boundaries: React, native callbacks, CLI, HTTP adapters. Flag them in domain services, repositories, persistence, and service constructors. A named imperative adapter may bridge an Effect service into a Promise API but must not become a dependency of another Effect service.
- Do not create per-feature managed runtimes or Atom runtimes to hand the same owned resource to several consumers. Compose the resource once in an application-owned layer and provide its context to integration runtimes.
- When acquisition can fail and callers need fallback behavior, keep the failure typed in Effect (an error in the service operation or an explicit optional-service layer) rather than bypassing the layer through an imperative runtime.

## Errors

- Define service failures with `Schema.TaggedErrorClass` and structured attributes: operation or stage, resource path or entity identifier, normalized category or status. Derive `message` from those attributes only. Never derive it from `cause`, `cause.message`, or a stringified defect, and do not add a `detail` field that copies `cause.message`.
- When wrapping a real failure, keep the immediate underlying error as `cause` so the chain and stack survive. Make `cause` required if every construction wraps a failure. Pure validation or domain errors created without an underlying failure need no cause.
- Keep attributes and log annotations safe and bounded: no raw wire payloads, command arguments or output, signed URLs, credentials, query strings, or arbitrary defect text. Preserve the exact value only as `cause`; expose normalized categories, lengths, counts, and safe URL protocol or hostname where useful.
- At a translation boundary, pass through an already structured domain error when it is part of the target error channel; wrap only unknown or lower-level failures. Map failures where the context is known instead of wrapping a whole multi-step pipeline in one generic error.
- Do not encode the same distinction twice with both a specific error tag and a single-value `operation`, `reason`, `kind`, or `phase` literal. Split into separate error classes when a discriminator drives caller control flow or the user-facing message; a discriminator used only for diagnostics may stay a field. Caller-visible messages exposed through HTTP, RPC, persisted state, or UI are behavior and must survive a structural refactor.
- Do not add a helper whose only behavior is `(...args) => new SomeError({ ...args })`. Construct the error at the failure boundary. Keep a mapper only when it performs real normalization, passes through domain errors, or adds reusable context; when such a mapper belongs to the target error type, prefer a static factory on that class.
- Export predicates directly as `export const isFoo = Schema.is(Foo)`. Flag a private `Schema.is` constant wrapped by a function with the same signature.
- Catch statically known tagged failures with `Effect.catchTags({ ... })`, including for a single tag; do not use `catchTag` or `catchIf` with a schema predicate for that. `Effect.catch` is fine when the whole error channel is handled; `catchIf` is fine for structural predicates such as a platform error code.

## Change discipline

- Every new or broadened directive that disables a lint, type-checker, LSP, or static-analysis diagnostic needs an adjacent comment explaining why. The directive itself is not an explanation; a missing one is a concrete violation.
- If backend behavior changes, require focused tests that use test layers for external services only, never mocks of core business logic. Do not require new tests for mechanical refactors or import-only changes.
- Do not require `Layer.effect`, universal namespace imports, generic `make`/`layer` names for abstract-port implementations, or separate error classes for diagnostic-only fields.

## Reporting

Report only violations introduced by changed lines. Post each as a precise inline comment on the smallest relevant range and state the expected fix. A clear convention violation may fail the check; optional style preferences and untouched legacy code may not.

When there are no findings, make the entire final response exactly `All clear` on one line with nothing else.
