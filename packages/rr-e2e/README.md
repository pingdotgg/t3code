# @t3tools/rr-e2e

Deterministic record/replay primitives for integration and browser E2E tests.

This package owns **replay mechanics** only. App-specific wiring (server layers, service bindings, browser bootstrapping) belongs in app adapters like `apps/server/integration/harness`.

## Key components

- `types.ts`
  - Canonical fixture, interaction, and replay scope types.
- `template.ts`
  - `$ref` template resolution (`state.*`, `request.*`) and structural matching helpers.
- `interactionResolver.ts`
  - Finds matching interactions and applies `capture` / `setState` mutations.
- `fixtureLoader.ts`
  - Loads `<test>.fixture.ts` and supports single fixture or named fixture maps.
- `cliReplay.ts`
  - Generic invoker for execute-style services (`<service>.<operation>`).
- `jsonRpcProcessReplay.ts`
  - Generic JSON-RPC-over-stdio replay process for CLI app-servers.

## Fixture model

A fixture is a sequence of interactions against named services.

```ts
{
  version: 1,
  state: { ... },
  providerStatuses: [ ... ],
  interactions: [
    {
      name: "codex turn start",
      service: "codex.request",
      match: { method: "turn/start", ... },
      whenState: { turnIndex: 0 },
      capture: { userPrompt: "request.params.input.0.text" },
      setState: { turnIndex: 1 },
      result: { ... },
      notifications: [ ... ]
    }
  ]
}
```

### Matching rules

1. `service` must match exactly.
2. `match` must partially match incoming request.
3. `whenState` must partially match current replay state.
4. After match, `capture` and `setState` update state for subsequent interactions.

## How to record new fixtures

There is no auto-recorder yet; fixture recording is a guided workflow.

1. **Start from a working scenario fixture**
   - Copy the nearest existing scenario in `<test>.fixture.ts`.
2. **Run the target test in replay mode**
   - Example: `T3CODE_E2E=1 bun run --cwd apps/server test:e2e`
3. **Use mismatch errors as your capture signal**
   - When an interaction is missing, replay throws an error including service + request payload.
   - Add a new interaction with that `service` and `match` payload.
4. **Fill deterministic outputs**
   - Add `result` and optional `notifications` expected by the UI flow.
5. **Thread state forward**
   - Use `capture` and `setState` for IDs and cross-step references instead of hardcoding every value.
6. **Iterate until green**
   - Re-run and patch missing interactions until scenario stabilizes.
7. **Refactor fixture readability**
   - Extract shared interaction builders in the fixture file for repeated setup.

## Design guidance

- Keep interactions small and named by intent (`"git status porcelain"`, `"codex turn start 2"`).
- Prefer `state` references over duplicated constants.
- Keep fixtures stable and deterministic (timestamps/IDs should be explicit or state-derived).
