## Sidebar rename hotkey

Date: 2026-04-17
Branch: `codex/rebuild-feature-rollout`

### Scope

Verified the restored `Cmd+Shift+R` sidebar rename shortcut on the branch-local Electron dev app.

### Environment

- Branch-local desktop dev app launched from `/Users/canal/.codex/worktrees/28c4/t3code`
- Isolated desktop state rooted at `/tmp/t3-sidebar-rename-qa`
- Computer Use attached to the branch-local `ClayCode (Dev)` window after closing an older dev instance from a different worktree that shared the same bundle id

### Steps

1. Launched the branch-local desktop dev app with a fresh `T3CODE_HOME`.
2. Added `/Users/canal/.codex/worktrees/28c4/t3code` as a project.
3. Created a new thread by sending `rename hotkey qa`.
4. Pressed `Cmd+Shift+R`.
5. Confirmed the active thread row switched into inline rename mode with the existing title selected.
6. Replaced the title with `Sidebar rename hotkey pass`.
7. Pressed `Enter` to commit the rename.

### Result

Pass.

- `Cmd+Shift+R` opened inline rename on the active sidebar thread
- the current title was selected and editable immediately
- pressing `Enter` committed the rename
- the new title propagated to both the sidebar row and the thread header

### Notes

- A direct browser-based shortcut pass was misleading because Chrome reserves `Cmd+Shift+R` for hard reload. The reliable manual verification path for this shortcut is the desktop app.
- An older dev Electron app from another worktree was initially stealing the Computer Use attachment because both apps shared the same bundle id. Closing that older process fixed the QA environment.
