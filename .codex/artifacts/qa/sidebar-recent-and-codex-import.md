# Sidebar Recent + Codex Import QA

Date: 2026-04-17
Branch: `codex/rebuild-feature-rollout`

## Environment

- Branch-backed local dev server on `http://localhost:5763`
- Safari QA executed through the Computer Use plugin
- Targeted automated coverage passed:
  - `cd apps/web && bun run test -- src/components/Sidebar.logic.test.ts src/localApi.test.ts`
  - `cd apps/web && bun run test:browser -- src/components/ChatView.browser.tsx -t "imports a Codex transcript into a new draft thread from the global shortcut"`

## Manual QA

### Scenario 1: Sidebar grouped/recent parity

1. Opened the local branch-backed app in Safari.
2. Verified the sidebar exposes the `Grouped` / `Recent` toggle beside the Projects header.
3. Switched from `Grouped` to `Recent`.
4. Verified the sidebar changed to a recency-bucketed list with a `TODAY` heading.
5. Verified the recent row showed the project label `server` beneath the thread title.
6. Switched back to `Grouped`.
7. Verified the grouped project tree returned with the `server` project row and nested thread row.

Result: pass

### Scenario 2: Codex import dialog discovery + session loading

1. Triggered `Cmd+Shift+I` in Safari.
2. Verified the `Import from Codex` dialog opened.
3. Waited for the dialog to finish loading.
4. Verified the dialog loaded live local Codex history and reported `50 sessions`.
5. Verified the target-project picker defaulted to the current project (`server`).

Result: pass

### Scenario 3: Codex import end-to-end through Safari accessibility

1. Tried selecting a loaded Codex session through the Safari accessibility tree.
2. Tried closing and reopening the dialog, keyboard interaction, and direct row clicks.

Result: inconclusive

## Observations

- The sidebar recent-mode parity is back: date buckets render and the recent row now includes the project label.
- The Codex import dialog is wired and loading real local sessions through the running app.
- The final click-through import step was flaky specifically under Safari + Computer Use because the accessibility tree kept a hidden dialog layer around after interaction, so row selection and dialog dismissal were unreliable in that session.
- The browser test still covers the actual import-to-draft flow end to end, and it passed in the same code state.
