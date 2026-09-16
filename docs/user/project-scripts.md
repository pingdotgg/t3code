# Project actions

Project actions are commands you run from the actions menu in a thread's terminal. Add them in
**Settings → Projects**, or check them into a `t3.json` file at the repository root (under
`scripts`) so everyone who opens the project can import them.

Two actions can carry a lifecycle role:

- **Setup** runs automatically in a new worktree right after T3 Code creates it. Use it to install
  dependencies, link environment files, or warm caches.
- **Teardown** runs automatically in a thread's worktree when you settle the thread. Use it to
  remove dependencies or build output so settled work stops taking up disk. It runs in the
  background without opening a terminal, so keep it quick and non-interactive.

Only one action can hold each role. When a thread with a teardown script is un-settled, the setup
script runs again so the worktree is ready before you continue.

Teardown is skipped when another active thread shares the same worktree, when the thread runs in
the project checkout rather than a worktree, or when the worktree no longer exists.

A `t3.json` with both roles looks like this:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "scripts": [
    { "name": "Setup", "command": "pnpm install", "runOnWorktreeCreate": true },
    { "name": "Teardown", "command": "rm -rf node_modules", "runOnThreadSettle": true }
  ]
}
```

Scripts receive `T3CODE_PROJECT_ROOT` (the project checkout) and `T3CODE_WORKTREE_PATH` (the
thread's worktree) as environment variables.
