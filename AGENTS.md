# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Environment and Prompt Hygiene

- Do not hardcode personal, host-specific, or machine-specific details in committed code, prompts, docs, or tests unless the value is intentionally part of the product contract.
- Avoid embedding usernames, home directories, local paths, hostnames, private URLs, API keys, tokens, or secret file locations. Use generic capability statements, configuration names, or environment variable references instead.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vp run sync:repos`; use `vp run sync:repos --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.

## This Fork's Scope

This repository is a fork of T3 Code. The upstream product is still the base web UI and provider runtime for coding agents, but our work in this fork is primarily an orchestration layer built on top of it.

The main owned surface area is the external intake system: Slack intake, support-email intake, external thread linking, task worktree setup, assistant-message relay, and orchestration that starts or continues T3 threads from outside the web UI.

Prefer building new behavior at the orchestrator/external-intake boundary instead of changing core T3 Code internals. Treat upstream T3 internals as a platform dependency: touch them only when needed to expose a clean hook, fix a boundary bug, or keep the orchestrator integration reliable. Keep changes scoped so future upstream syncs stay manageable.

Key areas for this fork:

- `apps/server/src/externalIntake`: Slack/email intake, external-thread mapping, relay rules, and intake-specific agent prompts.
- `apps/server/src/orchestration`: domain commands/events/projections that connect intake, provider runtime, and UI state.
- `apps/server/src/provider`: provider adapters and session runtime boundaries; change these carefully and only when orchestration requires it.
- `apps/web`: UI surfaces for observing and steering orchestrated threads; avoid moving orchestration policy into client-only state.
