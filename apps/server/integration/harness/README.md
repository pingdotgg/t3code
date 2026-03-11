# harness (app adapter)

`harness` is the server-side adapter for replay E2E tests.

It wires `@t3tools/rr-e2e` primitives into T3 server services (Codex manager, Git/GitHub adapters, persistence, and web app bootstrapping).

## Key components

- `harness.ts`
  - Creates the runtime + Vite app and returns `{ appUrl, openPage, dispose }`.
- `codexProcess.ts`
  - Bridges Codex app-server lifecycle to generic JSON-RPC replay transport.
- `services.ts`
  - Bridges Git and GitHub service calls to generic CLI replay invoker.
- `types.ts`
  - App-facing aliases (`Fixture`, `Interaction`) over shared rr-e2e types.
- `../thread.rr-e2e.test.ts`
  - Scenario-driven browser tests using this adapter.
- `../thread.rr-e2e.test.fixture.ts`
  - Named fixtures (`bootstrap`, `happyPath`, `twoTurns`, `providerOffline`).

## How to add a new scenario fixture

1. Add a new named fixture in `thread.rr-e2e.test.fixture.ts`.
2. Reuse shared helpers (`baseGitInteractions`, `turnInteraction`, `makeBaseFixture`) whenever possible.
3. Add a test case in `thread.rr-e2e.test.ts` using `runScenario("<fixtureName>", ...)`.
4. Run replay E2E and fill any missing interactions reported by mismatch errors.

## How to record fixture changes safely

- Start with an existing passing scenario and mutate incrementally.
- Keep each interaction purpose-specific and named.
- Prefer state references (`$ref: "state.*"`) over duplicated literals.
- If a new backend IO method appears (for example `github.<newMethod>`), add only fixture entries; adapter code should usually not require changes.

For core replay semantics and matching rules, see `packages/rr-e2e/README.md`.
