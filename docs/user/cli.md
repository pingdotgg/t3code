# CLI reference (`t3`)

The `t3` command runs and manages T3 Code servers, background services, remote access, threads, workflows, and diagnostics. Run `t3 --help` or `t3 <command> --help` for full flags.

See [Install T3 Code](./install.md#command-line) for installation (`curl -fsSL https://t3.codes/install.sh | sh`, `irm https://t3.codes/install.ps1 | iex`, or `npx t3@latest`).

## Running and connecting

| Command                  | Description                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `t3 [path]` / `t3 start` | Start a foreground server and open the web app (optionally in a project directory).                                              |
| `t3 serve`               | Start the server without opening a browser (`--lan`, `--tailscale-serve`, `--host`, `--port`, `--base-dir`).                     |
| `t3 app [path]`          | Open a directory as a project/thread in the running desktop app.                                                                 |
| `t3 up`                  | Interactive setup for remote access (T3 Connect and/or LAN) plus background service (`--connect`, `--lan`, `--no-lan`, `--yes`). |
| `t3 connect`             | Manage T3 Connect (`t3 connect`, `status`, `login`, `logout`, `link`, `unlink`).                                                 |
| `t3 status`              | Show how other devices can reach this host (`--json`).                                                                           |
| `t3 pair`                | Generate a one-time pairing URL / QR code (`--tailscale`, `--scope <scope>`).                                                    |

## Background service and updates

| Command                       | Description                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3 service`                  | Manage the background service (`install`, `status`, `restart`, `uninstall`, `protect [--undo]`). See [Background service](./background-service.md). |
| `t3 update [version]`         | Update `t3` and the service (`--channel nightly`, `--allow-downgrade`, `--yes`).                                                                    |
| `t3 install` / `t3 uninstall` | Install or remove the `t3` launcher and background service (keeps `~/.t3/userdata`).                                                                |

## Threads, projects, and workflows

| Command       | Description                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3 thread`   | Script threads on the host (`start`, `send`, `show`, `list`; supports `--wait`, `--json`, `--worktree`, `--provider`, `--model`, `--option`). See [Host scripts](./outside-agents.md#host-scripts-t3-thread). |
| `t3 project`  | Manage projects on the host (e.g. `t3 project add <path> --track <folder>`).                                                                                                                                  |
| `t3 workflow` | Start and steer durable workflows (`start`, `list`, `show`, `resume`, `cancel`, `questions`, `signal`, `withdraw`, `hooks`, `store`). See [Workflows](./workflows.md).                                        |

## Environments, auth, themes, and policy

| Command          | Description                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `t3 environment` | Link or manage peer environments (`t3 environment link <addr> --pairing-code <code> --access <mode>`, `--from <file>`).                                |
| `t3 auth`        | Manage pairing codes, sessions, and T3 Connect device approvals (`pairing create`, `session list/revoke/issue`, `connect-device list/approve/revoke`). |
| `t3 theme`       | Manage server-published themes (`set <id>`, `clear`, `show`). See [Appearance](./appearance.md#environment-themes).                                    |
| `t3 policy`      | Validate, inspect, and generate MDM/GPO templates for [managed policies](./managed-policy.md) (`check`, `show`, `settings`, `templates`).              |

## Diagnostics and maintenance

| Command            | Description                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `t3 doctor`        | Inspect database size and reclaim disk space (`--dry-run`, `--fix`).                                       |
| `t3 browser setup` | One-time Linux host setup (AppArmor sandbox profile, libraries, fonts) for the headless preview browser.   |
| `t3 trace summary` | Summarize local server trace latency and errors (`--since 30m`, `--limit 50`).                             |
| `t3 triage`        | Launch Claude Code, Codex, or Antigravity in your terminal with the T3 triage playbook.                    |
| `t3 feedback`      | Send or inspect agent feedback reports (`list [--json]`, `--kind`, `--subject`, `--expected`, `--actual`). |
