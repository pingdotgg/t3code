# Devin

This guide is for people who want to use Devin in T3 Code. For other providers, see
[Codex](./providers-codex.md) or [Claude](./providers-claude.md). For first-time setup, see
[Install T3 Code](./install.md).

T3 Code talks to Devin through its ACP (Agent Client Protocol) interface. It needs a Devin CLI that
exposes `devin acp` on standard input/output.

## I Only Use One Devin Account

Use the default provider.

In T3 Code Settings, your Devin provider can stay like this:

```text
Display name: Devin
Binary path: devin
Profile path: empty
Config file: empty
Agent type: Default coding agent
Permission mode: Auto (read-only)
Process sandbox: off
Respect workspace trust: on
Launch arguments: empty
```

An empty `Home path` means T3 Code uses Devin's default home directory (`~/.devin` on macOS and
Linux, and the equivalent Windows user profile path). T3 Code sets this as `DEVIN_HOME` when it
spawns the Devin process.

## I Want Multiple Devin Accounts Or Presets

Use a different `Home path` for each provider instance. Each home keeps its own Devin sessions and
Usage transcripts, so T3 Code treats them as separate Devin environments.

Example:

```text
Display name: Devin Work
Binary path: devin
Home path: ~/.devin_work
```

```text
Display name: Devin Personal
Binary path: devin
Home path: ~/.devin_personal
```

T3 Code expands `~` in the `Home path`, resolves it to an absolute path, and sets
`DEVIN_HOME` before launching Devin. It does not create the directory; Devin CLI or the user
is responsible for ensuring it exists.

## Binary Path And The `devin-desktop` Fallback

`Binary path` is the command T3 Code runs to start Devin ACP. If you leave it empty, T3 Code tries
`devin` first and then falls back to `devin-desktop` automatically if `devin` is not on `PATH`.

Some installations expose the CLI as `devin-desktop` while still speaking ACP. T3 Code will use it
the same way, launching it as `devin-desktop acp` with the configured `Launch arguments`.

If your Devin binary is in a non-standard location, set the full path:

```text
Binary path: /opt/devin/bin/devin
```

## Launch Arguments

`Launch arguments` are extra arguments passed to the Devin CLI after the `acp` subcommand. They are
tokenized the same way as a shell command, so quoted arguments are supported.

Example:

```text
Launch arguments: --model opus
```

This produces a command like:

```text
devin acp --model opus
```

Normally, prefer T3 Code's model picker. `Launch arguments` remains available for ACP options added
by newer Devin releases before T3 Code has a dedicated control.

Do not put environment variable assignments in `Launch arguments`. Use the provider's
**Environment variables** section for those, and mark tokens or API keys as sensitive.

## Agent, Config, Sandbox, And Trust Controls

The provider settings expose every Devin CLI option that changes an ACP runtime:

- `Config file` maps to the top-level `--config` option.
- `Agent type` maps to `devin acp --agent-type`. Use separate provider instances when you want a
  persistent default, read-only review, or no-tools summarizer preset.
- `Process sandbox` maps to the top-level `--sandbox` option.
- `Respect workspace trust` maps to `--respect-workspace-trust`; it stays enabled by default.
- `Permission mode` maps to `DEVIN_PERMISSION_MODE`.
- T3 Code's model and reasoning pickers map to Devin's live ACP session config options.

These controls are arguments, not shell text, so paths containing spaces remain one value.

## Permission Mode

T3 Code defaults to Devin's `normal` permission mode. The other selectable modes match the installed
Devin CLI: `accept-edits`, `autonomous`, `smart`, and `dangerous`.
Each mode grants progressively broader automatic approval; use `dangerous` only in an environment
where unrestricted tool execution is intended.

## Authentication

Devin's CLI authentication is handled by Devin itself, not by T3 Code. Run the login command that the
Devin CLI documentation recommends before you start a session, then confirm the provider status in
T3 Code Settings. T3 Code reuses that
saved CLI login across new chats; it does not open browser verification merely because Devin ACP
advertises an authentication method. If the first prompt actually reports that the saved login is
missing or expired, T3 Code invokes Devin's advertised browser authentication once and retries that
prompt once. Unrelated prompt failures never trigger login.

If Devin uses an API key or base URL that needs to be per-provider, add those variables to the
provider's **Environment variables** section and mark the values as sensitive. T3 Code stores
sensitive values as server secrets and does not send them back to the app after saving.

## CLI Functionality In T3 Code

T3 Code discovers Devin's ACP commands from each live session instead of freezing a version-specific
list. Commands such as `/compact`, `/context`, `/mcp`, `/plan`, `/status`, `/workspace`, and
project-local skills appear in the composer command menu when the installed CLI advertises them.
T3 Code keeps its native `/model` entry so model and reasoning changes use the structured picker
rather than a duplicate text command.

Every other top-level CLI function has a native T3 equivalent or remains available without leaving
T3 Code through the integrated terminal:

| Devin CLI function                                          | T3 Code path                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Prompt, `--print`, `--model`, `--permission-mode`           | Composer and provider/model controls                                                                             |
| `--continue`, `--resume`, `list`                            | Persisted T3 threads and sidebar                                                                                 |
| `--config`, `--sandbox`, `--respect-workspace-trust`        | Provider settings                                                                                                |
| `--prompt-file`, `--export`                                 | Integrated terminal when the exact Devin file format is required; normal prompts and history stay in T3 threads  |
| ACP slash commands and skills                               | Composer `/` menu, discovered per session                                                                        |
| `models`; `rules list/show/paths`; `skills list/show/paths` | Model picker and live skill commands; full inspection commands in the integrated terminal                        |
| `auth`; `mcp`; `plugins`; `cloud`                           | Live `/login`, `/logout`, `/status`, and `/mcp` where advertised; full administration in the integrated terminal |
| `version`, `update`                                         | Provider status and one-click `devin update`                                                                     |
| `migrate`, `sandbox`, `setup`, `uninstall`                  | Integrated terminal so Devin owns every interactive prompt and destructive confirmation                          |
| `acp`                                                       | Managed automatically by the provider; advanced flags can be added under `Launch arguments`                      |

Administrative commands stay terminal-based because several are interactive or destructive. This
keeps their complete CLI prompts and confirmation gates instead of replacing them with partial UI
wrappers. With the default provider profile, the integrated terminal and provider inherit the same
Devin state. If a provider uses an isolated `Profile path`, set `DEVIN_HOME` to that path and set
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` to its `config`, `data`, and `cache`
subdirectories in the terminal command so it targets the same isolated profile.

## Token Usage And Cost

Devin token usage is reported in real time during a conversation and aggregated in **Usage**.

- Real-time usage appears from Devin's ACP prompt responses.
- Aggregated usage is written to `<home path>/t3code-usage.jsonl` and scanned by the Usage page.
- Cost is estimated from LiteLLM rate data when Devin does not report a cost itself. Unpriced Devin
  models appear as `unpriced` rather than inventing a rate.

## Can I Switch Models In An Existing Thread?

Yes, when the Devin session advertises the requested model. T3 Code sends a `session/set_config_option`
ACP request for the model config option when the model picker changes. If Devin rejects the model,
the request fails with the provider error shown in the UI.

## Can I Switch Accounts In An Existing Thread?

No. Devin sessions are tied to the `Home path` they were created with. A different home is treated
as a different Devin environment, so existing threads cannot be moved to another Devin provider.
