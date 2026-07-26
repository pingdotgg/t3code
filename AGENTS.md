# AGENTS.md

## Task Completion Requirements

- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands locally unless the user explicitly requests them. CI is responsible for the full verification suite.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass for each affected client surface after integrating the work:
  - Web: use the `test-t3-app` skill. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - Mobile: use the `test-t3-mobile` skill. Connect one representative iOS Simulator or Android Emulator available on the host to one isolated environment and verify the affected flow. On compatible macOS hosts, prefer iOS for cross-platform changes and stream it through serve-sim in the T3 Code in-app browser or another available agent browser; use Android when it is the affected or viable platform.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Antigravity provider

The `antigravity` driver wraps the Antigravity CLI (`agy`), which has **no native agent
protocol**. `apps/server/src/provider/acp/antigravity/agyBridge.ts` presents the ACP surface
`AcpSessionRuntime` needs and runs each turn through `agy --print`, shipping as hidden
subcommands of the server binary (`t3 agy-acp`, `t3 agy-hook`).

A live event stream is reconstructed from two documented Antigravity sources that correlate on
step index (`stepIdx` in a hook == `step_index` in the transcript):

- **Hooks** (`PreToolUse`/`PostToolUse`/`Stop`) give tool name, arguments, and status. The bridge
  registers them via a throwaway `--add-dir` workspace so nothing is written into the user's repo.
  Both the session cwd and that hook workspace must be passed — `--add-dir` replaces the workspace
  rather than adding to cwd, so passing only the hook dir hides the project from the agent.
- **The trajectory transcript** (`transcript.jsonl`) gives assistant text and real tool output as
  the turn runs. Its record format is undocumented, so parsing degrades to emitting nothing.

Known constraints, all inherent to print mode:

- Tools are auto-approved (`--dangerously-skip-permissions`); no approval flow is possible.
- No image attachments, and no session modes.
- The model binds when the bridge spawns `agy`, so `sessionModelSwitch` is `"unsupported"`.
- Any `agy` subcommand spawned for a probe must set `stdin: "ignore"`. `agy` starts a language
  server and will not emit output while stdin stays open, so the default `"pipe"` hangs it.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
