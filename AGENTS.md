# AGENTS.md

## Task Completion Requirements

- Run `pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck` before considering code tasks complete.
- Use `pnpm test` for the Vite Plus test suite.
- Current toolchain: `pnpm@11.10.0`, `node@^24.13.1`.
- When creating a worktree for a chat, create a new pull request after the work is complete. Create without separately confirming the title or body.
- Standing publication rule: whenever you make changes in a worktree, always commit them and create a pull request once the work is complete. Do not ask for confirmation — neither for creating the PR nor for its title or body. This standing instruction counts as publication authorization under skill-delivery.md; only an explicit per-request restriction (e.g. "leave uncommitted", "do not push") overrides it.

## Testing Strategy

- Never write unit tests after writing the code they test. If isolation is necessary, identify failure modes and write the tests first.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work rather than adding low-signal isolated tests.
- At the end of E2E tests, produce a verifiable, repeatable artifact that records the tested revision, reproduction steps, assertions, and observed results (for example, a test report with a trace or recording).
- If a system must be tested in isolation, first write down all the ways it could fail, then write the test and implementation code. Keep isolated tests only when they catch real bugs E2E tests miss.
- Design changes are not merge-ready without screenshots: every user-visible web change ships with before/after captures published to the PR via `pnpm pr:media`. When live data is unavailable, capture an isolated render with meaningful mock data instead of skipping.

## Links in Responses

- Always use explicit clickable Markdown links when referencing pull requests, issues, review comments, commits, workflow runs, or other external artifacts. Do not rely on bare IDs or automatic linking.
- Use the artifact's actual URL; link comments to their permalink. Label issues and PRs `#123` for this repository or `owner/repo#123` for another repository, for example `[github/copilot-cli#4743](https://github.com/github/copilot-cli/issues/4743)`.

## Integrated Product Validation

- Treat a request to implement or fix user-visible web behavior as permission to launch a worktree-isolated dev server and use the T3 Code collaborative browser, unless the user explicitly opts out or the flow would access nonlocal data.
- After integrating user-visible web changes, run one real-client pass with the `test-t3-app` skill. The primary agent owns this pass; delegated agents should not launch competing dev servers for the same workspace.
- For browser validation, call `preview_status` first. If no automation-capable tab is attached, call `preview_open` or `preview_open_and_snapshot` before concluding that browser automation is unavailable.
- Navigate local apps with an environment-port target, inspect a snapshot before interacting, prefer snapshot-provided semantic locators, and inspect the final snapshot plus console and failed-network diagnostics.
- A video is evidence, not the assertion. Validate observable behavior with snapshots, page state, console output, and network failures; record a short video when motion or timing is part of the change.
- Capture before/after screenshots for visual changes, showing the changed feature with meaningful test data. Authenticate before recording feature interactions. Keep pairing tokens, credentials, and other secrets out of screenshots, recordings, committed files, and durable logs.
- Include relevant screenshot or recording artifacts in the final handoff and pull request. Do not commit PR-only evidence to the repository.
- Use focused tests and a real-client pass to validate the changed behavior. `pnpm test:self` is a separate pairing/reconnect smoke check, relevant when those flows change; it is not a prerequisite or substitute for feature testing. Publish actual feature captures with `pnpm pr:media -- <PR URL> <capture files...>`, inspect the uploaded media, and describe the tested revision, actions, observations, and limitations in the PR. No feature-report JSON or media-derived pass/fail gate is required. Pairing smoke captures stay in local/CI diagnostics.
- Preserve the isolated dev process, authenticated browser tab, selected ports, and test state while the implementation loop is still active. Tear them down only after the task is complete.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures: session restarts, reconnects, and partial streams.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long-term maintainability is a core priority. Before adding functionality, check whether shared logic should be extracted. Avoid duplicated logic, don't be afraid to change existing code, and don't solve problems with narrow local shortcuts.
Write only the small, concise amount of code needed to solve the problem; avoid unnecessary abstraction, features, and complexity.

## Scars

Read the universal invariants in [scars.md](scars.md), then load the matching detailed subsystem section from [.agents/references/scars/full.md](.agents/references/scars/full.md) for the task at hand.

## Keep This File Updated

- Add hard-earned lessons to [.agents/references/scars/full.md](.agents/references/scars/full.md); keep each scar short, actionable, and specific, and update [scars.md](scars.md) when a new subsystem needs an index entry.
