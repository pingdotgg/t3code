# Sandboxes

A sandbox is a new worktree that runs in its own Docker container. The agent, the thread's
terminals, and the project's setup script all run inside it. Each sandbox has its own ports,
services, and installed tools, so two threads can both run an app on port 3000, or use different
database data and migrations, at the same time.

The worktree's files stay on your machine. Diffs, checkpoints, source control, and your editor
work as they do for any worktree.

## Start a sandbox

Choose **New sandbox** where you would choose **New worktree** for a new thread. The first sandbox
builds an image, which takes a few minutes. Later sandboxes start in seconds. Agents can also start
one with `sandbox: true` in a worktree launch.

You need Docker on a Linux or macOS machine running T3 Code. Claude and Codex can run in a sandbox.
Other providers report an error in a sandboxed thread.

## What is inside

The image is Debian with Node 24, git, and the same Claude Code and Codex versions as your machine.
Your Claude and Codex settings and logins are shared with the sandbox, along with your git
identity. The agent can use `sudo` to install anything else, for example
`sudo apt-get install postgresql`. Services and data outside the worktree stay inside that sandbox.

On macOS, Claude keeps its login in the Keychain, which a container cannot read. Run
`claude setup-token` and add the token as `CLAUDE_CODE_OAUTH_TOKEN` to the Claude provider's
environment variables.

In a sandbox, Codex does not use its own command sandbox; the container is the boundary.
Approval prompts still follow the thread's permission mode.

## Previews

When an app listens on a port inside the sandbox, T3 Code forwards it to a port on your machine
and lists it in the preview panel as `sandbox :3000`. The forwarded port stays the same across
restarts when it is free.

## Stop or remove

A sandbox keeps running until you stop it. A stopped sandbox starts again the next time the agent
or a terminal needs it. Removing a sandbox deletes the container and everything in it outside the
worktree; later work in that worktree runs on your machine. Deleting the worktree removes its
sandbox.
