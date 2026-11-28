# Diffs and workspace files

Inspect changes, browse or edit workspace files, and send line-specific feedback directly to your agent without leaving the thread.

## Diff pane

Open the Diff pane in the right panel (web and desktop) and choose a source from the source picker:

- **Turn changes**: Files edited, committed, or conflict-resolved by a specific turn (excludes unrelated files brought in by `git pull`/`merge`/`rebase`).
- **Uncommitted**: Current working-tree changes.
- **Changes**: Full branch comparison against your base branch.
- **Commits**: Inspect up to the newest 100 local commits individually.

In [multi-repo projects](./multi-repo-projects.md), use the repository picker beside the source picker to filter by repository.

- **Find in diff**: Click into a diff and press `mod+f` to search across all loaded files (automatically unfolds matching files; `Enter` / `Shift+Enter` navigates matches).

## Workspace files

Open files from agent file links, the file picker, or the Diff pane to read or edit them beside the conversation (editing over a remote connection requires `filesystem:write`).

- Supports syntax-highlighted code/JSON, rendered and raw views for Markdown, HTML, CSV, and TSV, PDF previews, and ZIP browsing up to 50 MB.
- Files outside the workspace open read-only.

## Inline review comments

Select lines in any diff or workspace file to leave a review comment. Comments attach to your composer as inline context chips so you can collect feedback across multiple files and send it to the agent in one message.

## Diff settings

Configure defaults in **Settings → Diffs & pull requests**:

- **Diff layout**: Unified (stacked) or split (side-by-side).
- **Diff colors**: Standard or colorblind-friendly palettes.
- **Hide whitespace changes**: Ignore whitespace-only edits.
- **Default diff file state**: Expanded or collapsed by default.
- **Open pull requests and changes panels proactively**: Automatically open relevant panels when turns finish.
- **Open pull requests in T3 Code**: Open PR and local commit links inside T3 Code instead of an external browser (`Cmd/Ctrl+Click` always opens in your external browser).
