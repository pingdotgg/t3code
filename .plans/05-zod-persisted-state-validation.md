# Plan: Move Renderer Persisted-State Validation to Zod

## Summary

Use explicit Zod schemas for localStorage state parsing and migration.

## Motivation

- `apps/renderer/src/store.ts` has large manual sanitize functions.
- Manual type guards are verbose and easier to get wrong during schema evolution.

## Scope

- Renderer state hydration/persistence path.
- No backend/protocol changes.

## Proposed Changes

1. Add schema module: `apps/renderer/src/persistenceSchema.ts`
   - Persisted payload versions (`v1`, `v2`)
   - Thread/message/project schemas
2. Replace `sanitizeProjects/sanitizeThreads/sanitizeMessages` with schema parsing + transforms.
3. Keep migration logic explicit (legacy model migration and key migration).
4. Add tests for:
   - Invalid payload fallback to initial state
   - Legacy payload migration
   - Unknown thread/project references filtered

## Risks

- Overly strict schemas could drop valid historical data unexpectedly.

## Validation

- Unit tests for migration/hydration.
- Manual reload test with existing localStorage data.

## Done Criteria

- Store hydration logic is schema-driven.
- Migration behavior is tested and documented.
