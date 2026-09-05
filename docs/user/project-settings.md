# Project settings

Open **Settings → Projects** and select a project to change its preferences.

## Reconnect a moved folder

If a project folder was moved or renamed, open its project settings and update the folder under
**Checkout**. Select the folder in the checkout's environment. This keeps the project's conversations
and settings without moving files. A folder already registered as another project cannot be selected.

An active provider session adopts the new folder on its next turn. Worktree conversations keep their
own paths; updating the project folder does not relocate or repair a worktree.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to every checkout in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
