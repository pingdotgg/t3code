# AGENTS.md

## Task Completion Requirements

- Run `pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck` before considering code tasks complete.
- Use `pnpm test` for the Vite Plus test suite.
- Current toolchain: `pnpm@11.10.0`, `node@^24.13.1`.
- When creating a worktree for a chat, create a new pull request after the work is complete. Create without separately confirming the title or body.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures: session restarts, reconnects, and partial streams.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long-term maintainability is a core priority. Before adding functionality, check whether shared logic should be extracted. Avoid duplicated logic, don't be afraid to change existing code, and don't solve problems with narrow local shortcuts.
Write only the small, concise amount of code needed to solve the problem; avoid unnecessary abstraction, features, and complexity.

## Scars

Read and follow [scars.md](scars.md) for hard-earned project constraints.

## Keep This File Updated

- Add hard-earned lessons to [scars.md](scars.md); keep each scar short, actionable, and specific.
