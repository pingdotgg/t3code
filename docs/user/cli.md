# CLI reference (`hyakki`)

The `hyakki` command runs and manages Hyakki servers, background services, remote access, threads, workflows, and diagnostics. Run `hyakki --help` or `hyakki <command> --help` for full flags.

See [Install Hyakki](./install.md#command-line) for installation (`curl -fsSL https://raw.githubusercontent.com/Ryoku-dev/hyakki/main/scripts/install.sh | sh`, `irm https://raw.githubusercontent.com/Ryoku-dev/hyakki/main/scripts/install.ps1 | iex`).

## Running and connecting

| Command                          | Description                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `hyakki [path]` / `hyakki start` | Start a foreground server and open the web app (optionally in a project directory).                          |
| `hyakki serve`                   | Start the server without opening a browser (`--lan`, `--tailscale-serve`, `--host`, `--port`, `--base-dir`). |
| `hyakki app [path]`              | Open a directory as a project/thread in the running desktop app.                                             |
| `hyakki up`                      | Interactive setup for LAN remote access plus the background service (`--lan`, `--no-lan`, `--yes`).          |
| `hyakki status`                  | Show how other devices can reach this host (`--json`).                                                       |
| `hyakki pair`                    | Generate a one-time pairing URL / QR code (`--tailscale`, `--scope <scope>`).                                |

## Background service and updates

| Command                               | Description                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hyakki service`                      | Manage the background service (`install`, `status`, `restart`, `uninstall`, `protect [--undo]`). See [Background service](./background-service.md). |
| `hyakki update [version]`             | Update `hyakki` and the service (`--channel nightly`, `--allow-downgrade`, `--yes`).                                                                |
| `hyakki install` / `hyakki uninstall` | Install or remove the `hyakki` launcher and background service (keeps `~/.hyakki/userdata`).                                                        |

## Threads, projects, and workflows

| Command           | Description                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hyakki thread`   | Script threads on the host (`start`, `send`, `show`, `list`; supports `--wait`, `--json`, `--worktree`, `--provider`, `--model`, `--option`). See [Host scripts](./outside-agents.md#host-scripts-hyakki-thread). |
| `hyakki project`  | Manage projects on the host (e.g. `hyakki project add <path> --track <folder>`).                                                                                                                                  |
| `hyakki workflow` | Start and steer durable workflows (`start`, `list`, `show`, `resume`, `cancel`, `questions`, `signal`, `withdraw`, `hooks`, `store`). See [Workflows](./workflows.md).                                            |

## Environments, auth, themes, and policy

| Command              | Description                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `hyakki environment` | Link or manage peer environments (`hyakki environment link <addr> --pairing-code <code> --access <mode>`, `--from <file>`).               |
| `hyakki auth`        | Manage pairing codes and sessions (`pairing create`, `session list/revoke/issue`).                                                        |
| `hyakki theme`       | Manage server-published themes (`set <id>`, `clear`, `show`). See [Appearance](./appearance.md#environment-themes).                       |
| `hyakki policy`      | Validate, inspect, and generate MDM/GPO templates for [managed policies](./managed-policy.md) (`check`, `show`, `settings`, `templates`). |

## Diagnostics and maintenance

| Command                | Description                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `hyakki doctor`        | Inspect database size and reclaim disk space (`--dry-run`, `--fix`).                                       |
| `hyakki browser setup` | One-time Linux host setup (AppArmor sandbox profile, libraries, fonts) for the headless preview browser.   |
| `hyakki trace summary` | Summarize local server trace latency and errors (`--since 30m`, `--limit 50`).                             |
| `hyakki triage`        | Launch Claude Code, Codex, or Antigravity in your terminal with the Hyakki triage playbook.                |
| `hyakki feedback`      | Send or inspect agent feedback reports (`list [--json]`, `--kind`, `--subject`, `--expected`, `--actual`). |
