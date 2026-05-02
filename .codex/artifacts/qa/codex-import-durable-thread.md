# Codex Import Durable Thread QA

Date: 2026-04-17
Branch: `codex/rebuild-feature-rollout`

## Environment

- Branch-backed local dev server in Chrome via the Computer Use plugin
- Target project: `t3-qa-codex-import-project`
- Full verification gate rerun on this checkpoint:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - `bun run test`
  - `bun run build`
  - `bun run build:desktop`

## Targeted automated coverage

- `cd apps/web && bun x vitest run --config vitest.browser.config.ts src/components/ChatView.browser.tsx -t "imports a Codex transcript into a durable thread from the global shortcut"`
- `cd apps/server && bun x vitest run src/codexImport/Layers/CodexImport.test.ts`

## Manual QA

### Scenario 1: Import a local Codex session into a durable ClayCode thread

1. Opened the branch-backed app in Chrome on a fresh project-backed thread context.
2. Triggered `Cmd+Shift+I`.
3. Verified the `Import from Codex` dialog opened and loaded live local Codex sessions.
4. Selected a real local Codex session.
5. Chose the target project `t3-qa-codex-import-project`.
6. Confirmed the import.
7. Verified the app navigated to a durable thread route (`/$environmentId/$threadId`) instead of a `/draft/...` route.
8. Verified the imported transcript content rendered in the message timeline.
9. Verified the thread activity showed the import provenance for the Codex session.

Result: pass

### Scenario 2: Reopen the import dialog after import

1. Reopened `Import from Codex` on the imported thread.
2. Verified the imported session row showed the `Imported` pill in the list.
3. Verified the preview pane showed `Import status: Already imported`.
4. Verified the primary action label changed to `Open imported thread`.
5. Confirmed the action and verified the app stayed on the already-imported durable thread rather than creating a duplicate thread.

Result: pass

## Observations

- The rebuild now matches the intended durable-history model: importing creates a real local thread instead of just prefilling a draft.
- Repeat imports are idempotent at the UX level: the UI clearly marks the existing imported thread and reopens it instead of duplicating content.
- The earlier stale React Query state bug is fixed. After importing, the list row, preview pane, and action button all update consistently without requiring a full dialog refresh.
