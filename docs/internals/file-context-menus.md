# File context menus

> For maintainers. Using T3 Code? See [docs/user](../user/).

Every surface that shows a workspace file — as a chip, a row, or a tree node — must offer the
shared file context menu on right-click. The menu is how a user bridges from the app to their own
tools, so a file surface without it dead-ends: the user can see the file but cannot reach Finder,
Explorer, or their editor.

## The rule

A file surface's context menu must include, when the environment supports them:

- **Show in Finder / Explorer / Files** — reveals the file on the environment host, server-side,
  so it works over local, remote, and tunnel connections.
- **Open with** — a submenu of the environment's detected editors, with remote deep links when
  this client is not on the environment's machine.

The menu may add surface-specific items around the shared ones (a diff panel adds diff actions, a
markdown chip adds preview and copy actions), but the shared items are never dropped and never
reimplemented with different behavior.

## The mechanism

`apps/web/src/fileContextMenu.ts` owns the menu. `useFileContextMenu(environmentId)` resolves
capabilities once per environment (detected editors, the server's `shellRevealInFileManager`
gate and its reveal wording, remote-open mode), and returns `buildItems` and `activate`.
`useFileContextMenuHandler(environmentId)` wraps them into an `onContextMenu` callback.

To cover a new surface:

1. Build a `FileContextMenuTarget`: an absolute environment-host path or a repo/workspace-relative
   path, plus the `workspaceRoot` (and `repositoryRoot` for repo-relative paths inside a nested
   worktree) needed to resolve it.
2. Wire the surface's right-click (and click-with-no-other-primary-action, for chips that are not
   links) to `useFileContextMenuHandler` or, when the surface has extra items of its own, call
   `buildItems` and `activate` around them the way `MarkdownFileLink` does.
3. Do not fork the actions. If a surface needs a variation, change `fileContextMenu.ts` so every
   surface benefits.

## Covered surfaces

- Chat changed-files tree and activity rows (`ChangedFilesTree`, `MessagesTimeline`).
- Diff panel file headers (`DiffPanel`).
- Workspace file browser (`FileBrowserPanel`).
- Markdown file-link chips in messages and previews (`MarkdownFileLink` in `ChatMarkdown`).

Not covered yet, tracked as follow-ups: composer file-mention chips (they live inside the Lexical
editor and need environment context threaded into the decorator) and mobile, which has no
right-click; long-press there should eventually map to the same menu.
