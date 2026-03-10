# Plan: Centralize Model Normalization in Contracts

## Summary

Move model alias/default normalization into `packages/contracts` so desktop and renderer use one shared source of truth.

## Motivation

- Removes duplicated logic between:
  - `apps/desktop/src/codexAppServerManager.ts`
  - `apps/renderer/src/model-logic.ts`
- Prevents behavior drift when model aliases/defaults are updated.

## Scope

- Add shared model utilities to contracts.
- Update desktop and renderer to consume shared utilities.
- Keep renderer-specific display options in renderer.

## Proposed Changes

1. Add `packages/contracts/src/model.ts` with:
   - Canonical model list
   - Alias map
   - `normalizeModelSlug`
   - `resolveModelSlug`
   - `DEFAULT_MODEL`
2. Export model utilities from `packages/contracts/src/index.ts`.
3. Update `apps/desktop/src/codexAppServerManager.ts` to replace local alias map/helper.
4. Update `apps/renderer/src/model-logic.ts` to wrap or re-export shared functions.
5. Update tests:
   - Move/duplicate normalization tests to contracts.
   - Keep renderer tests focused on renderer-only behavior.

## Risks

- Desktop/renderer may currently rely on slightly different fallback behavior.
- Import graph must avoid bundling issues for Electron main/preload.

## Validation

- `bun run test`
- `bun run typecheck`
- Manual check that model selection and session start still send expected model slug.

## Done Criteria

- No duplicated alias/default map in desktop and renderer.
- Shared model utilities are contract-tested.
