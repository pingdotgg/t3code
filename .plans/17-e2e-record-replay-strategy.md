# E2E Record/Replay Strategy

## Status: Phase 1 complete (PR #5)

## Goal

Deterministic browser E2E tests that exercise the full T3 Code stack (server + web) without real external processes. All IO (Codex JSON-RPC, Git CLI, GitHub CLI) is captured as fixture data and replayed, making tests fast, reproducible, and CI-friendly.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Playwright test                                │
│    └─ runScenario(fixtureName, async (page) =>) │
├─────────────────────────────────────────────────┤
│  createWebAppReplayHarness()                    │
│    ├─ Boots real WS server (port 0)             │
│    ├─ Boots Vite dev server (port 0)            │
│    └─ Injects replay layers via DI              │
├─────────────────────────────────────────────────┤
│  Replay transports (no real processes)          │
│    ├─ jsonRpcProcessReplay  (Codex app-server)  │
│    ├─ cliReplay             (git, gh)           │
│    └─ services              (terminal, open)    │
├─────────────────────────────────────────────────┤
│  Fixture data                                   │
│    ├─ Interactions (request→response pairs)     │
│    ├─ $ref templating for dynamic values        │
│    └─ whenState/setState for multi-turn flows   │
└─────────────────────────────────────────────────┘
```

## Phase 1: Replay infrastructure (done)

- [x] `CodexAppServerProcessController` interface for DI of process spawning
- [x] `ServerRuntimeLayerOptions` for swapping Git/GitHub/Terminal layers
- [x] Modular `webAppReplayHarness/` package with separated transports
- [x] Fixture format with `$ref` templating, `whenState`/`setState` sequencing
- [x] 5 E2E scenarios: bootstrap, happyPath, twoTurns, providerOffline, composerAfterTurn
- [x] Gated behind `T3CODE_E2E=1` env var

## Phase 2: Recording mode

Record real IO interactions to auto-generate fixture files.

### Tasks

- [ ] Add a `RecordingCodexProcessController` that wraps the real controller, proxies all calls, and captures request/response pairs as `ReplayInteraction[]`
- [ ] Add a `RecordingGitService` / `RecordingGitHubCli` wrapper that similarly captures CLI interactions
- [ ] Write captured interactions to `*.recorded.fixture.ts` files on harness dispose
- [ ] Add `T3CODE_E2E_RECORD=1` mode that uses recording wrappers instead of replay
- [ ] Normalize recorded fixtures (strip timestamps, normalize paths to `$ref` where possible)

### Design notes

- Recording wrappers should be thin proxies over the real implementations
- Auto-detect `$ref` candidates: any value matching `state.cwd` gets replaced with `{ $ref: "state.cwd" }`
- Recorded fixtures should be human-readable and diff-friendly (sorted keys, stable order)

## Phase 3: CI integration

- [ ] Install Chromium in CI via `npx playwright install chromium`
- [ ] Add a CI job that runs `T3CODE_E2E=1 bun run test apps/server/integration/webApp.replay.e2e.test.ts`
- [ ] Cache Playwright browsers between runs
- [ ] Add CI-specific timeout tuning (longer timeouts for cold starts)
- [ ] Screenshot capture on failure for debugging

## Phase 4: Expanded coverage

### New scenarios to add

- [ ] **Thread resume**: Navigate away and back, verify conversation persists
- [ ] **Multi-thread**: Create multiple threads, switch between them
- [ ] **Approval flow**: Codex requests approval, user approves/denies
- [ ] **Streaming**: Long streaming response with incremental rendering
- [ ] **Error recovery**: Mid-turn error, verify UI recovers gracefully
- [ ] **Sidebar interactions**: Thread list, search, multi-select
- [ ] **Git panel**: Branch display, status rendering
- [ ] **Keyboard shortcuts**: Verify key bindings trigger correct actions

### New IO surfaces

- [ ] **MCP replay transport**: When MCP support lands, add `mcpReplay.ts`
- [ ] **Claude Code replay**: When Claude Code provider ships, extend `jsonRpcProcessReplay` or add a parallel transport

## Phase 5: Snapshot testing

- [ ] Visual regression via Playwright screenshot comparison
- [ ] DOM snapshot assertions for critical UI states
- [ ] Integrate with a snapshot review tool (e.g. Argos, Percy, or local diffing)

## Key files

| File | Role |
|------|------|
| `apps/server/integration/webAppReplayHarness/createHarness.ts` | Harness bootstrap, wires all layers |
| `apps/server/integration/webAppReplayHarness/jsonRpcProcessReplay.ts` | Codex JSON-RPC replay transport |
| `apps/server/integration/webAppReplayHarness/cliReplay.ts` | Git/GitHub CLI replay transport |
| `apps/server/integration/webAppReplayHarness/interactionResolver.ts` | Fixture matching engine |
| `apps/server/integration/webAppReplayHarness/template.ts` | `$ref` resolution and JSON cloning |
| `apps/server/integration/webAppReplayHarness/types.ts` | Fixture schema types |
| `apps/server/integration/webApp.replay.e2e.test.fixture.ts` | Fixture definitions |
| `apps/server/integration/webApp.replay.e2e.test.ts` | Test scenarios |
| `apps/server/src/codexAppServerManager.ts` | Process controller interface |
| `apps/server/src/serverLayers.ts` | Layer override options |
