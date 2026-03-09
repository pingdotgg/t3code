# Claude Code Support — Execution Plan

## Goal

Ship `claudeCode` as a first-class provider in the current `apps/server` + `apps/web` stack, with predictable lifecycle behavior, canonical runtime events, and capability-driven UI gating.

## Architecture Fit

This track is intentionally aligned to the current codebase, not legacy `apps/renderer` assumptions.

### Server runtime path

- `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts`
- `apps/server/src/provider/Services/ClaudeCodeAdapter.ts`
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- `apps/server/src/provider/Layers/ProviderHealth.ts`
- `apps/server/src/serverLayers.ts`
- `apps/server/src/wsServer.ts`

### Shared contracts / model path

- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/providerRuntime.ts`
- `packages/contracts/src/model.ts`
- `packages/contracts/src/server.ts`
- `packages/shared/src/model.ts`

### Web path

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/store.ts`
- `apps/web/src/session-logic.ts`
- `apps/web/src/appSettings.ts`
- `apps/web/src/routes/_chat.settings.tsx`
- `apps/web/src/wsNativeApi.ts`

## Execution Tracks

### 1. Contracts and capability matrix

- Widen `ProviderKind` to include `claudeCode`.
- Define provider capability contracts in `packages/contracts/src/provider.ts`:
  - `sessionModelSwitch`
  - `supportsApprovals`
  - `supportsUserInput`
  - `supportsResume`
  - `supportsCollaborationMode`
  - `supportsImageInputs`
  - `supportsReasoningEffort`
  - `supportsServiceTier`
  - `supportsConversationRollback`
- Extend provider model options in `packages/contracts/src/model.ts`:
  - Codex: `reasoningEffort`, `fastMode`
  - Claude Code: `effort`
- Extend runtime raw-source contracts in `packages/contracts/src/providerRuntime.ts` for Claude-native stream events.
- Surface provider capabilities through `packages/contracts/src/server.ts` so `server.getConfig` becomes the single source of truth for provider availability + feature gating.

### 2. Server adapter and session lifecycle

- Add a dedicated `ClaudeCodeAdapter` under `apps/server/src/provider`.
- Keep Codex-specific logic isolated in Codex modules.
- Use the Claude runtime adapter to own:
  - session startup / resume
  - turn dispatch
  - interrupt / stop
  - canonical event emission
  - capability reporting
- Preserve `ProviderService` as the cross-provider routing layer.
- Preserve `ProviderSessionDirectory` as the persisted thread → provider binding / resume binding layer.
- Register Claude in `ProviderAdapterRegistryLive` and `makeServerProviderLayer()`.

### 3. Health checks and WebSocket/API surface

- Extend `ProviderHealthLive` to probe Claude install/auth status alongside Codex.
- Keep `server.getConfig` as the main transport surface for provider status + capability data.
- Ensure `server.configUpdated` pushes continue to carry the latest provider status objects.
- Do not add a parallel Claude-specific RPC surface unless the orchestration path cannot express a required operation.

### 4. Web provider parity

- Drive provider availability from `server.getConfig().providers`, not hardcoded placeholders.
- Keep `PROVIDER_OPTIONS` as the UI label list, but compute selectable / unavailable providers from server status.
- Extend settings to support custom Claude model slugs.
- Extend the composer model / effort controls so they respect provider capabilities.
- Gate unsupported features via capabilities instead of provider-name checks:
  - image inputs
  - plan/default interaction mode
  - service tier
  - conversation rollback
- Keep event rendering provider-agnostic by consuming orchestration projections only.

### 5. Reliability requirements

- Resume / reconnect must rely on persisted provider session bindings, not fragile UI state.
- Provider restarts must keep behavior deterministic:
  - no silent provider swapping
  - no hidden capability fallback without an explicit runtime warning
- Partial stream handling must continue to produce stable timeline state if a turn is interrupted mid-stream.
- Session stop / interrupt flows must settle orchestration thread state instead of leaving it ambiguous.

## Current implementation notes

This implementation track favors shared abstractions over one-off branching:

- provider capabilities are shared through contracts and reused by both server and web
- provider status and capability data flow through `server.getConfig`
- UI gating uses capability data instead of hardcoded `provider === "codex"` checks where possible
- Claude support is added through the existing adapter / registry / service architecture instead of special-casing `wsServer`

## Follow-up work after this track

- Persist a thread-level preferred provider so idle threads do not need model-based provider inference.
- Add richer Claude permission / elicitation bridging if the adapter surface stabilizes enough to expose it predictably.
- Add Claude image-input support once the runtime path supports structured non-text turn inputs cleanly.
- Revisit rollback / checkpoint parity if Claude exposes reversible conversation history primitives.
- Add targeted integration tests for reconnect, restart, and interrupted partial-stream recovery on Claude sessions.
