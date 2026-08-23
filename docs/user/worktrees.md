# Copy local files into new worktrees

When T3 Code starts a thread in a new worktree, Git checks out tracked files only. Untracked
local files — `.env` files, credentials, machine-specific config — stay behind in the original
checkout.

To copy those files into each new worktree automatically, add a `.worktreeinclude` file to the
repository root. List one pattern per line, using the same syntax as `.gitignore`:

```
# copied into every new worktree
.env
.env.local
secrets/
```

When a worktree is created, every untracked file in the original checkout that matches a pattern
is copied into the same location in the worktree. Patterns follow `.gitignore` rules: a bare name
like `.env` matches at any depth, a leading `/` anchors it to the repository root, and a trailing
`/` matches a whole directory.

The copy finishes before the project setup script runs, so a setup script can rely on the files
being there. A file that fails to copy never blocks the worktree: T3 Code logs a warning and the
thread starts normally.
