# Project settings

Open **Settings → Projects** and select a project to change its preferences.

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

## Let an agent manage projects

Agents running through T3 Code can list and inspect projects in their current environment. They can
also register an existing directory, create a missing directory, clone and register a repository,
or update the same project settings available in the app.

Removing a project does not remove its directory, repository, worktrees, or other workspace files.
If the project still has threads, the agent must explicitly request that T3 Code delete those thread
records first. This prevents a project removal from silently discarding conversations.
