# Install T3 Code

T3 Code is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the T3 Code server.

At least one provider runtime, installed and authenticated. You can install Antigravity from
T3 Code settings. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the T3 Code server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Open a project in the desktop app

When the T3 Code desktop app is running on the same machine, open the current directory with:

```bash
npx t3 app
```

Pass a path to open another directory:

```bash
npx t3 app ../my-project
```

The command adds the directory as a project when needed, focuses the desktop app, and opens a new
thread. It does not launch the desktop app, open a browser, or start a T3 Code server. A background
server does not count as the desktop app. The command also rejects SSH sessions because a remote
shell cannot focus a local desktop window. The CLI package and the running desktop app must both
include `t3 app` support.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

### Windows Subsystem for Linux

When the desktop app runs a WSL backend, it installs the matching server runtime into
`~/.t3/wsl-runtime` inside the selected distro. The first launch after installing or updating T3
Code may take a little longer while that release's runtime is extracted. Later launches reuse the
Linux-local copy so startup does not depend on reading application files through `/mnt/c`. After a
successful launch, T3 Code keeps the current runtime and one previous runtime for rollback and
removes older caches automatically. If a cached runtime stops working, T3 Code launches from the
application files under `/mnt/c` instead and reinstalls the runtime on the next launch.

## Providers

T3 Code uses provider runtimes but does not bundle them. Install and authenticate each
provider's CLI, or use T3 Code's managed setup for Antigravity.

| Provider    | CLI                                                                                                        | Default binary     | Log in with                        |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------- |
| Codex       | [Codex CLI](https://developers.openai.com/codex/cli)                                                       | `codex`            | `codex login`                      |
| Claude      | [Claude Code](https://claude.com/product/claude-code)                                                      | `claude`           | `claude auth login`                |
| Cursor      | [Cursor CLI](https://cursor.com/cli)                                                                       | `cursor-agent`     | `agent login`                      |
| Grok Build  | [Grok Build CLI](https://x.ai/cli)                                                                         | `grok`             | `grok login`                       |
| OpenCode    | [OpenCode](https://opencode.ai)                                                                            | `opencode`         | `opencode auth login`              |
| Antigravity | [Official ACP agent](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) | Managed by T3 Code | **Sign in with Google** in T3 Code |

Codex and Claude are on by default. Cursor, Grok Build, OpenCode, and Antigravity are off by
default. Turn them on in **Settings** > **Providers** when you want to use them.

For Antigravity, select the environment in provider settings, then install and sign in there.
The runtime and credentials stay on that environment, even when you use a phone or remote
browser. See [Antigravity setup](./providers-antigravity.md) for Google sign-in, remote callback
steps, and supported hosts.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
T3 Code looks for, but authenticate with `agent login`, not `cursor-agent login`.

Grok models that support adjustable reasoning show a **Reasoning** control beside the model picker.
The available levels and default come from the installed Grok Build CLI, so they can vary by model
and CLI version.

Run CLI login commands on the machine running the T3 Code server, not on the device you browse
from. Antigravity uses its sign-in controls in T3 Code instead of a CLI login command.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started T3 Code.

Antigravity can use its managed runtime without a `PATH` entry. Its optional **Binary path**
overrides the managed runtime and must point to the official ACP executable.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
T3 Code. You can install T3 Code, open it, and add providers afterwards. A provider that is not
authenticated shows its status and setup instructions in **Settings**.

For multi-account setups, see [Codex](./providers-codex.md), [Claude](./providers-claude.md), and
[Antigravity](./providers-antigravity.md#accounts-and-removal).

## Next Steps

- [Permission modes](./permission-modes.md): how much T3 Code asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping T3 Code in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
