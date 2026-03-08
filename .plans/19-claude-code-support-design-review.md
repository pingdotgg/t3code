# Design Review: Claude Code Support

## Summary

T3 Code is clearly being shaped toward multi-provider support, but the current implementation remains codex-first in both contracts and runtime assumptions. Claude Code support should land as a real provider adapter, not as a UI-only toggle.

## What Already Helps

- provider service / adapter architecture already exists under `apps/server/src/provider`
- provider session directory and resume binding already exist
- runtime events are normalized through canonical provider runtime ingestion
- the web UI already gestures at unavailable providers in the picker

These are strong foundations.

## Where Codex Still Leaks Through

### Contracts

`ProviderKind` is still effectively locked to Codex, so any provider abstraction above it is narrower than it appears.

Areas to widen first:

- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/model.ts`

### Runtime protocol assumptions

Codex-specific semantics are still embedded in:

- `apps/server/src/codexAppServerManager.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- collaboration mode / effort settings
- model selection and account handling
- resume semantics and turn lifecycle mapping

### UI assumptions

The UI already lists `claudeCode` as unavailable, but provider capabilities are not yet modeled deeply enough for different approval semantics, tool event shapes, or model option behavior.

## Recommended Direction

Treat Claude Code support as a canonical provider implementation with a first-class adapter and a capability matrix.

### Phase 1 — widen contracts

- expand `ProviderKind` to include `claudeCode`
- add provider capability contracts:
  - model switch mode
  - approval support
  - user input support
  - collaboration / planning support
  - resume support level

### Phase 2 — add adapter

Introduce:

- `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts`
- `apps/server/src/provider/Services/ClaudeCodeAdapter.ts`

This adapter should be responsible for:

- session startup
- send turn
- interrupt / stop
- request/approval response mapping
- event normalization into canonical `ProviderRuntimeEvent`

### Phase 3 — runtime normalization

Ensure `ProviderRuntimeIngestion` stays provider-agnostic by consuming canonical runtime events only.

If Claude requires provider-specific preprocessing, keep that inside the adapter layer.

### Phase 4 — UI enablement

- enable Claude in the provider picker only after the adapter is usable
- gate unsupported features off capability flags, not hardcoded provider checks

## Capability Matrix to Add

Every provider should declare at least:

- `sessionModelSwitch`
- `supportsApprovals`
- `supportsUserInput`
- `supportsResume`
- `supportsCollaborationMode`
- `supportsImageInputs`
- `supportsReasoningEffort`
- `supportsServiceTier`

This avoids future branching scattered across `ChatView.tsx`.

## Reentry Feature Implications

Claude support should plug into the proposed reentry engine in two ways:

1. as a runtime signal source through canonical provider events
2. as an optional recap writer backend once the provider is stable

The recap system should not assume Codex-only event fields or model option semantics.

## Risks

- resume behavior may not match Codex thread recovery semantics
- approval and tool event taxonomies may be materially different
- collaboration mode may not have a direct Claude equivalent
- provider-specific prompt tuning for recap generation could leak into server orchestration if not isolated

## Recommendation

Do **not** bolt Claude Code onto `CodexAppServerManager`. Instead:

- keep Codex-specific runtime logic in Codex modules
- add provider capability contracts first
- ship Claude through the existing adapter / registry / service architecture
- keep recap generation behind a separate model broker so runtime provider and recap writer provider can differ
