# Deep Search + Project Search QA

Date: 2026-04-17
Branch: `codex/rebuild-feature-rollout`

## Terminal gate

- `bun fmt`
- `bun lint`
- `export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH" && bun typecheck`
- `export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH" && bun run test`
- `export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH" && bun run build`
- `export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH" && bun run build:desktop`

Result:

- passed
- `bun lint` still reports the same 8 pre-existing warnings and 0 errors

## Targeted automated coverage

- `cd apps/web && bun run test -- keybindings.test.ts globalThreadSearch.test.ts projectFolderSearch.test.ts quickThreadSearch.test.ts`
- `cd apps/web && bun run test:browser -- src/components/GlobalThreadSearchDialog.browser.tsx src/components/ProjectFolderSearchDialog.browser.tsx src/components/QuickThreadSearchDialog.browser.tsx`
- `cd apps/web && bun run test:browser -- src/components/GlobalThreadSearchDialog.browser.tsx src/components/ProjectFolderSearchDialog.browser.tsx src/components/QuickThreadSearchDialog.browser.tsx src/components/ChatView.browser.tsx -t "global shortcut"`

Result:

- passed

## Computer Use QA

Environment:

- Chrome against local dev server at `http://localhost:5737`

Checks:

1. Opened the command palette from the live app.
2. Confirmed `Search all threads` was present as a top-level action.
3. Opened `Search All Threads`.
4. Searched for `new` and verified the current `New thread` result appeared with title highlighting.
5. Closed the dialog and reopened the command palette.
6. Confirmed `Search project folders` was present as a top-level action.
7. Opened `Search Project Folders`.
8. Verified the live sidebar project appeared as a selectable result.
9. Selected the result and confirmed the app navigated to a fresh draft-thread route (`/draft/...`).

Result:

- passed for both dialog flows and the project-selection navigation path

Notes:

- Direct shortcut injection through Computer Use remained browser-sensitive, so the authoritative live verification came from opening the dialogs through the app surface rather than relying only on raw modifier chords.
- The live command palette showed older shortcut hints for `threads.searchAll` / `projects.search`. That was not a checked-in code regression: this machine has saved overrides in `~/.t3/userdata/keybindings.json` and `~/.t3/dev/keybindings.json` mapping those commands to older shortcuts. The checked-in defaults, docs, and tests now expect `Cmd/Ctrl+Alt+F` and `Cmd/Ctrl+Alt+P`.
- Queue-row `Alt+Up/Down` parity was already covered in `apps/web/src/components/QueuedFollowUpsPanel.browser.tsx`; a fresh manual live pass for that interaction was blocked here because the local Codex provider on this dev server timed out before a runnable queued-follow-up state could be created.
