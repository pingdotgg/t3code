# webAppReplayHarness (app adapter)

This directory intentionally keeps only app-specific adapter logic and replay test support.

Folder conventions:

- `adapter/`: T3-specific replay adapters for Codex, git, GitHub CLI, and no-op platform services.
- `runtime/`: temporary environment creation, Effect layer assembly, and Vite/web server startup.
- `testSupport/`: Playwright helpers and fixture builders used by `*.rr-e2e.test.ts` suites.

Test conventions:

- Record/replay browser suites use the suffix `*.rr-e2e.test.ts`.
- Their fixtures live beside them as `*.rr-e2e.test.fixture.ts`.
- Prefer `page.getByTestId(...)` for navigation and interaction selectors.

Core record/replay primitives live in `@t3tools/rr-e2e` (`packages/rr-e2e`). This adapter should not carry local copies of generic replay resolver, template, CLI, fixture-loader, or JSON-RPC process code.
