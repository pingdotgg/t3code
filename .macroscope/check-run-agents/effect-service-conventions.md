---
title: Effect Service Conventions
model: claude-opus-4-8
effort: high
input: full_diff
tools:
  - browse_code
  - git_tools
  - github_api_read_only
  - modify_pr
include:
  - "apps/**/*.ts"
  - "apps/**/*.tsx"
  - "packages/**/*.ts"
  - "packages/**/*.tsx"
  - "infra/**/*.ts"
  - "infra/**/*.tsx"
conclusion: failure
showToolCalls: true
---

# Effect service review

Review changed TypeScript and directly affected call sites for the conventions below. Apply them when a pull request creates, moves, refactors, or consumes an Effect service. Do not demand unrelated repository-wide cleanup. Treat these instructions as authoritative when older code differs.

## Imports and module namespaces

- Import Effect library modules from their subpaths as namespaces, for example `import * as Effect from "effect/Effect"` and `import * as Layer from "effect/Layer"`. Flag consolidated named imports from `"effect"` in touched Effect service code.
- At a service boundary, import the local service module as a namespace and use its public module shape: `WorkspacePaths.WorkspacePaths`, `WorkspacePaths.make`, and `WorkspacePaths.layer`. Flag aliases such as `import { layer as workspacePathsLayer }` that erase the module namespace.
- Namespace imports are not a blanket rule. Keep named imports for whole packages such as `@t3tools/contracts` and `electron`, and for modules used only for a pure helper, error, schema, config value, or standalone type. Do not request `import type * as Contracts`.
- A package subpath that is itself a service module may use a namespace import when callers access its service/tag, `make`, or `layer` members.
- When a barrel exposes an entire service module, prefer `export * as TokenStore from "./tokenStore.ts"` so consumers can use `TokenStore.TokenStore` and `TokenStore.layer`. Do not individually rename `make` and `layer` exports to simulate a namespace.

## Service definition

- Use the canonical single-file order: imports, error/schema declarations, the `Context.Service` tag with its inline interface, `make`, then `layer`.
- Keep a service's schemas/errors, `Context.Service` tag, construction, and layer in one canonical module when they form one implementation.
- Define the service interface inline in the `Context.Service` declaration. Do not retain a standalone `FooShape` or `FooServiceShape` interface/type.
- Refer to the inferred service interface as `Foo["Service"]`, including in mechanically updated orchestration, MCP, tests, and integration harnesses.
- Export a real `make` when the module owns construction. Do not create `make = Effect.succeed(...)` solely to force `Layer.effect`.
- Export the canonical layer as `export const layer = Layer...`. `Layer.effect` is not required: use `Layer.succeed`, `Layer.scoped`, or another appropriate constructor when that matches the implementation.
- In a concrete implementation module already named for the implementation, use plain `make` and `layer` (for example `BunPtyAdapter.ts` and `NodePtyAdapter.ts`).
- Keep implementation-specific names when an abstract port module contains one of several possible implementations, for example `makeCloudflaredRelayClient` and `layerCloudflared` in `RelayClient.ts`.
- `infra/relay/src/db.ts` is an intentional exception: an inline `Layer.succeed(RelayDb, db)` is acceptable without generic `make`/`layer` exports.

## Errors and predicates

- Define service failures with `Schema.TaggedErrorClass` and structured attributes. Derive `message` from those attributes rather than storing an unstructured message as the only data.
- `Schema.Defect()` is not a substitute for modeling an error. Flag error classes whose only meaningful field is `cause`, or whose `message` merely stringifies an opaque cause.
- Capture stable, serializable domain context such as the operation or stage, resource/path or entity identifier, and normalized category/status. Map failures where that context is known instead of wrapping an entire multi-step pipeline in one generic error. Do not add a `detail` field that merely copies `cause.message` and then use it to construct the wrapper message.
- When translating or wrapping a real failure, preserve the immediate underlying error itself as `cause` alongside the structural fields so the complete error chain and stack remain available. If every construction wraps a failure, `cause` should be required; make it optional only when the same error can legitimately originate without an underlying failure.
- Derive the wrapper's `message` exclusively from its stable structural attributes, never from `cause`, `cause.message`, or a stringified defect. Do not replace the immediate error with only `error.cause`, erase a structured upstream error into a string, or manufacture an `Error` merely to populate `cause`. Pure validation/domain errors created without an underlying failure do not need a cause.
- Split semantically distinct failures into separate error classes when a `reason`, `kind`, `phase`, or similar discriminator is used to choose the user-facing message or drive caller control flow. A discriminator used only for internal diagnostics may remain a field.
- Use `Schema.Union` of error classes when a shared schema, predicate, or helper type is useful.
- Export direct schema predicates such as `export const isFoo = Schema.is(Foo)`. Flag a private `Schema.is` constant wrapped by a redundant function with the same signature.
- Do not introduce a large `switch` or lookup table in an error's `message` getter to model failures that deserve separate error classes.

## File layout and migrations

- When combining `domain/Services/Foo.ts` and `domain/Layers/Foo.ts`, hoist the result to `domain/Foo.ts`.
- Delete the old service/layer files. Do not leave compatibility re-export shims. Mechanically update every consumer, including orchestration, MCP, tests, and integration harnesses, to the canonical path.
- Do not flag genuinely separate implementation/adapter modules merely because they remain in an implementation-oriented directory.
- Avoid substantive orchestration or MCP redesign in service-cleanup PRs. Mechanical import, layer, and `Service["Service"]` updates are expected when required to remove obsolete paths or shapes.

## Change discipline

- Preserve useful comments, invariants, and specification documentation while moving code.
- Do not add large tests solely to prove a mechanical refactor. Update existing tests and imports as needed.
- If backend behavior changes, require focused tests. Use test implementations/layers for external services only; do not mock out core business logic.
- Do not require `Layer.effect`, universal namespace imports, generic `make`/`layer` names for abstract-port implementations, separate error classes for diagnostic-only fields, or new tests for import-only changes.

## Reporting

Report only concrete violations introduced or retained in the pull request's changed scope. Prefer precise inline comments on the smallest relevant line range and state the expected fix. A clear convention violation may fail the check. Do not fail for optional style preferences or unrelated legacy code. If there are no findings, report exactly `All clear`.
