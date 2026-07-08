# AGENTS.md

## Task Completion Requirements

- Run `pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck` before considering code tasks complete.
- Use `pnpm test` for the Vite Plus test suite.
- Current toolchain: `pnpm@10.24.0`, `node@^24.13.1`.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures: session restarts, reconnects, and partial streams.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long-term maintainability is a core priority. Before adding functionality, check whether shared logic should be extracted. Avoid duplicated logic, don't be afraid to change existing code, and don't solve problems with narrow local shortcuts.

## Project Structure

- `.agents/`: agent skills and automation config.
- `.cursor/`, `.vscode/`, `.devcontainer/`: editor/dev environment config.
- `.docs/`, `.plans/`, `.pi/`: local planning/reference material.
- `.turbo/`: Turbo cache.
- `apps/`: deployable apps.
  - `desktop/`: desktop shell/app.
  - `marketing/`: marketing site.
  - `mobile/`, `mobile-react/`: mobile experiments/apps.
  - `server/`: Node WebSocket/API server and provider orchestration.
  - `web/`: React/Vite client UI.
- `assets/`: release/dev/prod assets.
- `docs/`: durable project and agent documentation.
- `oxlint-plugin-t3code/`: custom lint rules.
- `packages/`: shared workspace packages.
  - `client-runtime/`: client-side runtime helpers.
  - `contracts/`: schemas and protocol types only.
  - `effect-acp/`, `effect-codex-app-server/`: Effect wrappers/integrations.
  - `shared/`: shared runtime utilities via explicit subpath exports.
  - `ssh/`, `tailscale/`: connectivity integrations.
- `patches/`: dependency patches.
- `release/`: release metadata/config.
- `scripts/`: repo automation and build/dev helpers.

## Scars

- `packages/contracts` stays schema-only; no runtime logic.
- `packages/shared` uses explicit subpath exports; do not add a barrel index.
- Provider runtime activity is projected into orchestration domain events server-side before the web app consumes it.
- Session startup/resume and turn lifecycle are fragile paths; optimize for predictable restart/reconnect behavior over quick local fixes.

## Keep This File Updated

- Update **Project Structure** whenever top-level, `apps/`, or `packages/` directories are added, removed, or renamed.
- Add a **Scar** when a hard-earned lesson prevents repeat mistakes; keep each scar short, actionable, and specific.
