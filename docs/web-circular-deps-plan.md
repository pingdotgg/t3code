# Web Circular Dependency Cleanup Plan

## Goal

Break the verified web import cycle reported in [`ctx-analysis.md`](../ctx-analysis.md) without changing composer behavior.

## Evidence

### ctx report

- [`ctx-analysis.md`](../ctx-analysis.md) identifies this cycle:
  - `apps/web/src/components/chat/TraitsPicker.tsx`
  - `apps/web/src/composerDraftStore.ts`
  - `apps/web/src/modelSelection.ts`
  - `apps/web/src/components/chat/composerProviderRegistry.tsx`

### Live source references

- `apps/web/src/modelSelection.ts:171` resolves settings-backed model selection and currently reaches into the chat registry for provider-state normalization.
- `apps/web/src/components/chat/composerProviderRegistry.tsx:53` contains pure provider-state logic, while `apps/web/src/components/chat/composerProviderRegistry.tsx:93` also owns React rendering for traits controls.
- `apps/web/src/components/chat/TraitsPicker.tsx:163` reads the composer store during render.
- `apps/web/src/composerDraftStore.ts:628` calls back into model selection when deriving effective draft state.

### SCIP checks

The local SCIP index confirms the same edge chain:

```text
tools/scip-query deps apps/web/src/modelSelection.ts
  -> apps/web/src/components/chat/composerProviderRegistry.tsx

tools/scip-query deps apps/web/src/components/chat/composerProviderRegistry.tsx
  -> apps/web/src/components/chat/TraitsPicker.tsx

tools/scip-query deps apps/web/src/components/chat/TraitsPicker.tsx
  -> apps/web/src/composerDraftStore.ts

tools/scip-query deps apps/web/src/composerDraftStore.ts
  -> apps/web/src/modelSelection.ts
```

`tools/scip-query refs getComposerProviderState` also shows that the pure provider-state helper is consumed outside the registry, which is the coupling we want to undo.

## Checklist

- [x] Extract the pure provider-state normalization from `apps/web/src/components/chat/composerProviderRegistry.tsx:53` into a non-React helper module that does not import traits UI.
- [x] Update `apps/web/src/modelSelection.ts:171` to use the new pure helper directly.
- [x] Keep `apps/web/src/components/chat/composerProviderRegistry.tsx:93` focused on rendering traits UI and provider-specific composition.
- [x] Move or update the provider-state tests so they exercise the extracted helper directly.
- [x] Re-run graph checks plus `bun fmt`, `bun lint`, and `bun typecheck`, and confirm the web cycle no longer appears.

## Verification

- `bun fmt`
- `bun lint`
- `bun typecheck`
- `mcp__socraticode__codebase_graph_circular`
  - Remaining cycle: `packages/contracts/src/model.ts -> packages/contracts/src/orchestration.ts -> packages/contracts/src/model.ts`
- `tools/scip-query deps apps/web/src/modelSelection.ts`
  - Now points to `apps/web/src/composerProviderState.ts` instead of `apps/web/src/components/chat/composerProviderRegistry.tsx`
