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

# Start a thread in another project

An agent can start an ordinary top-level conversation in any project registered in the same T3
Code environment. It can use the project root, an existing worktree, or ask T3 Code to create a new
worktree. If it selects another project without choosing a workspace, T3 Code uses that project's
root and does not reuse the calling thread's checkout.

Choosing an existing worktree does not switch its branch. T3 Code verifies that the path is a real
worktree root of the selected project's repository, resolves symlinks to the canonical checkout,
and rejects a requested branch when the checkout is currently on a different branch. Projects
whose configured root is a folder inside a repository continue to launch from that folder.

The new thread keeps the calling agent's provider, model, runtime mode, and interaction mode unless
the request supplies a narrower supported override. Selecting a project does not grant broader
permissions. Agents can also list, read, message, wait for, and interrupt threads in that selected
project; leaving the project unspecified keeps the current project as the default.
