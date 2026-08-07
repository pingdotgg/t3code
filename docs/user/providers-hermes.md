# Hermes

This guide covers the Hermes Agent provider in T3 Code. Hermes is Nous
Research's coding agent CLI; T3 Code talks to it through the Agent Client
Protocol (ACP) server that ships with the `hermes` command. See
[Install T3 Code](./install.md) for first-time setup.

## Install Hermes

On Linux, macOS, or WSL2, install the CLI with the official installer:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.bashrc   # or source ~/.zshrc
```

On Windows, run the installer script from PowerShell:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Verify the install:

```bash
hermes --version
```

The installer includes ACP support. If you installed Hermes another way and
`hermes acp` is missing, add the ACP extra from the install checkout:

```bash
cd ~/.hermes/hermes-agent
uv pip install -e ".[acp]"
```

Check that ACP is ready:

```bash
hermes acp --check
```

## Log In

Hermes keeps your provider credentials in `~/.hermes/.env` and your settings
in `~/.hermes/config.yaml`. Set up a provider and model:

```bash
hermes model
```

This is the interactive wizard for adding a provider, running OAuth flows,
and picking a default model. The easiest path is Nous Portal:

```bash
hermes setup --portal
```

which logs in, sets Nous as your provider, and enables the Tool Gateway.

To see your auth status later, run:

```bash
hermes auth status
hermes status
```

## Add Hermes In T3 Code

In Settings, add a Hermes provider:

```text
Display name: Hermes
Binary path: hermes
HERMES_HOME path: empty
Profile: empty
Launch arguments: empty
```

- `Binary path` — the `hermes` command. Use a full path if `hermes` is not on PATH.
- `HERMES_HOME path` — where Hermes keeps `config.yaml`, `.env`, and its
  state. Leave empty for the default `~/.hermes`.
- `Profile` — the Hermes profile to run sessions under. Leave empty for the
  default profile. See "Use Multiple Hermes Profiles" below.
- `Launch arguments` — extra CLI flags passed to `hermes acp` on session
  start, for example `--ignore-rules`.

## Use Multiple Hermes Profiles

Hermes has its own profile system: each profile is an isolated configuration
with its own `config.yaml`, credentials, and sessions. Create one with:

```bash
hermes profile create work
```

To configure a profile separately, run Hermes with the profile flag:

```bash
hermes --profile work model
```

In T3 Code, point a second Hermes provider at that profile:

```text
Display name: Hermes Work
Binary path: hermes
HERMES_HOME path: empty
Profile: work
```

T3 Code passes the profile to every `hermes acp` process it starts, so each
provider instance runs under its own Hermes identity and session history.

Alternatively, use a separate `HERMES_HOME path` per provider for fully
isolated setups:

```bash
mkdir -p ~/.hermes_work
HERMES_HOME=~/.hermes_work hermes model
```

## Models

When you refresh the Hermes provider, T3 Code starts a short ACP session and
reads `availableModels`. Hermes builds this list from the same configured
provider inventory that `hermes model`, its TUI, and its dashboard use. The
catalog check skips configured MCP servers.

The picker shows models from every authenticated Hermes provider. Hermes sends
each ID as `provider:model`, and T3 Code shows it as `provider/model`. For
example, `openrouter:deepseek/deepseek-v4-flash-0731` appears as
`openrouter/deepseek/deepseek-v4-flash-0731`.

If the ACP catalog check fails, T3 Code shows fallback models and Custom
models. Changing the model inside an existing thread works without starting a
new thread. Hermes applies the switch to the running session.

## What Works In T3 Code

- **Sessions** — start, resume (existing Hermes sessions continue), and stop.
- **Streaming** — Hermes streams text, thinking, plan, and tool activity as
  it runs.
- **Approvals** — dangerous terminal commands surface as approval prompts.
  T3 Code maps Allow to "allow once", Allow for session to "allow for this
  session", and Deny to "deny".
- **Model switching** — switch models in-session from the model picker.
- **Cancellation** — Stop interrupts the active turn.

## What Is Not Supported

- **Rollback** — Hermes ACP has no turn rollback. The Rollback action in
  T3 Code reverts the workspace to a checkpoint instead.
- **Free-text prompts from the agent** — if Hermes asks a structured
  question, T3 Code answers it; free-text input requests are not surfaced.
- **Messaging platforms** — Hermes gateway features (Telegram, Discord, and
  so on) run outside T3 Code.

## Troubleshooting

Check that ACP is healthy:

```bash
hermes acp --check
hermes doctor
hermes status
```

If a session fails to start with a model error, confirm the model exists
under your configured provider with `hermes model`, then refresh provider
status in T3 Code Settings.
