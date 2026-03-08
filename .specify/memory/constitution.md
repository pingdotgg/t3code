<!--
Sync Impact Report
- Version change: 0.0.0 → 1.0.0 (initial ratification)
- Added principles:
  I.   Correctness Over Convenience
  II.  Schema-First Contracts
  III. Event-Sourced State
  IV.  Provider Abstraction
  V.   Shared Logic, No Duplication
  VI.  Performance Under Load
  VII. Explicit Dependencies
- Added sections:
  - Technology Constraints
  - Quality Gates
  - Governance
- Templates requiring updates:
  - `.specify/templates/plan-template.md` ✅ no changes needed (Constitution Check is generic)
  - `.specify/templates/spec-template.md` ✅ no changes needed
  - `.specify/templates/tasks-template.md` ✅ no changes needed
  - `.specify/templates/commands/` — no command files present
- Follow-up TODOs: none
-->

# T3 Code Constitution

## Core Principles

### I. Correctness Over Convenience

When a tradeoff is required, choose correctness and robustness over
short-term convenience. Every code path MUST behave predictably under
load, during failures (session restarts, reconnects, partial streams),
and at system boundaries. Defensive shortcuts that mask broken state
(swallowing errors, ignoring malformed events, silently dropping
messages) are prohibited.

- Runtime errors MUST surface through Effect-TS error channels, never
  thrown as untyped exceptions in service code.
- Partial or degraded states MUST be represented explicitly in the
  domain model (e.g., session lifecycle enums), not inferred from
  absence of data.

### II. Schema-First Contracts

All domain models, WebSocket RPC methods, provider events, and
inter-package types MUST be defined as Effect schemas in
`packages/contracts`. This package is schema-only — no runtime logic.

- New domain concepts MUST start as a schema in contracts before any
  implementation code references them.
- Schema changes MUST be backward-compatible or accompanied by a
  migration plan that addresses all consumers (server and web).
- Contracts are the single source of truth for cross-boundary types;
  duplicating type definitions in consuming packages is prohibited.

### III. Event-Sourced State

Orchestration state MUST be derived from an append-only event log via
the command → event → projection pipeline. Direct mutation of
projected read models is prohibited.

- Commands express intent; events record what happened; projections
  compute current state.
- The decider (`orchestration/decider.ts`) owns all command-to-event
  business rules. No event creation outside the decider.
- The projector (`orchestration/projector.ts`) owns all
  event-to-read-model logic. Projections MUST be deterministic and
  reproducible from the event log alone.
- Checkpointing MUST NOT alter the semantics of replay — it is a
  performance optimization only.

### IV. Provider Abstraction

Multiple code-agent backends (Codex, Claude Code, future providers)
MUST be supported through a unified adapter interface that maps
provider-specific protocols to canonical `ProviderRuntimeEvent`
schemas.

- Each adapter implements the provider service shape and handles its
  own session lifecycle, error mapping, and event emission.
- Provider-specific types MUST NOT leak into orchestration, web, or
  shared packages. The boundary is the adapter layer in
  `apps/server/src/provider/Layers/`.
- Adding a new provider MUST NOT require changes to orchestration,
  persistence, or web packages — only a new adapter and any new
  contract schemas it needs.

### V. Shared Logic, No Duplication

Duplicate logic across multiple files is a code smell and MUST be
avoided. Before adding new functionality, check whether shared logic
can be extracted to `packages/shared` or `packages/contracts`.

- `packages/shared` uses explicit subpath exports
  (e.g., `@t3tools/shared/git`) — no barrel index.
- Utility code consumed by both server and web MUST live in
  `packages/shared`, not be copy-pasted between apps.
- Proposing sweeping refactors that improve long-term maintainability
  is encouraged even in early-stage code.

### VI. Performance Under Load

Streaming, efficient persistence, and resumability are first-class
concerns. The system MUST remain responsive during long-running agent
turns, large event logs, and concurrent sessions.

- WebSocket push MUST stream provider events incrementally; batching
  or buffering that introduces perceptible latency is prohibited
  unless explicitly justified.
- SQLite persistence (event store, projections) MUST use indexed
  queries. Full-table scans on hot paths are prohibited.
- Session resume and checkpoint restore MUST avoid replaying the
  entire event history when a recent snapshot exists.

### VII. Explicit Dependencies

All service dependencies MUST be declared via Effect-TS layers and
composed at the program edge. Hidden singletons, module-level mutable
state, and implicit service resolution are prohibited.

- Services define interfaces in `Services/` directories; concrete
  implementations live in `Layers/` directories.
- Layer composition is the sole mechanism for wiring services — no
  service locator or global registry patterns.
- Package imports MUST use explicit subpath exports where available;
  importing from barrel re-exports that bundle unrelated modules is
  prohibited.

## Technology Constraints

- **Runtime**: Node.js (server), browser (web). Bun is the package
  manager and script runner.
- **Monorepo**: Turborepo workspaces with four packages:
  `apps/server`, `apps/web`, `packages/contracts`, `packages/shared`.
- **Effect-TS**: Required for server-side service composition, error
  handling, and schema validation. Effect schemas are the canonical
  validation and serialization layer.
- **Frontend**: React 19, Vite, TailwindCSS, TanStack Router, Zustand
  for client state.
- **Persistence**: SQLite via `@effect/sql-sqlite-bun`. No ORM — use
  Effect SQL directly.
- **Linting**: oxlint. Formatting and lint rules MUST pass before any
  task is considered complete.
- **Testing**: Vitest with `@effect/vitest`. Invoke via `bun run test`
  (never `bun test`).

## Quality Gates

Every task and pull request MUST satisfy the following gates before
being considered complete:

1. **Typecheck**: `bun typecheck` MUST pass with zero errors.
2. **Lint**: `bun lint` MUST pass with zero errors.
3. **Tests**: All existing tests MUST continue to pass
   (`bun run test`). New behavior SHOULD include tests when the
   change is non-trivial.
4. **Schema compatibility**: Changes to `packages/contracts` MUST NOT
   break existing consumers without an explicit migration.
5. **No leaked provider types**: Orchestration and web code MUST NOT
   import provider-specific modules directly.

## Governance

This constitution is the highest-authority document for architectural
and process decisions in T3 Code. It supersedes ad-hoc conventions
unless those conventions are explicitly incorporated here.

- **Amendments** require updating this file, incrementing the version,
  recording the change in the Sync Impact Report comment, and
  verifying dependent templates remain consistent.
- **Versioning** follows semantic versioning:
  - MAJOR: Principle removal or incompatible redefinition.
  - MINOR: New principle or materially expanded guidance.
  - PATCH: Clarifications, wording, or non-semantic refinements.
- **Compliance review**: All pull requests SHOULD be reviewed against
  the principles listed above. Violations MUST be justified in the PR
  description or resolved before merge.
- **Runtime guidance**: `CLAUDE.md` provides day-to-day development
  instructions and MUST remain consistent with this constitution.
  If a conflict arises, amend whichever document is outdated.

**Version**: 1.0.0 | **Ratified**: 2026-03-08 | **Last Amended**: 2026-03-08
