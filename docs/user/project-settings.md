# Project settings

Open **Settings → Projects** and select a project to change its preferences.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to every checkout in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Run worktree setup and teardown actions

Project actions can run automatically when T3 Code creates or removes a worktree. Use a setup
action to install dependencies or copy local environment files. Use a teardown action to stop
worktree-specific services or remove generated resources.

In **Settings** > **Projects**, edit an action and turn on **Run automatically on worktree
creation** or **Run automatically before worktree removal**. T3 Code runs teardown before it
deletes the worktree. If teardown fails, the worktree stays in place so you can fix the command
and try again.

Actions imported from `t3.json` support `runOnWorktreeCreate` and `runOnWorktreeRemove`.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
