# Migrating from Effect v3 to Effect v4

> **Note:** Effect v4 is currently in beta. APIs may change between beta
> releases. This guide will evolve as the beta progresses and community
> feedback is incorporated.

## Background

Effect v4 is a major release with structural and organizational changes across
the ecosystem. The core programming model — `Effect`, `Layer`, `Schema`,
`Stream`, etc. — remains the same, but how packages are organized, versioned,
and imported has changed significantly.

### Versioning

All Effect ecosystem packages now share a **single version number** and are
released together. In v3, packages were versioned independently (e.g.
`effect@3.x`, `@effect/platform@0.x`, `@effect/sql@0.x`), making compatibility
between packages difficult to track. In v4, if you use `effect@4.0.0-beta.0`,
the matching SQL package is `@effect/sql-pg@4.0.0-beta.0`.

### Package Consolidation

Many previously separate packages have been merged into the core `effect`
package. Functionality from `@effect/platform`, `@effect/rpc`,
`@effect/cluster`, and others now lives directly in `effect`.

Packages that remain separate are platform-specific, provider-specific, or
technology-specific:

- `@effect/platform-*` — platform packages
- `@effect/sql-*` — SQL driver packages
- `@effect/ai-*` — AI provider packages
- `@effect/opentelemetry` — OpenTelemetry integration
- `@effect/atom-*` — framework-specific atom bindings
- `@effect/vitest` — Vitest testing utilities

These packages must be bumped to matching v4 beta versions alongside `effect`.

### Unstable Module System

v4 introduces **unstable modules** under `effect/unstable/*` import paths.
These modules may receive breaking changes in minor releases, while modules
outside `unstable/` follow strict semver.

Unstable modules include: `ai`, `cli`, `cluster`, `devtools`, `eventlog`,
`http`, `httpapi`, `jsonschema`, `observability`, `persistence`, `process`,
`reactivity`, `rpc`, `schema`, `socket`, `sql`, `workflow`, `workers`.

As these modules stabilize, they graduate to the top-level `effect/*` namespace.

### Performance and Bundle Size

The fiber runtime has been rewritten for reduced memory overhead and faster
execution. The core `effect` package supports aggressive tree-shaking — a
minimal Effect program bundles to ~6.3 KB (minified + gzipped). With Schema,
~15 KB.

---

## Migration Guides

### Import and API Rename Maps

- [v3 to v4 Import and API Rename Maps](./migration/v3-to-v4.md)

### Core

- [Services: `Context.Tag` → `Context.Service`](./migration/services.md)
- [Cause: Flattened Structure](./migration/cause.md)
- [Error Handling: `catch*` Renamings](./migration/error-handling.md)
- [Forking: Renamed Combinators and New Options](./migration/forking.md)
- [Effect Subtyping → Yieldable](./migration/yieldable.md)
- [Fiber Keep-Alive: Automatic Process Lifetime Management](./migration/fiber-keep-alive.md)
- [Layer Memoization Across `Effect.provide` Calls](./migration/layer-memoization.md)
- [FiberRef: `FiberRef` → `Context.Reference`](./migration/fiberref.md)
- [Runtime: `Runtime<R>` Removed](./migration/runtime.md)
- [Scope](./migration/scope.md)
- [Equality](./migration/equality.md)

### Modules

- [Schema v4 Migration Guide](./migration/schema.md)
